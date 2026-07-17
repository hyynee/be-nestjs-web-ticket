import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  PaymentGatewayService,
  paypalSdk,
} from "@src/payment/infrastructure/gateway/payment-gateway.service";
import { PaymentIdempotencyService } from "@src/payment/infrastructure/idempotency/payment-idempotency.service";
import { PaymentPresenter } from "@src/payment/presenters/payment.presenter";
import { PaymentConfirmationDeliveryService } from "@src/payment/application/services/payment-confirmation-delivery.service";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import { toPaymentObjectId } from "@src/payment/domain/utils/payment-document.utils";
import type {
  BookingForConfirmationMail,
  CreatedTicketForMail,
  PaymentRecord,
  PaypalCapture,
  PaypalFinalizeResult,
  PaypalOrderCaptureResponse,
} from "@src/payment/types/payment.types";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Zone } from "@src/schemas/zone.schema";
import { TicketService } from "@src/ticket/ticket.service";
import { Model, Types } from "mongoose";

@Injectable()
export class PaypalPaymentSettlementService {
  private readonly logger = new Logger(PaypalPaymentSettlementService.name);

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly ticketService: TicketService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentIdempotencyService: PaymentIdempotencyService,
    private readonly paymentPresenter: PaymentPresenter,
    private readonly deliveryService: PaymentConfirmationDeliveryService
  ) {}

  async finalizePaypalTransaction(
    orderId: string,
    userId: string
  ): Promise<PaypalFinalizeResult> {
    const lockStatus =
      await this.paymentIdempotencyService.acquirePaypalLock(orderId);

    if (lockStatus === "processing") {
      throw new ConflictException(
        "Payment is currently being processed. Please wait and try again."
      );
    }
    let markedSucceeded = lockStatus === "succeeded";
    let captureSucceeded = false;

    try {
      const payment = await this.paymentModel
        .findOne({
          paypalOrderId: orderId,
          userId: new Types.ObjectId(userId),
          isDeleted: false,
        })
        .select("_id bookingId status currency metadata")
        .lean<PaymentRecord>()
        .exec();

      if (!payment) {
        throw new BadRequestException(
          "Payment record not found or unauthorized"
        );
      }

      const booking = await this.bookingModel
        .findById(payment.bookingId)
        .select("bookingCode status paymentStatus isDeleted")
        .lean<{
          bookingCode: string;
          status: BookingStatus;
          paymentStatus: PaymentStatus;
          isDeleted?: boolean;
        }>()
        .exec();

      if (!booking || booking.isDeleted) {
        throw new BadRequestException("Associated booking not found");
      }

      if (
        booking.status === BookingStatus.CANCELLED ||
        booking.status === BookingStatus.EXPIRED
      ) {
        throw new BadRequestException(
          "Booking has been cancelled or expired and cannot be finalized"
        );
      }

      if (markedSucceeded || payment.status === "succeeded") {
        await this.issueTicketsForAlreadyFinalizedBooking(booking);
        return this.paymentPresenter.paypalFinalizeResult(
          "Payment already finalized"
        );
      }

      const captureRequest = new paypalSdk.orders.OrdersCaptureRequest(orderId);
      captureRequest.requestBody({});

      let capture: PaypalOrderCaptureResponse;
      try {
        const response = await this.paymentGateway.withPaypalTimeout(
          this.paymentGateway.paypalClient.execute<PaypalOrderCaptureResponse>(
            captureRequest
          )
        );
        capture = response.result;
        captureSucceeded = true;
      } catch (captureError) {
        const recovered = await this.recoverAlreadyCapturedPaypalOrder(
          captureError,
          payment,
          orderId
        );
        if (recovered) {
          markedSucceeded = true;
          return recovered;
        }

        this.logger.error(
          `PayPal capture failed for order ${orderId}: ${getPaymentErrorMessage(captureError)}`
        );
        throw new BadRequestException(
          `Failed to capture payment: ${getPaymentErrorMessage(captureError)}`
        );
      }

      if (capture.status !== "COMPLETED") {
        throw new BadRequestException(
          `Capture failed with status: ${capture.status}`
        );
      }

      const captureDetail = capture.purchase_units[0].payments.captures[0];
      await this.writePaypalPendingConfirmation(
        payment._id,
        orderId,
        captureDetail.id
      );

      try {
        await this.processPaypalPayment(payment, capture, captureDetail);
      } catch (processError) {
        this.logger.error(
          `[MONEY_RISK] PayPal capture SUCCEEDED for orderId=${orderId} (captureId=${captureDetail.id}) ` +
            `but DB write FAILED. PendingConfirmation record written. Lock held — reconciliation required. ` +
            `Error: ${getPaymentErrorMessage(processError)}`
        );
        throw processError;
      }

      await this.paymentIdempotencyService.markPaypalSucceeded(orderId);
      markedSucceeded = true;
      return this.paymentPresenter.paypalFinalizeResult(
        "PayPal payment completed",
        captureDetail.id
      );
    } finally {
      if (!markedSucceeded) {
        if (captureSucceeded) {
          this.logger.error(
            `[PAY-002] PayPal lock for orderId=${orderId} intentionally kept as "processing" — capture succeeded, DB write failed. Manual or automated reconciliation required.`
          );
        } else {
          await this.paymentIdempotencyService
            .releasePaypalLock(orderId)
            .catch((error: unknown) => {
              this.logger.warn(
                `Failed to release PayPal lock for order ${orderId}: ${getPaymentErrorMessage(error)}`
              );
            });
        }
      }
    }
  }

  private async processPaypalPayment(
    payment: PaymentRecord,
    order: PaypalOrderCaptureResponse,
    captureOrAuth: PaypalCapture
  ): Promise<void> {
    const dbSession = await this.bookingModel.db.startSession();
    let bookingForMail: BookingForConfirmationMail | null = null;
    let tickets: CreatedTicketForMail[] = [];
    let shouldSendConfirmation = false;
    let ticketOwnerUserId: string | undefined;
    let changedZoneId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const updatedBooking = await this.bookingModel
          .findOneAndUpdate(
            {
              _id: payment.bookingId,
              status: BookingStatus.PENDING,
              paymentStatus: PaymentStatus.UNPAID,
              isDeleted: false,
            },
            {
              status: BookingStatus.CONFIRMED,
              paymentStatus: PaymentStatus.PAID,
              paidAt: new Date(),
            },
            {
              new: true,
              select:
                "zoneId quantity bookingCode areaId eventId seats customerEmail customerName totalPrice userId snapshot",
              session: dbSession,
            }
          )
          .populate<{ eventId: BookingForConfirmationMail["eventId"] }>(
            "eventId",
            "title location startDate endDate"
          )
          .populate<{ zoneId: BookingForConfirmationMail["zoneId"] }>(
            "zoneId",
            "name"
          )
          .populate("areaId", "name");

        if (!updatedBooking) {
          await this.autoRefundCapturedPaypalPayment(payment, captureOrAuth);
          return;
        }

        shouldSendConfirmation = true;

        if (updatedBooking.quantity > 0) {
          await this.zoneModel.findByIdAndUpdate(
            updatedBooking.zoneId,
            [
              {
                $set: {
                  confirmedSoldCount: {
                    $min: [
                      {
                        $add: ["$confirmedSoldCount", updatedBooking.quantity],
                      },
                      "$capacity",
                    ],
                  },
                },
              },
            ],
            { session: dbSession }
          );
          changedZoneId = toPaymentObjectId(updatedBooking.zoneId, "zoneId");
        }

        await this.paymentModel.findByIdAndUpdate(
          payment._id,
          {
            status: "succeeded",
            paidAt: new Date(),
            paypalCaptureId: captureOrAuth.id,
            metadata: {
              ...(payment.metadata ?? {}),
              orderId: order.id,
              orderStatus: order.status,
              authorizationId: captureOrAuth.id,
              captureStatus: captureOrAuth.status,
              capturedAt: new Date().toISOString(),
            },
          },
          { session: dbSession }
        );

        tickets = await this.ticketService.createTicketsFromBooking(
          updatedBooking.bookingCode,
          dbSession
        );
        bookingForMail =
          this.deliveryService.toBookingConfirmationMail(updatedBooking);
        ticketOwnerUserId = updatedBooking.userId?.toString();
      });
    } catch (error) {
      const paymentId = payment?._id.toString() ?? "unknown";
      this.logger.error(
        `PayPal finalize failed for payment ${paymentId}: ${getPaymentErrorMessage(error)}`
      );
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!bookingForMail || tickets.length === 0) {
      return;
    }

    const confirmedBooking = bookingForMail as BookingForConfirmationMail;
    const bookingCodeForPublish = confirmedBooking.bookingCode;

    await this.deliveryService.publishTicketCreation(
      confirmedBooking,
      bookingCodeForPublish,
      tickets,
      ticketOwnerUserId,
      "PayPal payment confirmed"
    );

    if (changedZoneId) {
      await this.deliveryService.emitZoneTicketUpdateSafely(
        changedZoneId,
        `paypal, booking=${bookingCodeForPublish}`
      );
    }

    if (!shouldSendConfirmation) {
      return;
    }

    const confirmationPayload =
      this.deliveryService.buildBookingConfirmationPayload(
        confirmedBooking,
        payment.currency,
        confirmedBooking.totalPrice
      );

    tickets = await this.deliveryService.finalizeTicketsForDelivery(
      bookingCodeForPublish,
      tickets,
      confirmationPayload
    );

    await this.deliveryService.enqueueConfirmationSafely(
      confirmedBooking.bookingCode,
      "PayPal",
      confirmationPayload,
      tickets,
      {
        userId: confirmedBooking.userId?.toString() ?? "",
        eventId: confirmedBooking.eventId._id?.toString(),
      }
    );

    await this.deliveryService.invalidateHotEventsCache(
      `paypal, booking=${bookingCodeForPublish}`
    );
  }

  private async recoverAlreadyCapturedPaypalOrder(
    captureError: unknown,
    payment: PaymentRecord,
    orderId: string
  ): Promise<PaypalFinalizeResult | null> {
    if (!this.paymentGateway.isPaypalAlreadyCapturedError(captureError)) {
      return null;
    }

    const refreshed = await this.paymentModel
      .findById(payment._id)
      .select("status")
      .lean<{ status: string }>()
      .exec();
    if (refreshed?.status === "succeeded") {
      await this.paymentIdempotencyService.markPaypalSucceeded(orderId);
      return this.paymentPresenter.paypalFinalizeResult(
        "Payment already finalized"
      );
    }

    this.logger.warn(
      `[PAYPAL_RECOVERY] ORDER_ALREADY_CAPTURED for orderId=${orderId} but payment.status=${refreshed?.status ?? "unknown"}. Attempting recovery.`
    );
    try {
      const getOrderRequest = new paypalSdk.orders.OrdersGetRequest(orderId);
      const orderResponse = await this.paymentGateway.withPaypalTimeout(
        this.paymentGateway.paypalClient.execute<PaypalOrderCaptureResponse>(
          getOrderRequest
        )
      );
      const completedOrder = orderResponse.result;
      if (completedOrder.status === "COMPLETED") {
        const captureDetail =
          completedOrder.purchase_units[0]?.payments?.captures?.[0];
        if (captureDetail) {
          await this.processPaypalPayment(
            payment,
            completedOrder,
            captureDetail
          );
          await this.paymentIdempotencyService.markPaypalSucceeded(orderId);
          this.logger.log(
            `[PAYPAL_RECOVERY] Successfully recovered orderId=${orderId}`
          );
          return this.paymentPresenter.paypalFinalizeResult(
            "Payment finalized after recovery"
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `[MONEY_RISK] PayPal recovery failed for orderId=${orderId}. MANUAL REVIEW REQUIRED. Error: ${getPaymentErrorMessage(error)}`
      );
    }

    return null;
  }

  private async issueTicketsForAlreadyFinalizedBooking(booking: {
    bookingCode: string;
    status: BookingStatus;
    paymentStatus: PaymentStatus;
  }): Promise<void> {
    if (
      booking.status !== BookingStatus.CONFIRMED ||
      booking.paymentStatus !== PaymentStatus.PAID
    ) {
      throw new BadRequestException(
        "Booking is not eligible for ticket issuance"
      );
    }
    const idemSession = await this.bookingModel.db.startSession();
    try {
      await idemSession.withTransaction(async () => {
        await this.ticketService.createTicketsFromBooking(
          booking.bookingCode,
          idemSession
        );
      });
    } finally {
      await idemSession.endSession();
    }
  }

  private async writePaypalPendingConfirmation(
    paymentId: Types.ObjectId,
    orderId: string,
    captureId: string
  ): Promise<void> {
    await this.paymentModel
      .findByIdAndUpdate(paymentId, {
        $set: {
          "metadata.captureStatus": "PendingConfirmation",
          "metadata.captureId": captureId,
          "metadata.capturedAt": new Date().toISOString(),
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `[PAY-003] Could not write PendingConfirmation for orderId=${orderId}: ${getPaymentErrorMessage(error)}`
        )
      );
  }

  private async autoRefundCapturedPaypalPayment(
    payment: PaymentRecord,
    captureOrAuth: PaypalCapture
  ): Promise<never> {
    this.logger.error(
      `[MONEY_RISK] PayPal captured order but booking ${payment.bookingId?.toString()} is no longer PENDING/UNPAID. Initiating auto-refund.`,
      { alert: "MONEY_RISK" }
    );
    try {
      const refundRequest = new paypalSdk.payments.CapturesRefundRequest(
        captureOrAuth.id
      );
      refundRequest.requestBody({
        note_to_payer: "Booking no longer available",
      });
      await this.paymentGateway.withPaypalTimeout(
        this.paymentGateway.paypalClient.execute(refundRequest)
      );
      this.logger.warn(
        `[AUTO_REFUND] PayPal refund issued for captureId=${captureOrAuth.id}`
      );
    } catch (error) {
      this.logger.error(
        `[CRITICAL] PayPal auto-refund FAILED for captureId=${captureOrAuth.id}. MANUAL REFUND REQUIRED. Error: ${getPaymentErrorMessage(error)}`,
        { alert: "MONEY_RISK" }
      );
    }
    throw new BadRequestException(
      "Booking is no longer available. Payment was captured and refund has been initiated."
    );
  }
}

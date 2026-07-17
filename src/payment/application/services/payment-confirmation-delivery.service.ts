import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { HOT_EVENTS_CACHE_KEY } from "@src/payment/payment.constants";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import { toPaymentObjectId } from "@src/payment/domain/utils/payment-document.utils";
import type {
  BookingForConfirmationMail,
  BookingMailObjectIdReference,
  BookingMailSource,
  CreatedTicketForMail,
} from "@src/payment/types/payment.types";
import { Zone } from "@src/schemas/zone.schema";
import { QueueService } from "@src/queue/queue.service";
import { NotificationService } from "@src/notification/notification.service";
import { RedisService } from "@src/redis/redis.service";
import { TicketService } from "@src/ticket/ticket.service";
import { ZoneGateway } from "@src/zone/zone.gateway";
import type { BookingConfirmationData } from "@src/types/booking-modules";
import { Model, Types } from "mongoose";

@Injectable()
export class PaymentConfirmationDeliveryService {
  private readonly logger = new Logger(PaymentConfirmationDeliveryService.name);

  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly ticketService: TicketService,
    private readonly queueService: QueueService,
    private readonly notificationService: NotificationService,
    private readonly redisService: RedisService,
    private readonly zoneGateway: ZoneGateway
  ) {}

  toBookingConfirmationMail(
    booking: BookingMailSource
  ): BookingForConfirmationMail {
    const event = this.resolveEventForMail(booking);
    const zone = this.resolveZoneForMail(booking);

    return {
      bookingCode: booking.bookingCode,
      customerEmail: booking.customerEmail,
      customerName: booking.customerName,
      eventId: event,
      zoneId: zone,
      seats: booking.seats,
      quantity: booking.quantity,
      totalPrice: booking.totalPrice,
      userId: booking.userId,
      snapshot: booking.snapshot,
    };
  }

  buildBookingConfirmationPayload(
    booking: BookingForConfirmationMail,
    currency: string,
    totalPrice: number,
    customerEmail?: string | null,
    customerName?: string | null
  ): BookingConfirmationData {
    return {
      email: customerEmail || booking.customerEmail,
      customerName: customerName || booking.customerName || "Khách hàng",
      bookingCode: booking.bookingCode,
      eventTitle: booking.snapshot?.eventTitle ?? booking.eventId.title,
      eventLocation: booking.snapshot?.location ?? booking.eventId.location,
      eventDate: booking.snapshot?.eventStartDate ?? booking.eventId.startDate,
      zoneName: booking.snapshot?.zoneName ?? booking.zoneId.name,
      seats: booking.seats || [],
      quantity: booking.quantity,
      totalPrice,
      currency,
      tickets: [],
    };
  }

  async publishTicketCreation(
    confirmedBooking: BookingForConfirmationMail,
    bookingCodeForPublish: string,
    tickets: CreatedTicketForMail[],
    ticketOwnerUserId: string | undefined,
    source: string
  ): Promise<void> {
    try {
      const broadcastEventId = toPaymentObjectId(
        confirmedBooking.eventId as BookingMailObjectIdReference,
        "eventId"
      );
      const broadcastZoneId = toPaymentObjectId(
        confirmedBooking.zoneId as BookingMailObjectIdReference,
        "zoneId"
      );
      await this.ticketService.publishTicketCreation(
        bookingCodeForPublish,
        tickets.map((ticket) => ({
          ticketCode: ticket.ticketCode,
          eventId: broadcastEventId,
          zoneId: broadcastZoneId,
          seatNumber: ticket.seatNumber ?? null,
          price: ticket.price,
          status: ticket.status,
        })),
        ticketOwnerUserId
      );
    } catch (error) {
      this.logger.warn(
        `publishTicketCreation failed (${source}, booking=${bookingCodeForPublish}): ${getPaymentErrorMessage(error)}`
      );
    }
  }

  async finalizeTicketsForDelivery(
    bookingCode: string,
    fallbackTickets: CreatedTicketForMail[],
    payload: BookingConfirmationData
  ): Promise<CreatedTicketForMail[]> {
    try {
      return await this.ticketService.generateMissingQRCodesForBooking(
        bookingCode
      );
    } catch (error) {
      this.logger.error(
        `Ticket QR finalization failed for booking ${bookingCode}: ${getPaymentErrorMessage(error)}`
      );
      await this.queueService.addJob({
        type: "finalize-ticket-delivery",
        payload,
      });
      return fallbackTickets;
    }
  }

  async enqueueConfirmationSafely(
    bookingCode: string,
    providerLabel: "Stripe" | "PayPal",
    confirmationPayload: BookingConfirmationData,
    tickets: CreatedTicketForMail[],
    notificationContext: {
      userId: string;
      bookingId?: string;
      eventId?: string;
    }
  ): Promise<void> {
    const ticketMailData = tickets.map((ticket) => ({
      ticketCode: ticket.ticketCode,
      seatNumber: ticket.seatNumber,
      qrCode: ticket.qrCode || "",
    }));

    try {
      await this.notificationService.notifyPaymentSucceeded({
        userId: notificationContext.userId,
        bookingId: notificationContext.bookingId,
        bookingCode,
        eventId: notificationContext.eventId,
        provider: providerLabel.toLowerCase(),
      });
      await this.notificationService.notifyTicketsIssued({
        userId: notificationContext.userId,
        bookingId: notificationContext.bookingId,
        bookingCode,
        eventId: notificationContext.eventId,
      });
      await this.notificationService.queueBookingConfirmationEmail(
        {
          ...confirmationPayload,
          tickets: ticketMailData,
        },
        notificationContext.userId
      );
    } catch (error) {
      this.logger.warn(
        `Failed to send ${providerLabel} confirmation email for booking ${bookingCode}: ${getPaymentErrorMessage(error)}`
      );
    }
  }

  async emitZoneTicketUpdate(zoneId: Types.ObjectId | string): Promise<void> {
    const zone = await this.zoneModel
      .findById(zoneId)
      .select("_id eventId capacity soldCount confirmedSoldCount")
      .lean();

    if (!zone) {
      return;
    }

    this.zoneGateway.emitZoneTicketUpdate({
      zoneId: zone._id,
      eventId: zone.eventId,
      capacity: zone.capacity,
      soldCount: zone.soldCount,
      confirmedSoldCount: zone.confirmedSoldCount || 0,
      availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
    });
  }

  async emitZoneTicketUpdateSafely(
    zoneId: Types.ObjectId | string,
    context: string
  ): Promise<void> {
    try {
      await this.emitZoneTicketUpdate(zoneId);
    } catch (error) {
      this.logger.warn(
        `emitZoneTicketUpdate failed (${context}): ${getPaymentErrorMessage(error)}`
      );
    }
  }

  async invalidateHotEventsCache(context: string): Promise<void> {
    try {
      await this.redisService.client.del(HOT_EVENTS_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        `hot-events cache invalidation failed (${context}): ${getPaymentErrorMessage(error)}`
      );
    }
  }

  private resolveEventForMail(
    booking: BookingMailSource
  ): BookingForConfirmationMail["eventId"] {
    if (booking.snapshot) {
      const eventId = this.resolveMailReferenceId(booking.eventId);
      return {
        ...(eventId ? { _id: eventId } : {}),
        title: booking.snapshot.eventTitle,
        location: booking.snapshot.location,
        startDate: booking.snapshot.eventStartDate,
      };
    }

    if (
      booking.eventId &&
      typeof booking.eventId === "object" &&
      !(booking.eventId instanceof Types.ObjectId)
    ) {
      return booking.eventId;
    }

    return {
      title: "",
      location: "",
      startDate: new Date(0),
    };
  }

  private resolveZoneForMail(
    booking: BookingMailSource
  ): BookingForConfirmationMail["zoneId"] {
    if (booking.snapshot) {
      const zoneId = this.resolveMailReferenceId(booking.zoneId);
      return {
        ...(zoneId ? { _id: zoneId } : {}),
        name: booking.snapshot.zoneName,
      };
    }

    if (
      booking.zoneId &&
      typeof booking.zoneId === "object" &&
      !(booking.zoneId instanceof Types.ObjectId)
    ) {
      return booking.zoneId;
    }

    return { name: "" };
  }

  private resolveMailReferenceId(
    value: BookingMailObjectIdReference | null | undefined
  ): Types.ObjectId | string | undefined {
    if (!value) {
      return undefined;
    }

    if (value instanceof Types.ObjectId || typeof value === "string") {
      return value;
    }

    return value._id;
  }
}

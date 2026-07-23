import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";
import { RefundRequestStatus } from "@src/schemas/refund-request.schema";
import {
  RefundableBooking,
  RefundRequestDocument,
} from "../domain/types/refund-domain.types";
import { ReviewRefundRequestUseCase } from "./review-refund-request.use-case";

const reviewer: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};

function makeRequest(
  overrides: Partial<RefundRequestDocument> = {}
): RefundRequestDocument {
  return {
    _id: new Types.ObjectId(),
    bookingId: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    amount: 100000,
    reason: "changed my mind",
    status: RefundRequestStatus.REQUESTED,
    isDeleted: false,
    metadata: { bookingCode: "BK1" },
    ...overrides,
  } as RefundRequestDocument;
}

function makeBooking(
  overrides: Partial<RefundableBooking> = {}
): RefundableBooking {
  return {
    _id: new Types.ObjectId(),
    bookingCode: "BK1",
    userId: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    zoneId: new Types.ObjectId(),
    quantity: 2,
    totalPrice: 100000,
    totalRefunded: 0,
    status: BookingStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    stripePaymentIntentId: "pi_123",
    ...overrides,
  };
}

describe("ReviewRefundRequestUseCase", () => {
  function makeUseCase(opts: {
    request?: RefundRequestDocument;
    booking?: RefundableBooking;
    refundResult?: {
      provider: "stripe" | "paypal";
      status: "succeeded" | "failed";
      providerRefundId?: string;
      errorMessage?: string;
    };
    moveToProcessingModifiedCount?: number;
  }) {
    const request = opts.request ?? makeRequest();
    const booking = opts.booking ?? makeBooking({ _id: request.bookingId });
    const refundResult = opts.refundResult ?? {
      provider: "stripe" as const,
      status: "succeeded" as const,
      providerRefundId: "re_123",
    };

    const session = {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
    };

    // finalizeRefundedBooking's fresh in-transaction lookup — defaults to
    // mirroring the happy-path booking (CONFIRMED, no prior refundHistory).
    // Individual tests override `bookingFindOneChain.lean` to simulate the
    // booking having left CONFIRMED for another reason, or already having a
    // refundHistory entry tagged with this exact refund request.
    const bookingModelUpdated: Record<string, unknown> = {
      status: booking.status,
      zoneId: booking.zoneId,
      quantity: booking.quantity,
      totalPrice: booking.totalPrice,
      totalRefunded: booking.totalRefunded,
      refundHistory: [],
    };
    const bookingFindOneChain = {
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(bookingModelUpdated),
    };
    const bookingModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findOne: jest.fn().mockReturnValue(bookingFindOneChain),
    };
    const ticketModel = { updateMany: jest.fn().mockResolvedValue({}) };
    const zoneModel = { updateOne: jest.fn().mockResolvedValue({}) };

    const succeededRow = {
      ...request,
      status: RefundRequestStatus.SUCCEEDED,
      provider: refundResult.provider,
      providerRefundId: refundResult.providerRefundId,
    };
    const failedRow = {
      ...request,
      status: RefundRequestStatus.FAILED,
      provider: refundResult.provider,
      failureReason: refundResult.errorMessage ?? "Refund provider failed",
    };
    const rejectedRow = {
      ...request,
      status: RefundRequestStatus.REJECTED,
      failureReason: "Refund rejected",
    };

    const repository = {
      loadRequestById: jest.fn().mockResolvedValue(request),
      loadBookingById: jest.fn().mockResolvedValue(booking),
      updateRequestStatus: jest.fn().mockResolvedValue({
        modifiedCount: opts.moveToProcessingModifiedCount ?? 1,
      }),
      updateRequestById: jest
        .fn()
        .mockResolvedValue(
          refundResult.status === "succeeded" ? succeededRow : failedRow
        ),
      conditionalUpdateRequest: jest.fn().mockResolvedValue(rejectedRow),
    };
    const policy = {
      assertCanReview: jest.fn().mockResolvedValue(undefined),
      assertBookingRefundableForReview: jest.fn(),
    };
    const presenter = {
      toDetail: jest.fn((row: unknown) => ({
        ...(row as object),
        presented: true,
      })),
    };
    const paymentService = {
      issueAdminRefund: jest.fn().mockResolvedValue(refundResult),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const notificationService = {
      notifyRefundReviewed: jest.fn().mockResolvedValue(undefined),
      notifyRefundFailed: jest.fn().mockResolvedValue(undefined),
    };
    const metricsService = {
      refundFailuresTotal: { inc: jest.fn() },
    };
    const zoneService = {
      invalidateZoneAvailabilityCache: jest.fn().mockResolvedValue(undefined),
    };
    const queueService = {
      addJob: jest.fn().mockResolvedValue(undefined),
    };
    const promotionService = {
      releaseUsageForBooking: jest.fn().mockResolvedValue(undefined),
    };

    const useCase = new ReviewRefundRequestUseCase(
      connection as never,
      bookingModel as never,
      ticketModel as never,
      zoneModel as never,
      repository as never,
      policy as never,
      presenter as never,
      paymentService as never,
      auditService as never,
      notificationService as never,
      metricsService as never,
      zoneService as never,
      queueService as never,
      promotionService as never
    );

    return {
      useCase,
      connection,
      session,
      bookingModel,
      bookingFindOneChain,
      ticketModel,
      zoneModel,
      repository,
      policy,
      presenter,
      paymentService,
      auditService,
      notificationService,
      metricsService,
      zoneService,
      queueService,
      promotionService,
      request,
      booking,
    };
  }

  describe("approve", () => {
    it("moves to processing, calls the payment provider, finalizes the booking/tickets/zone, and marks succeeded", async () => {
      const {
        useCase,
        repository,
        bookingModel,
        ticketModel,
        zoneModel,
        paymentService,
        auditService,
        notificationService,
        zoneService,
        promotionService,
        request,
        booking,
      } = makeUseCase({});

      await useCase.approve(reviewer, request._id.toString(), {});

      // approve() only ever calls moveToProcessing from REQUESTED — it
      // already asserted request.status === REQUESTED above.
      expect(repository.updateRequestStatus).toHaveBeenCalledWith(
        request._id,
        { $in: [RefundRequestStatus.REQUESTED] },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.PROCESSING,
          }),
        })
      );

      // booking flips to refund_pending before calling the provider
      expect(bookingModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: booking._id,
          paymentStatus: PaymentStatus.PAID,
          status: BookingStatus.CONFIRMED,
        }),
        { $set: { paymentStatus: PaymentStatus.REFUND_PENDING } }
      );

      expect(paymentService.issueAdminRefund).toHaveBeenCalledWith(
        booking._id.toString(),
        booking.stripePaymentIntentId,
        reviewer.userId,
        expect.any(String),
        {
          partialAmountVnd: undefined, // full refund: amount === refundable balance
          idempotencyReference: request._id.toString(),
        }
      );

      // finalizeRefundedBooking: booking cancelled+refunded, tickets cancelled, zone counts decremented
      expect(bookingModel.updateOne).toHaveBeenCalledWith(
        { _id: booking._id },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: BookingStatus.CANCELLED,
            paymentStatus: PaymentStatus.REFUNDED,
          }),
          $inc: { totalRefunded: request.amount },
        }),
        expect.objectContaining({ session: expect.anything() })
      );
      expect(ticketModel.updateMany).toHaveBeenCalledWith(
        { bookingId: booking._id, status: "valid", isDeleted: false },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "cancelled" }),
        }),
        expect.objectContaining({ session: expect.anything() })
      );
      expect(zoneModel.updateOne).toHaveBeenCalled();

      // PRE-7: a full refund releases zone inventory, so the zone
      // availability cache MUST be invalidated, not left to the 30s TTL.
      expect(zoneService.invalidateZoneAvailabilityCache).toHaveBeenCalledWith(
        booking.zoneId
      );

      // #3 promo quota leak: full refund must release promo usage in the
      // same finalize transaction.
      expect(promotionService.releaseUsageForBooking).toHaveBeenCalledWith(
        booking._id,
        expect.anything()
      );

      expect(repository.updateRequestById).toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.SUCCEEDED,
            provider: "stripe",
            providerRefundId: "re_123",
          }),
        })
      );

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REFUND_APPROVED })
      );
      expect(notificationService.notifyRefundReviewed).toHaveBeenCalledWith(
        expect.objectContaining({ approved: true })
      );
    });

    it("marks the request FAILED and alerts, without finalizing the booking, when the provider refund fails", async () => {
      const {
        useCase,
        repository,
        bookingModel,
        paymentService,
        auditService,
        notificationService,
        request,
      } = makeUseCase({
        refundResult: {
          provider: "stripe",
          status: "failed",
          errorMessage: "card_declined",
        },
      });

      await useCase.approve(reviewer, request._id.toString(), {});

      expect(paymentService.issueAdminRefund).toHaveBeenCalled();
      // booking was flipped to refund_pending (1 call) but NEVER cancelled/refunded (no second updateOne with status:CANCELLED)
      const cancelCalls = bookingModel.updateOne.mock.calls.filter(
        (call: unknown[]) =>
          (call[1] as { $set?: { status?: string } })?.$set?.status ===
          BookingStatus.CANCELLED
      );
      expect(cancelCalls).toHaveLength(0);

      expect(repository.updateRequestById).toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.FAILED,
            failureReason: "card_declined",
          }),
        })
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REFUND_FAILED })
      );
      expect(notificationService.notifyRefundFailed).toHaveBeenCalled();
    });

    it("rejects approving a request that is not in REQUESTED status", async () => {
      const { useCase, repository, request } = makeUseCase({
        request: makeRequest({ status: RefundRequestStatus.SUCCEEDED }),
      });

      await expect(
        useCase.approve(reviewer, request._id.toString(), {})
      ).rejects.toThrow(ConflictException);
      expect(repository.updateRequestStatus).not.toHaveBeenCalled();
    });

    it("aborts with Conflict when moveToProcessing loses the race (concurrent status change)", async () => {
      const { useCase, paymentService, request } = makeUseCase({
        moveToProcessingModifiedCount: 0,
      });

      await expect(
        useCase.approve(reviewer, request._id.toString(), {})
      ).rejects.toThrow(ConflictException);
      expect(paymentService.issueAdminRefund).not.toHaveBeenCalled();
    });

    it("propagates ForbiddenException when the reviewer does not manage the event", async () => {
      const { useCase, policy, request } = makeUseCase({});
      policy.assertCanReview.mockRejectedValue(new ForbiddenException());

      await expect(
        useCase.approve(reviewer, request._id.toString(), {})
      ).rejects.toThrow(ForbiddenException);
    });

    describe("partial refund (amount < remaining refundable balance)", () => {
      it("passes partialAmountVnd to the payment provider and does NOT cancel the booking/tickets/zone", async () => {
        const request = makeRequest({ amount: 30000 }); // booking totalPrice=100000, totalRefunded=0
        const {
          useCase,
          bookingModel,
          ticketModel,
          zoneModel,
          paymentService,
          repository,
          notificationService,
          promotionService,
        } = makeUseCase({ request });

        await useCase.approve(reviewer, request._id.toString(), {});

        expect(paymentService.issueAdminRefund).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          reviewer.userId,
          expect.any(String),
          {
            partialAmountVnd: 30000,
            idempotencyReference: request._id.toString(),
          }
        );

        // booking finalization: only totalRefunded/refundHistory + paymentStatus back to PAID
        expect(bookingModel.updateOne).toHaveBeenCalledWith(
          { _id: expect.anything() },
          {
            $set: { paymentStatus: PaymentStatus.PAID },
            $inc: { totalRefunded: 30000 },
            $push: {
              refundHistory: expect.objectContaining({ amount: 30000 }),
            },
          },
          expect.objectContaining({ session: expect.anything() })
        );
        // must NOT run the full-cancellation side effects
        const cancelCalls = bookingModel.updateOne.mock.calls.filter(
          (call: unknown[]) =>
            (call[1] as { $set?: { status?: string } })?.$set?.status ===
            BookingStatus.CANCELLED
        );
        expect(cancelCalls).toHaveLength(0);
        expect(ticketModel.updateMany).not.toHaveBeenCalled();
        expect(zoneModel.updateOne).not.toHaveBeenCalled();
        // #3 promo quota leak: booking/ticket still valid after a partial
        // refund, so promo usage must NOT be released.
        expect(promotionService.releaseUsageForBooking).not.toHaveBeenCalled();

        // the refund REQUEST itself still succeeded — the money was refunded
        expect(repository.updateRequestById).toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.SUCCEEDED,
            }),
          })
        );
        expect(notificationService.notifyRefundReviewed).toHaveBeenCalledWith(
          expect.objectContaining({ approved: true, amount: 30000 })
        );
      });

      it("treats an amount equal to the exact remaining balance as a full refund (cancels the booking)", async () => {
        const request = makeRequest({ amount: 100000 }); // booking totalPrice=100000, totalRefunded=0
        const { useCase, bookingModel, ticketModel } = makeUseCase({
          request,
        });

        await useCase.approve(reviewer, request._id.toString(), {});

        const cancelCalls = bookingModel.updateOne.mock.calls.filter(
          (call: unknown[]) =>
            (call[1] as { $set?: { status?: string } })?.$set?.status ===
            BookingStatus.CANCELLED
        );
        expect(cancelCalls).toHaveLength(1);
        expect(ticketModel.updateMany).toHaveBeenCalled();
      });

      it("a second partial refund against a booking with a prior partial refund is still correctly classified as partial", async () => {
        const request = makeRequest({ amount: 20000 });
        const booking = makeBooking({
          _id: request.bookingId,
          totalPrice: 100000,
          totalRefunded: 30000, // a prior partial refund already landed
        });
        const { useCase, bookingModel, ticketModel, paymentService } =
          makeUseCase({ request, booking });

        await useCase.approve(reviewer, request._id.toString(), {});

        // remaining balance = 100000 - 30000 = 70000; 20000 < 70000 -> partial
        expect(paymentService.issueAdminRefund).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          reviewer.userId,
          expect.any(String),
          {
            partialAmountVnd: 20000,
            idempotencyReference: request._id.toString(),
          }
        );
        expect(ticketModel.updateMany).not.toHaveBeenCalled();
        expect(bookingModel.updateOne).toHaveBeenCalledWith(
          { _id: expect.anything() },
          expect.objectContaining({ $inc: { totalRefunded: 20000 } }),
          expect.objectContaining({ session: expect.anything() })
        );
      });
    });

    describe("provider refund succeeds but DB finalize fails (NEW#3)", () => {
      it("records RECONCILIATION_REQUIRED, alerts, increments the metric, and rethrows — does NOT leave the request silently stuck at PROCESSING", async () => {
        const {
          useCase,
          session,
          repository,
          auditService,
          metricsService,
          queueService,
          request,
        } = makeUseCase({});

        session.withTransaction.mockRejectedValueOnce(
          new Error("MongoNetworkError: connection lost mid-commit")
        );

        await expect(
          useCase.approve(reviewer, request._id.toString(), {})
        ).rejects.toThrow("MongoNetworkError");

        expect(repository.updateRequestById).toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.RECONCILIATION_REQUIRED,
              provider: "stripe",
              providerRefundId: "re_123",
              failureReason: expect.stringContaining("MongoNetworkError"),
            }),
          })
        );
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
          })
        );
        expect(metricsService.refundFailuresTotal.inc).toHaveBeenCalledWith({
          source: "finalize",
        });
        // The recovery path MUST actually page someone, not just log +
        // increment an unwatched counter — reuses the same
        // "refund-failure-alert" job the provider-failure sibling path uses.
        expect(queueService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "refund-failure-alert",
            payload: expect.objectContaining({
              bookingId: request.bookingId.toString(),
              paymentRef: "re_123",
              source: "stripe",
              errorMessage: expect.stringContaining("MongoNetworkError"),
            }),
          })
        );
        // Must NOT mark the request SUCCEEDED — money moved but the
        // booking/tickets/zone were never actually finalized.
        expect(repository.updateRequestById).not.toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.SUCCEEDED,
            }),
          })
        );
      });

      it("does not let an unrelated ALERT_ENQUEUE failure stop RECONCILIATION_REQUIRED from being durably recorded", async () => {
        const { useCase, session, repository, queueService, request } =
          makeUseCase({});

        session.withTransaction.mockRejectedValueOnce(
          new Error("MongoNetworkError: connection lost mid-commit")
        );
        queueService.addJob.mockRejectedValueOnce(
          new Error("redis-queue unreachable")
        );

        await expect(
          useCase.approve(reviewer, request._id.toString(), {})
        ).rejects.toThrow("MongoNetworkError");

        expect(repository.updateRequestById).toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.RECONCILIATION_REQUIRED,
            }),
          })
        );
      });

      it("CRITICAL race fix: a booking cancelled by a DIFFERENT flow (e.g. admin-cancel-booking) while this refund's provider call was in flight records RECONCILIATION_REQUIRED instead of silently reporting SUCCEEDED", async () => {
        const {
          useCase,
          bookingFindOneChain,
          repository,
          bookingModel,
          ticketModel,
          zoneModel,
          auditService,
          metricsService,
          queueService,
          booking,
          request,
        } = makeUseCase({});

        // Simulates admin-cancel-booking (or cancel-ticket) having already
        // flipped this booking to CANCELLED, with no refundHistory entry for
        // THIS refund request — the exact race from the CRITICAL finding:
        // provider money already moved (the outer paymentService mock still
        // reports "succeeded"), but finalizeRefundedBooking's own re-read
        // proves this specific request never committed its bookkeeping.
        bookingFindOneChain.lean.mockResolvedValueOnce({
          status: BookingStatus.CANCELLED,
          zoneId: booking.zoneId,
          quantity: booking.quantity,
          totalPrice: booking.totalPrice,
          totalRefunded: 0,
          refundHistory: [],
        });

        await expect(
          useCase.approve(reviewer, request._id.toString(), {})
        ).rejects.toThrow(/not CONFIRMED/);

        // The dangerous silent path: must NEVER mark this request SUCCEEDED.
        expect(repository.updateRequestById).not.toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.SUCCEEDED,
            }),
          })
        );
        // And the finalize writes (booking cancel/ticket cancel/zone
        // decrement) must never have run — the race means they don't apply
        // to this booking's already-changed state. (bookingModel.updateOne
        // IS called once earlier, for the REFUND_PENDING transition before
        // the provider call — only the finalize's cancel/refund write is
        // asserted absent here.)
        const finalizeWriteCalls = bookingModel.updateOne.mock.calls.filter(
          (call: unknown[]) =>
            (call[1] as { $set?: { status?: string } })?.$set?.status ===
            BookingStatus.CANCELLED
        );
        expect(finalizeWriteCalls).toHaveLength(0);
        expect(ticketModel.updateMany).not.toHaveBeenCalled();
        expect(zoneModel.updateOne).not.toHaveBeenCalled();

        expect(repository.updateRequestById).toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.RECONCILIATION_REQUIRED,
              provider: "stripe",
              providerRefundId: "re_123",
            }),
          })
        );
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
          })
        );
        expect(metricsService.refundFailuresTotal.inc).toHaveBeenCalledWith({
          source: "finalize",
        });
        expect(queueService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({ type: "refund-failure-alert" })
        );
      });

      it("#3: releaseUsageForBooking failing aborts the finalize transaction and records RECONCILIATION_REQUIRED instead of committing a cancelled booking with dangling promo quota", async () => {
        const { useCase, promotionService, repository, request } = makeUseCase(
          {}
        );

        promotionService.releaseUsageForBooking.mockRejectedValueOnce(
          new Error("promotion usage write conflict")
        );

        await expect(
          useCase.approve(reviewer, request._id.toString(), {})
        ).rejects.toThrow("promotion usage write conflict");

        // Booking/ticket/zone finalize writes ran (same transaction attempt),
        // but the whole transaction must abort — never report SUCCEEDED.
        expect(repository.updateRequestById).not.toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.SUCCEEDED,
            }),
          })
        );
        expect(repository.updateRequestById).toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.RECONCILIATION_REQUIRED,
              failureReason: expect.stringContaining(
                "promotion usage write conflict"
              ),
            }),
          })
        );
      });

      it("booking not found at all inside the transaction (e.g. hard-deleted) also records RECONCILIATION_REQUIRED, never SUCCEEDED", async () => {
        const { useCase, bookingFindOneChain, repository, request } =
          makeUseCase({});

        bookingFindOneChain.lean.mockResolvedValueOnce(null);

        await expect(
          useCase.approve(reviewer, request._id.toString(), {})
        ).rejects.toThrow(/not found/);

        expect(repository.updateRequestById).toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.RECONCILIATION_REQUIRED,
            }),
          })
        );
        expect(repository.updateRequestById).not.toHaveBeenCalledWith(
          request._id,
          expect.objectContaining({
            $set: expect.objectContaining({
              status: RefundRequestStatus.SUCCEEDED,
            }),
          })
        );
      });
    });
  });

  describe("reject", () => {
    it("rejects a REQUESTED refund and notifies the user", async () => {
      const {
        useCase,
        repository,
        auditService,
        notificationService,
        request,
      } = makeUseCase({});

      await useCase.reject(reviewer, request._id.toString(), {
        reason: "not eligible",
      });

      expect(repository.conditionalUpdateRequest).toHaveBeenCalledWith(
        {
          _id: request._id,
          status: {
            $in: [RefundRequestStatus.REQUESTED, RefundRequestStatus.FAILED],
          },
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.REJECTED,
          }),
        })
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REFUND_REJECTED })
      );
      expect(notificationService.notifyRefundReviewed).toHaveBeenCalledWith(
        expect.objectContaining({ approved: false })
      );
    });

    it("also allows rejecting a FAILED refund", async () => {
      const { useCase, repository, request } = makeUseCase({
        request: makeRequest({ status: RefundRequestStatus.FAILED }),
      });

      await useCase.reject(reviewer, request._id.toString(), {});
      expect(repository.conditionalUpdateRequest).toHaveBeenCalled();
    });

    it("rejects trying to reject an already-succeeded refund", async () => {
      const { useCase, request } = makeUseCase({
        request: makeRequest({ status: RefundRequestStatus.SUCCEEDED }),
      });

      await expect(
        useCase.reject(reviewer, request._id.toString(), {})
      ).rejects.toThrow(ConflictException);
    });

    it("raises Conflict when the request's status changed concurrently (conditional update returns null)", async () => {
      const { useCase, repository, request } = makeUseCase({});
      repository.conditionalUpdateRequest.mockResolvedValue(null);

      await expect(
        useCase.reject(reviewer, request._id.toString(), {})
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("retry", () => {
    it("retries a FAILED refund through the provider again", async () => {
      const { useCase, repository, paymentService, auditService, request } =
        makeUseCase({
          request: makeRequest({ status: RefundRequestStatus.FAILED }),
        });

      await useCase.retry(reviewer, request._id.toString());

      expect(repository.updateRequestStatus).toHaveBeenCalled();
      expect(paymentService.issueAdminRefund).toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REFUND_RETRY })
      );
    });

    it("rejects retrying a request that is not FAILED", async () => {
      const { useCase, request } = makeUseCase({});

      await expect(
        useCase.retry(reviewer, request._id.toString())
      ).rejects.toThrow(ConflictException);
    });

    it("rejects retrying a request stuck in RECONCILIATION_REQUIRED — must NOT re-issue a second provider refund", async () => {
      const request = makeRequest({
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider: "stripe" as never,
        providerRefundId: "re_already_refunded",
      });
      const { useCase, paymentService } = makeUseCase({ request });

      await expect(
        useCase.retry(reviewer, request._id.toString())
      ).rejects.toThrow(ConflictException);
      expect(paymentService.issueAdminRefund).not.toHaveBeenCalled();
    });
  });

  describe("reconcile", () => {
    it("resumes a RECONCILIATION_REQUIRED request by re-running only the DB finalize — does NOT call the payment provider again", async () => {
      const request = makeRequest({
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider: "stripe" as never,
        providerRefundId: "re_already_refunded",
      });
      const {
        useCase,
        repository,
        paymentService,
        bookingModel,
        ticketModel,
        zoneModel,
        auditService,
        notificationService,
        zoneService,
        promotionService,
        booking,
      } = makeUseCase({ request });

      await useCase.reconcile(reviewer, request._id.toString());

      expect(paymentService.issueAdminRefund).not.toHaveBeenCalled();
      expect(repository.updateRequestStatus).toHaveBeenCalledWith(
        request._id,
        { $in: [RefundRequestStatus.RECONCILIATION_REQUIRED] },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.PROCESSING,
          }),
        })
      );
      expect(bookingModel.updateOne).toHaveBeenCalledWith(
        { _id: expect.anything() },
        expect.objectContaining({
          $set: expect.objectContaining({ status: BookingStatus.CANCELLED }),
        }),
        expect.objectContaining({ session: expect.anything() })
      );
      expect(ticketModel.updateMany).toHaveBeenCalled();
      expect(zoneModel.updateOne).toHaveBeenCalled();
      // PRE-7: reconcile's finalize also releases zone inventory on a full
      // refund, so it must invalidate the zone availability cache too.
      expect(zoneService.invalidateZoneAvailabilityCache).toHaveBeenCalledWith(
        booking.zoneId
      );
      // #3 promo quota leak: reconcile's finalize is the same code path,
      // so it must also release promo usage on a full refund.
      expect(promotionService.releaseUsageForBooking).toHaveBeenCalledWith(
        booking._id,
        expect.anything()
      );
      expect(repository.updateRequestById).toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.SUCCEEDED,
            provider: "stripe",
            providerRefundId: "re_already_refunded",
          }),
        })
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REFUND_APPROVED })
      );
      // Customer only ever gets ONE "refund succeeded" notification — this
      // is the delayed one, since the original attempt failed before
      // reaching finalizeSucceededRequest.
      expect(notificationService.notifyRefundReviewed).toHaveBeenCalledWith(
        expect.objectContaining({ approved: true })
      );
    });

    it("rejects reconciling a request that is not RECONCILIATION_REQUIRED", async () => {
      const { useCase, request } = makeUseCase({});

      await expect(
        useCase.reconcile(reviewer, request._id.toString())
      ).rejects.toThrow(ConflictException);
    });

    it("fails safe (Conflict) when the request has no recorded provider refund evidence", async () => {
      const request = makeRequest({
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
      });
      const { useCase } = makeUseCase({ request });

      await expect(
        useCase.reconcile(reviewer, request._id.toString())
      ).rejects.toThrow(ConflictException);
    });

    it("re-records RECONCILIATION_REQUIRED (does not spiral into a different state) when the finalize retry fails again", async () => {
      const request = makeRequest({
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider: "stripe" as never,
        providerRefundId: "re_already_refunded",
      });
      const { useCase, session, repository, auditService } = makeUseCase({
        request,
      });
      session.withTransaction.mockRejectedValueOnce(new Error("still down"));

      await expect(
        useCase.reconcile(reviewer, request._id.toString())
      ).rejects.toThrow("still down");

      expect(repository.updateRequestById).toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.RECONCILIATION_REQUIRED,
          }),
        })
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
        })
      );
    });

    it("treats a booking already tagged with this exact refundRequestId as truly already-committed — does not re-run the finalize writes, still marks SUCCEEDED", async () => {
      const request = makeRequest({
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider: "stripe" as never,
        providerRefundId: "re_already_refunded",
      });
      const {
        useCase,
        bookingFindOneChain,
        bookingModel,
        ticketModel,
        zoneModel,
        repository,
        auditService,
        notificationService,
        booking,
      } = makeUseCase({ request });

      // A prior finalize attempt actually committed (e.g. withTransaction
      // reported an ambiguous commit result) — the booking already left
      // CONFIRMED and its refundHistory already carries THIS request's tag.
      // This must be treated as a true idempotent no-op, unlike the
      // "cancelled by an unrelated flow" race covered under `approve`.
      bookingFindOneChain.lean.mockResolvedValueOnce({
        status: BookingStatus.CANCELLED,
        zoneId: booking.zoneId,
        quantity: booking.quantity,
        totalPrice: booking.totalPrice,
        totalRefunded: request.amount,
        refundHistory: [
          {
            amount: request.amount,
            refundedAt: new Date(),
            refundRequestId: request._id,
          },
        ],
      });

      await useCase.reconcile(reviewer, request._id.toString());

      // The finalize writes must NOT re-run — they already landed.
      expect(bookingModel.updateOne).not.toHaveBeenCalled();
      expect(ticketModel.updateMany).not.toHaveBeenCalled();
      expect(zoneModel.updateOne).not.toHaveBeenCalled();

      // But the request still needs to reach SUCCEEDED — the only thing
      // that failed on the prior attempt was reporting success, not the
      // underlying commit.
      expect(repository.updateRequestById).toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.SUCCEEDED,
          }),
        })
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REFUND_APPROVED })
      );
      expect(notificationService.notifyRefundReviewed).toHaveBeenCalledWith(
        expect.objectContaining({ approved: true })
      );
    });

    it("CRITICAL race fix persists across reconcile: booking still shows no matching refundHistory tag (raced by another flow again) — stays RECONCILIATION_REQUIRED, never SUCCEEDED", async () => {
      const request = makeRequest({
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider: "stripe" as never,
        providerRefundId: "re_already_refunded",
      });
      const {
        useCase,
        bookingFindOneChain,
        repository,
        auditService,
        queueService,
        booking,
      } = makeUseCase({ request });

      bookingFindOneChain.lean.mockResolvedValueOnce({
        status: BookingStatus.CANCELLED,
        zoneId: booking.zoneId,
        quantity: booking.quantity,
        totalPrice: booking.totalPrice,
        totalRefunded: 0,
        refundHistory: [],
      });

      await expect(
        useCase.reconcile(reviewer, request._id.toString())
      ).rejects.toThrow(/not CONFIRMED/);

      expect(repository.updateRequestById).not.toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.SUCCEEDED,
          }),
        })
      );
      expect(repository.updateRequestById).toHaveBeenCalledWith(
        request._id,
        expect.objectContaining({
          $set: expect.objectContaining({
            status: RefundRequestStatus.RECONCILIATION_REQUIRED,
          }),
        })
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
        })
      );
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ type: "refund-failure-alert" })
      );
    });
  });
});

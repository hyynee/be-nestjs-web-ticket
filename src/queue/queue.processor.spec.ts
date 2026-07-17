import { Test, TestingModule } from "@nestjs/testing";
import { QueueProcessor } from "./queue.processor";
import { MailService } from "@src/services/mail.service";
import { ExportService } from "@src/export/export.service";
import { TicketService } from "@src/ticket/ticket.service";
import { InvoiceService } from "@src/invoice/invoice.service";
import { getModelToken } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { getQueueToken } from "@nestjs/bullmq";
import { Job, Queue, UnrecoverableError } from "bullmq";
import { Logger } from "@nestjs/common";
import { FAILED_JOB_ALERT_THRESHOLD } from "./queue.service";

describe("QueueProcessor", () => {
  let processor: QueueProcessor;
  let mailService: jest.Mocked<MailService>;
  let exportService: jest.Mocked<ExportService>;
  let userModel: any;
  let ticketService: jest.Mocked<TicketService>;
  let invoiceService: jest.Mocked<InvoiceService>;
  let queue: jest.Mocked<Queue>;

  const mockJob = (data: any, opts?: any) =>
    ({
      data,
      opts: opts ?? { attempts: 3 },
      id: "job-1",
      attemptsMade: 0,
    }) as unknown as Job;

  beforeEach(async () => {
    mailService = {
      deliverRegisterEmail: jest.fn().mockResolvedValue(undefined),
      deliverVerificationEmail: jest.fn().mockResolvedValue(undefined),
      deliverPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
      deliverBookingConfirmation: jest.fn().mockResolvedValue(undefined),
      deliverRefundFailureAlert: jest.fn().mockResolvedValue(undefined),
      deliverExportReady: jest.fn().mockResolvedValue(undefined),
    } as any;

    exportService = {
      getTicketExportData: jest.fn(),
      getCheckInZoneExportData: jest.fn(),
    } as any;

    userModel = {
      findById: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn(),
    };

    ticketService = {
      generateMissingQRCodesForBooking: jest.fn().mockResolvedValue(undefined),
    } as any;

    invoiceService = {
      deliverInvoiceEmail: jest.fn().mockResolvedValue(undefined),
    } as any;

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJobCounts: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueProcessor,
        { provide: MailService, useValue: mailService },
        { provide: ExportService, useValue: exportService },
        { provide: TicketService, useValue: ticketService },
        { provide: InvoiceService, useValue: invoiceService },
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: getQueueToken("default"), useValue: queue },
        { provide: getQueueToken("dead-letter"), useValue: queue },
      ],
    }).compile();

    processor = module.get<QueueProcessor>(QueueProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("process", () => {
    it("throws on missing job data", async () => {
      const job = { data: null, id: "j1" } as unknown as Job;
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      await expect(processor.process(job)).rejects.toThrow("Invalid job data");
    });

    it("throws on missing type in job data", async () => {
      const job = mockJob({});
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      await expect(processor.process(job)).rejects.toThrow("Invalid job data");
    });

    describe("send-register-email", () => {
      it("calls deliverRegisterEmail with correct args", async () => {
        const job = mockJob({
          type: "send-register-email",
          payload: { to: "user@test.com", fullName: "Alice" },
        });
        const result = await processor.process(job);
        expect(mailService.deliverRegisterEmail).toHaveBeenCalledWith(
          "user@test.com",
          "Alice"
        );
        expect(result).toBe(true);
      });
    });

    describe("send-verification-email", () => {
      it("calls deliverVerificationEmail with correct args", async () => {
        const job = mockJob({
          type: "send-verification-email",
          payload: {
            to: "user@test.com",
            token: "hex-token-abc",
            fullName: "Alice",
          },
        });
        const result = await processor.process(job);
        expect(mailService.deliverVerificationEmail).toHaveBeenCalledWith(
          "user@test.com",
          "hex-token-abc",
          "Alice"
        );
        expect(result).toBe(true);
      });
    });

    describe("resend-invoice-email", () => {
      it("calls InvoiceService.deliverInvoiceEmail with the bookingCode", async () => {
        const job = mockJob({
          type: "resend-invoice-email",
          payload: { bookingCode: "BK123" },
        });
        const result = await processor.process(job);
        expect(invoiceService.deliverInvoiceEmail).toHaveBeenCalledWith(
          "BK123"
        );
        expect(result).toBe(true);
      });
    });

    describe("send-password-reset", () => {
      it("calls deliverPasswordResetEmail with correct args", async () => {
        const job = mockJob({
          type: "send-password-reset",
          payload: {
            email: "user@test.com",
            resetToken: "tok123",
            fullName: "Bob",
          },
        });
        const result = await processor.process(job);
        expect(mailService.deliverPasswordResetEmail).toHaveBeenCalledWith(
          "user@test.com",
          "tok123",
          "Bob"
        );
        expect(result).toBe(true);
      });
    });

    describe("send-booking-confirmation", () => {
      it("calls deliverBookingConfirmation with payload", async () => {
        const payload = { email: "user@test.com", customerName: "Alice" };
        const job = mockJob({ type: "send-booking-confirmation", payload });
        const result = await processor.process(job);
        expect(mailService.deliverBookingConfirmation).toHaveBeenCalledWith(
          payload
        );
        expect(result).toBe(true);
      });
    });

    describe("refund-failure-alert", () => {
      const refundPayload = {
        bookingId: "BK001",
        paymentRef: "pi_123",
        source: "stripe",
        errorMessage: "Card declined",
        occurredAt: "2026-01-01T00:00:00Z",
      };

      it("logs error and sends alert when ALERT_EMAIL is set", async () => {
        process.env.ALERT_EMAIL = "ops@example.com";
        const job = mockJob({
          type: "refund-failure-alert",
          payload: refundPayload,
        });
        const result = await processor.process(job);
        expect(mailService.deliverRefundFailureAlert).toHaveBeenCalledWith({
          to: "ops@example.com",
          ...refundPayload,
        });
        expect(result).toBe(true);
      });

      it("logs warning when ALERT_EMAIL is not set", async () => {
        delete process.env.ALERT_EMAIL;
        jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
        const warnSpy = jest.spyOn(Logger.prototype, "warn");
        const job = mockJob({
          type: "refund-failure-alert",
          payload: refundPayload,
        });
        const result = await processor.process(job);
        expect(mailService.deliverRefundFailureAlert).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("ALERT_EMAIL env var not set")
        );
        expect(result).toBe(true);
      });
    });

    describe("export-tickets", () => {
      const exportPayload = {
        dto: { eventId: "evt123" },
        requestedByUserId: "user123",
      };

      it("warns and skips when admin not found", async () => {
        userModel.lean.mockResolvedValueOnce(null);
        jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
        const warnSpy = jest.spyOn(Logger.prototype, "warn");
        const job = mockJob({ type: "export-tickets", payload: exportPayload });
        const result = await processor.process(job);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("user user123 not found")
        );
        expect(result).toBe(true);
      });

      it("warns and skips when admin has no email", async () => {
        userModel.lean.mockResolvedValueOnce({ email: null });
        jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
        const warnSpy = jest.spyOn(Logger.prototype, "warn");
        const job = mockJob({ type: "export-tickets", payload: exportPayload });
        const result = await processor.process(job);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("user user123 not found")
        );
        expect(result).toBe(true);
      });

      it("throws UnrecoverableError when dataset too large", async () => {
        userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
        exportService.getTicketExportData.mockResolvedValueOnce(
          Array.from({ length: 50001 }, (_, i) => ({ id: `t${i}` }))
        );
        jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
        const job = mockJob({ type: "export-tickets", payload: exportPayload });
        await expect(processor.process(job)).rejects.toThrow(
          UnrecoverableError
        );
      });

      it("generates CSV and sends email on success", async () => {
        userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
        exportService.getTicketExportData.mockResolvedValueOnce([
          { ticketCode: "T001", status: "valid" },
        ]);
        const job = mockJob({ type: "export-tickets", payload: exportPayload });
        const result = await processor.process(job);
        expect(mailService.deliverExportReady).toHaveBeenCalledWith(
          "admin@test.com",
          "Export vé - Ticket System",
          expect.any(String),
          expect.stringMatching(/^tickets-export-.*\.csv$/)
        );
        expect(result).toBe(true);
      });
    });

    describe("export-checkin-zones", () => {
      const exportPayload = {
        dto: { eventId: "evt123", format: "csv" },
        requestedByUserId: "user456",
      };

      it("warns and skips when admin not found", async () => {
        userModel.lean.mockResolvedValueOnce(null);
        jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
        const warnSpy = jest.spyOn(Logger.prototype, "warn");
        const job = mockJob({
          type: "export-checkin-zones",
          payload: exportPayload,
        });
        const result = await processor.process(job);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("user user456 not found")
        );
        expect(result).toBe(true);
      });

      it("warns and skips when admin has no email", async () => {
        userModel.lean.mockResolvedValueOnce({ email: null });
        jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
        const warnSpy = jest.spyOn(Logger.prototype, "warn");
        const job = mockJob({
          type: "export-checkin-zones",
          payload: exportPayload,
        });
        const result = await processor.process(job);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("user user456 not found")
        );
        expect(result).toBe(true);
      });

      it("throws UnrecoverableError when dataset too large", async () => {
        userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
        exportService.getCheckInZoneExportData.mockResolvedValueOnce(
          Array.from({ length: 50001 }, (_, i) => ({ id: `z${i}` }))
        );
        jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
        const job = mockJob({
          type: "export-checkin-zones",
          payload: exportPayload,
        });
        await expect(processor.process(job)).rejects.toThrow(
          UnrecoverableError
        );
      });

      it("generates CSV and sends email on success", async () => {
        userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
        exportService.getCheckInZoneExportData.mockResolvedValueOnce([
          { zoneName: "VIP", checkedIn: 10 },
        ]);
        const job = mockJob({
          type: "export-checkin-zones",
          payload: exportPayload,
        });
        const result = await processor.process(job);
        expect(mailService.deliverExportReady).toHaveBeenCalledWith(
          "admin@test.com",
          "Export check-in zones - Ticket System",
          expect.any(String),
          expect.stringMatching(/^checkin-zones-export-.*\.csv$/)
        );
        expect(result).toBe(true);
      });
    });

    describe("unknown job type", () => {
      it("throws error for unknown type", async () => {
        jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
        const job = mockJob({ type: "unknown-type" });
        await expect(processor.process(job)).rejects.toThrow(
          "Unknown job type: unknown-type"
        );
      });
    });
  });

  describe("toCsvString", () => {
    it("returns 'No data' for empty rows array", async () => {
      userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
      exportService.getTicketExportData.mockResolvedValueOnce([]);

      const job = mockJob({
        type: "export-tickets",
        payload: { dto: { eventId: "evt1" }, requestedByUserId: "u1" },
      });

      await processor.process(job);
      const csvArg = mailService.deliverExportReady.mock.calls[0][2];
      expect(csvArg).toBe("No data");
    });

    it("creates proper CSV from rows via export flow", async () => {
      userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
      exportService.getTicketExportData.mockResolvedValueOnce([
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ]);

      const job = mockJob({
        type: "export-tickets",
        payload: { dto: { eventId: "evt1" }, requestedByUserId: "u1" },
      });

      await processor.process(job);
      const csvArg = mailService.deliverExportReady.mock.calls[0][2];
      const lines = csvArg.split("\n");
      expect(lines[0]).toBe('"name","age"');
      expect(lines[1]).toBe('"Alice","30"');
      expect(lines[2]).toBe('"Bob","25"');
    });

    it("escapes double quotes via export flow", async () => {
      userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
      exportService.getTicketExportData.mockResolvedValueOnce([
        { name: 'John "Doe"' },
      ]);

      const job = mockJob({
        type: "export-tickets",
        payload: { dto: { eventId: "evt1" }, requestedByUserId: "u1" },
      });

      await processor.process(job);
      const csvArg = mailService.deliverExportReady.mock.calls[0][2];
      expect(csvArg).toContain('"John ""Doe"""');
    });

    it("handles null values via export flow", async () => {
      userModel.lean.mockResolvedValueOnce({ email: "admin@test.com" });
      exportService.getTicketExportData.mockResolvedValueOnce([
        { name: null, age: 10 },
      ]);

      const job = mockJob({
        type: "export-tickets",
        payload: { dto: { eventId: "evt1" }, requestedByUserId: "u1" },
      });

      await processor.process(job);
      const csvArg = mailService.deliverExportReady.mock.calls[0][2];
      expect(csvArg).toContain('""');
    });
  });

  describe("onFailed", () => {
    const makeJob = (
      attemptsMade: number,
      maxAttempts: number = 3,
      data?: any
    ) =>
      ({
        id: "job-fail-1",
        attemptsMade,
        opts: { attempts: maxAttempts },
        data: data ?? { type: "send-register-email" },
      }) as unknown as Job;

    const makeError = (msg: string) => new Error(msg);

    it("returns early when attemptsMade < maxAttempts", async () => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      await processor.onFailed(makeJob(1, 3), makeError("fail"));
      expect(jest.mocked(Logger.prototype.error)).not.toHaveBeenCalled();
    });

    it("returns early when attemptsMade < maxAttempts (job at 2 of 3)", async () => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      await processor.onFailed(makeJob(2, 3), makeError("fail"));
      expect(jest.mocked(Logger.prototype.error)).not.toHaveBeenCalled();
    });

    it("logs error when failedCount > threshold", async () => {
      queue.getJobCounts.mockResolvedValueOnce({
        failed: FAILED_JOB_ALERT_THRESHOLD + 1,
      } as any);
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("critical error"));

      expect(jest.mocked(Logger.prototype.error)).toHaveBeenCalledWith(
        expect.stringContaining("exceeded threshold")
      );
    });

    it("logs warn when failedCount <= threshold", async () => {
      queue.getJobCounts.mockResolvedValueOnce({ failed: 5 } as any);
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("minor error"));

      expect(jest.mocked(Logger.prototype.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Job permanently failed")
      );
    });

    it("logs fallback when getJobCounts throws", async () => {
      queue.getJobCounts.mockRejectedValueOnce(new Error("Redis down"));
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("error"));

      expect(jest.mocked(Logger.prototype.warn)).toHaveBeenCalledWith(
        expect.stringContaining("failed count unavailable")
      );
    });

    it("returns early with default attempts (1) when opts.attempts is undefined", async () => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      const job = makeJob(0);
      (job as any).opts = {};
      await processor.onFailed(job, makeError("no attempts config"));

      expect(jest.mocked(Logger.prototype.error)).not.toHaveBeenCalled();
      expect(jest.mocked(Logger.prototype.warn)).not.toHaveBeenCalled();
    });

    it("uses 0 fallback when getJobCounts returns nullish counts", async () => {
      queue.getJobCounts.mockResolvedValueOnce({} as any);
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("no counts"));

      expect(jest.mocked(Logger.prototype.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Job permanently failed")
      );
    });

    it("handles getJobCounts returning null", async () => {
      queue.getJobCounts.mockResolvedValueOnce(null as any);
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("null"));

      expect(jest.mocked(Logger.prototype.warn)).toHaveBeenCalledWith(
        expect.stringContaining("Job permanently failed")
      );
    });
  });
});

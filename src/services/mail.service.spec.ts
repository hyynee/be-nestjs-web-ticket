import { Test, TestingModule } from "@nestjs/testing";
import { MailService } from "./mail.service";
import { QueueService } from "@src/queue/queue.service";
import * as nodemailer from "nodemailer";

jest.mock("nodemailer");

const mockTransporter = {
  sendMail: jest.fn().mockResolvedValue({ messageId: "test-id" }),
};
const createTransportMock = jest.fn().mockReturnValue(mockTransporter);
(nodemailer.createTransport as jest.Mock).mockImplementation(
  createTransportMock
);

const OLD_ENV = process.env;

describe("MailService — real implementation", () => {
  let service: MailService;
  let queueService: { addJob: jest.Mock };

  beforeAll(() => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "noreply@example.com";
    process.env.SMTP_PASS = "pass";
    process.env.FRONTEND_URL = "http://localhost:3000";
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    queueService = { addJob: jest.fn().mockResolvedValue({}) };
    mockTransporter.sendMail.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get(MailService);
  });

  describe("constructor", () => {
    it("creates transporter with correct config", () => {
      expect(createTransportMock).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: {
          user: "noreply@example.com",
          pass: "pass",
        },
      });
    });
  });

  describe("escapeHtml", () => {
    it("escapes & < > \" '", () => {
      const escaped = (service as any).escapeHtml("& < > \" '");
      expect(escaped).toBe("&amp; &lt; &gt; &quot; &#39;");
    });
  });

  describe("formatPrice", () => {
    it("formats VND correctly", () => {
      const result = (service as any).formatPrice(1500000);
      expect(result).toContain("1.500.000");
    });
  });

  describe("formatDate", () => {
    it("formats date in vi-VN locale", () => {
      const date = new Date("2026-05-31T10:30:00");
      const result = (service as any).formatDate(date);
      expect(result).toContain("2026");
    });
  });

  describe("buildQrAttachment", () => {
    it("returns empty src when qrCode is null", () => {
      const result = (service as any).buildQrAttachment("TCK001", "");
      expect(result.src).toBe("");
      expect(result.cid).toBe("qr-TCK001");
    });

    it("returns raw qrCode as src when base64 format is invalid", () => {
      const result = (service as any).buildQrAttachment(
        "TCK001",
        "not-a-base64-string"
      );
      expect(result.src).toBe("not-a-base64-string");
      expect(result.attachment).toBeUndefined();
    });

    it("returns parsed attachment when base64 format is valid", () => {
      const result = (service as any).buildQrAttachment(
        "TCK001",
        "data:image/png;base64,iVBORw0KGgo="
      );
      expect(result.cid).toBe("qr-TCK001");
      expect(result.src).toBe("cid:qr-TCK001");
      expect(result.attachment).toBeDefined();
      expect(result.attachment.filename).toBe("TCK001.png");
      expect(result.attachment.encoding).toBe("base64");
      expect(result.attachment.contentType).toBe("image/png");
    });
  });

  describe("sendRegisterEmail", () => {
    it("enqueues a send-register-email job", async () => {
      await service.sendRegisterEmail("user@example.com", "Alice");
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "send-register-email",
          payload: { to: "user@example.com", fullName: "Alice" },
        })
      );
    });

    it("returns status: queued", async () => {
      const result = await service.sendRegisterEmail(
        "user@example.com",
        "Alice"
      );
      expect(result).toEqual({ status: "queued" });
    });
  });

  describe("sendVerificationEmail", () => {
    it("enqueues a send-verification-email job", async () => {
      await service.sendVerificationEmail(
        "user@example.com",
        "hex-token-abc",
        "Alice"
      );
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "send-verification-email",
          payload: {
            to: "user@example.com",
            token: "hex-token-abc",
            fullName: "Alice",
          },
        })
      );
    });

    it("returns status: queued", async () => {
      const result = await service.sendVerificationEmail(
        "user@example.com",
        "hex-token-abc",
        "Alice"
      );
      expect(result).toEqual({ status: "queued" });
    });
  });

  describe("sendPasswordResetEmail", () => {
    it("enqueues a send-password-reset job", async () => {
      await service.sendPasswordResetEmail(
        "user@example.com",
        "token-uuid",
        "Bob"
      );
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ type: "send-password-reset" })
      );
    });
  });

  describe("sendBookingConfirmation", () => {
    it("enqueues a send-booking-confirmation job", async () => {
      await service.sendBookingConfirmation({
        email: "user@example.com",
        customerName: "Alice",
        bookingCode: "BK001",
        eventTitle: "Concert",
        eventLocation: "Hall A",
        eventDate: new Date(),
        zoneName: "Zone A",
        seats: [],
        quantity: 1,
        totalPrice: 100000,
        currency: "vnd",
        tickets: [],
      });
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ type: "send-booking-confirmation" })
      );
    });
  });

  describe("deliverRegisterEmail", () => {
    it("calls transporter.sendMail with correct recipient", async () => {
      await service.deliverRegisterEmail("user@example.com", "Alice");
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "user@example.com" })
      );
    });

    it("escapes HTML in fullName to prevent XSS", async () => {
      await service.deliverRegisterEmail(
        "user@example.com",
        "<script>xss</script>"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("<script>");
      expect(call.html).toContain("&lt;script&gt;");
    });

    it("includes an anchor tag for navigation", async () => {
      await service.deliverRegisterEmail("user@example.com", "Alice");
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("<a href=");
    });
  });

  describe("deliverVerificationEmail", () => {
    it("includes the verification token in the link", async () => {
      await service.deliverVerificationEmail(
        "user@example.com",
        "hex-token-123",
        "Bob"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain(
        "http://localhost:3000/verify-email?token=hex-token-123"
      );
    });

    it("escapes HTML in fullName", async () => {
      await service.deliverVerificationEmail(
        "user@example.com",
        "hex-token-123",
        "<b>Bob</b>"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("<b>Bob</b>");
    });

    it("calls transporter.sendMail with correct recipient", async () => {
      await service.deliverVerificationEmail(
        "user@example.com",
        "hex-token-123",
        "Alice"
      );
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "user@example.com" })
      );
    });
  });

  describe("deliverPasswordResetEmail", () => {
    it("includes the reset token in the link", async () => {
      await service.deliverPasswordResetEmail(
        "user@example.com",
        "uuid-token-123",
        "Bob"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("uuid-token-123");
    });

    it("escapes HTML in fullName", async () => {
      await service.deliverPasswordResetEmail(
        "user@example.com",
        "token",
        "<b>Bob</b>"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("<b>Bob</b>");
    });

    it("builds correct reset link", async () => {
      await service.deliverPasswordResetEmail(
        "user@example.com",
        "mytoken123",
        "Alice"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain(
        "http://localhost:3000/reset-password?token=mytoken123"
      );
    });
  });

  describe("deliverBookingConfirmation", () => {
    const mockData = {
      email: "user@example.com",
      customerName: "Alice",
      bookingCode: "BK001",
      eventTitle: "Concert",
      eventLocation: "Hall A",
      eventDate: new Date("2026-06-01"),
      zoneName: "VIP",
      seats: ["A1", "A2"],
      quantity: 2,
      totalPrice: 2000000,
      currency: "vnd",
      tickets: [
        {
          ticketCode: "TCK001",
          seatNumber: "A1",
          qrCode: "data:image/png;base64,abc123",
        },
        { ticketCode: "TCK002", seatNumber: "A2", qrCode: "" },
      ],
    };

    it("sends email with correct recipient and subject", async () => {
      await service.deliverBookingConfirmation(mockData);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: expect.stringContaining("BK001"),
        })
      );
    });

    it("includes tickets HTML when tickets are present", async () => {
      await service.deliverBookingConfirmation(mockData);
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("Danh sách vé");
      expect(call.html).toContain("TCK001");
      expect(call.html).toContain("TCK002");
    });

    it("includes attachments for valid QR codes", async () => {
      await service.deliverBookingConfirmation(mockData);
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.attachments).toHaveLength(1);
      expect(call.attachments[0].filename).toBe("TCK001.png");
    });

    it("shows placeholder for missing QR code", async () => {
      await service.deliverBookingConfirmation(mockData);
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("QR chưa sẵn sàng");
    });

    it("shows seat info when seats are present", async () => {
      await service.deliverBookingConfirmation(mockData);
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("A1");
      expect(call.html).toContain("A2");
    });

    it("shows quantity when seats are empty", async () => {
      const noSeats = { ...mockData, seats: [], tickets: [] };
      await service.deliverBookingConfirmation(noSeats);
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("Số lượng vé");
    });

    it("handles ticket without seatNumber", async () => {
      const noSeatTicket = {
        ...mockData,
        tickets: [
          { ticketCode: "TCK003", qrCode: "data:image/png;base64,xyz" },
        ],
      };
      await service.deliverBookingConfirmation(noSeatTicket);
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("TCK003");
    });
  });

  describe("deliverExportReady", () => {
    it("attaches CSV with correct filename and content type", async () => {
      await service.deliverExportReady(
        "admin@example.com",
        "Export Done",
        "col1,col2\n1,2",
        "report.csv"
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.attachments[0].filename).toBe("report.csv");
      expect(call.attachments[0].contentType).toContain("text/csv");
    });

    it("sends to the requested recipient", async () => {
      await service.deliverExportReady(
        "admin@example.com",
        "Subject",
        "data",
        "file.csv"
      );
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "admin@example.com" })
      );
    });
  });

  describe("sendEventReminder", () => {
    it("sends reminder email", async () => {
      await service.sendEventReminder({
        email: "user@example.com",
        customerName: "Alice",
        eventTitle: "Concert",
        eventDate: new Date("2026-06-15"),
        eventLocation: "Stadium",
        bookingCode: "BK001",
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: "Nhắc nhở sự kiện sắp diễn ra",
        })
      );
    });

    it("escapes HTML in customerName", async () => {
      await service.sendEventReminder({
        email: "user@example.com",
        customerName: "<b>Alice</b>",
        eventTitle: "Concert",
        eventDate: new Date(),
        eventLocation: "Stadium",
        bookingCode: "BK001",
      });
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("<b>");
    });
  });

  describe("deliverRefundFailureAlert", () => {
    it("sends email to the alert address", async () => {
      await service.deliverRefundFailureAlert({
        to: "ops@example.com",
        bookingId: "BK001",
        paymentRef: "pi_123",
        source: "stripe",
        errorMessage: "Card declined",
        occurredAt: "2026-01-01T00:00:00Z",
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "ops@example.com" })
      );
    });

    it("subject contains CRITICAL keyword", async () => {
      await service.deliverRefundFailureAlert({
        to: "ops@example.com",
        bookingId: "BK001",
        paymentRef: "pi_123",
        source: "stripe",
        errorMessage: "error",
        occurredAt: "2026-01-01T00:00:00Z",
      });
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.subject).toContain("CRITICAL");
    });

    it("body contains bookingId and source", async () => {
      await service.deliverRefundFailureAlert({
        to: "ops@example.com",
        bookingId: "SPECIAL-BOOKING-999",
        paymentRef: "paypal_abc",
        source: "paypal",
        errorMessage: "timeout",
        occurredAt: "2026-01-01T00:00:00Z",
      });
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("SPECIAL-BOOKING-999");
      expect(call.html).toContain("paypal");
    });

    it("escapes HTML in errorMessage", async () => {
      await service.deliverRefundFailureAlert({
        to: "ops@example.com",
        bookingId: "B1",
        paymentRef: "p1",
        source: "stripe",
        errorMessage: "<img src=x onerror=alert(1)>",
        occurredAt: "2026-01-01T00:00:00Z",
      });
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("<img");
    });
  });

  describe("sendBookingCancellation", () => {
    it("sends cancellation email without refund amount", async () => {
      await service.sendBookingCancellation({
        email: "user@example.com",
        customerName: "Alice",
        bookingCode: "BK001",
        eventTitle: "Concert",
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: expect.stringContaining("BK001"),
        })
      );
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("hoàn lại");
    });

    it("sends cancellation email with refund amount", async () => {
      await service.sendBookingCancellation({
        email: "user@example.com",
        customerName: "Alice",
        bookingCode: "BK001",
        eventTitle: "Concert",
        refundAmount: 500000,
      });
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).toContain("hoàn lại");
    });

    it("escapes HTML fields", async () => {
      await service.sendBookingCancellation({
        email: "user@example.com",
        customerName: "<script>hack</script>",
        bookingCode: "BK001",
        eventTitle: "Concert",
      });
      const call = mockTransporter.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain("<script>");
    });
  });
});

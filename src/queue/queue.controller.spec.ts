import { Test, TestingModule } from "@nestjs/testing";
import { AuthGuard } from "@nestjs/passport";
import { QueueController } from "./queue.controller";
import { QueueService } from "./queue.service";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { Reflector } from "@nestjs/core";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AdminAddJobDto, QueueJobType } from "./dto/add-job.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";

describe("QueueController", () => {
  let controller: QueueController;
  let queueService: jest.Mocked<QueueService>;
  let auditService: jest.Mocked<AuditService>;

  const mockAdmin: JwtPayload = {
    userId: "admin-1",
    role: "admin",
    iat: 0,
    exp: 0,
  };

  beforeEach(async () => {
    queueService = {
      getQueueStats: jest.fn(),
      listJobs: jest.fn(),
      getJob: jest.fn(),
      addAdminJob: jest.fn(),
      retryJob: jest.fn(),
      moveToDeadLetter: jest.fn(),
      removeJob: jest.fn(),
    } as any;

    auditService = {
      record: jest.fn().mockResolvedValue(undefined),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [QueueController],
      providers: [
        { provide: QueueService, useValue: queueService },
        { provide: AuditService, useValue: auditService },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(QueueController);
  });

  afterEach(() => jest.clearAllMocks());

  it("is defined", () => expect(controller).toBeDefined());

  // ── Guard wiring ──────────────────────────────────────────────────────────

  it("requires the admin role via @Roles metadata", () => {
    const roles = new Reflector().get(ROLES_KEY, QueueController);
    expect(roles).toEqual(["admin"]);
  });

  // ── stats ─────────────────────────────────────────────────────────────────

  it("getStats returns aggregated queue stats", async () => {
    queueService.getQueueStats.mockResolvedValue({
      default: { active: 1 },
      deadLetter: { failed: 0 },
    } as any);

    const result = await controller.getStats();
    expect(result.default.active).toBe(1);
  });

  // ── list/detail ───────────────────────────────────────────────────────────

  it("listJobs delegates to service with query", async () => {
    queueService.listJobs.mockResolvedValue({
      data: [],
      page: 1,
      limit: 20,
      total: 0,
    });

    await controller.listJobs({ status: "failed" } as any);
    expect(queueService.listJobs).toHaveBeenCalledWith({ status: "failed" });
  });

  it("getJob delegates to service with id", async () => {
    queueService.getJob.mockResolvedValue({ id: "job-1" } as any);
    const result = await controller.getJob("job-1");
    expect(queueService.getJob).toHaveBeenCalledWith("job-1");
    expect(result).toEqual({ id: "job-1" });
  });

  // ── addAdminJob ───────────────────────────────────────────────────────────

  it("addAdminJob enqueues job and records an audit entry", async () => {
    queueService.addAdminJob.mockResolvedValue({ id: "job-1" } as any);
    const dto: AdminAddJobDto = {
      type: QueueJobType.SEND_REGISTER_EMAIL,
      payload: { to: "a@b.com" },
    };

    const result = await controller.addAdminJob(dto, mockAdmin);

    expect(queueService.addAdminJob).toHaveBeenCalledWith(dto);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.QUEUE_JOB_ADD,
        actorId: "admin-1",
        metadata: { jobId: "job-1", type: dto.type },
      })
    );
    expect(result).toEqual({ message: "Job added to queue", jobId: "job-1" });
  });

  // ── retry ─────────────────────────────────────────────────────────────────

  it("retryJob delegates to service and records an audit entry", async () => {
    queueService.retryJob.mockResolvedValue({ id: "job-1", retried: true });

    const result = await controller.retryJob("job-1", mockAdmin);

    expect(queueService.retryJob).toHaveBeenCalledWith("job-1");
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.QUEUE_JOB_RETRY,
        actorId: "admin-1",
      })
    );
    expect(result).toEqual({ id: "job-1", retried: true });
  });

  // ── move-to-dead-letter ───────────────────────────────────────────────────

  it("moveToDeadLetter delegates to service with reason and records audit", async () => {
    queueService.moveToDeadLetter.mockResolvedValue({
      id: "job-1",
      moved: true,
    });

    const result = await controller.moveToDeadLetter(
      "job-1",
      { reason: "stuck" },
      mockAdmin
    );

    expect(queueService.moveToDeadLetter).toHaveBeenCalledWith(
      "job-1",
      "stuck"
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.QUEUE_JOB_DEAD_LETTER,
        reason: "stuck",
      })
    );
    expect(result).toEqual({ id: "job-1", moved: true });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  it("removeJob delegates to service and records audit", async () => {
    queueService.removeJob.mockResolvedValue({ id: "job-1", removed: true });

    const result = await controller.removeJob("job-1", mockAdmin);

    expect(queueService.removeJob).toHaveBeenCalledWith("job-1");
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.QUEUE_JOB_REMOVE,
        actorId: "admin-1",
      })
    );
    expect(result).toEqual({ id: "job-1", removed: true });
  });
});

// ── DTO validation ──────────────────────────────────────────────────────────

describe("AdminAddJobDto validation", () => {
  it("rejects an unknown job type", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: "some-arbitrary-type",
      payload: {},
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "type")).toBe(true);
  });

  it("rejects a payload that is not an object", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_REGISTER_EMAIL,
      payload: "not-an-object",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  // ── Per-job-type payload shape ───────────────────────────────────────────

  const VALID_MONGO_ID = "507f1f77bcf86cd799439011";

  it("accepts a send-register-email payload matching its expected shape", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_REGISTER_EMAIL,
      payload: { to: "user@example.com", fullName: "Nguyen Van A" },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects a send-register-email payload with an invalid email", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_REGISTER_EMAIL,
      payload: { to: "not-an-email", fullName: "Nguyen Van A" },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("accepts a send-verification-email payload matching its expected shape", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_VERIFICATION_EMAIL,
      payload: {
        to: "user@example.com",
        token: "a".repeat(64),
        fullName: "Nguyen Van A",
      },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects a send-verification-email payload missing token", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_VERIFICATION_EMAIL,
      payload: { to: "user@example.com", fullName: "Nguyen Van A" },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("rejects a send-password-reset payload missing resetToken", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_PASSWORD_RESET,
      payload: { email: "user@example.com", fullName: "Nguyen Van A" },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("accepts a valid export-tickets payload (nested dto + requestedByUserId)", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.EXPORT_TICKETS,
      payload: {
        dto: { eventId: VALID_MONGO_ID, format: "csv" },
        requestedByUserId: VALID_MONGO_ID,
      },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects an export-tickets payload with a top-level shape instead of the nested dto/requestedByUserId shape", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.EXPORT_TICKETS,
      payload: { eventId: "abc" },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("rejects an export-tickets payload missing the nested dto entirely", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.EXPORT_TICKETS,
      payload: { requestedByUserId: VALID_MONGO_ID },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("rejects an export-checkin-zones payload missing the nested dto entirely", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.EXPORT_CHECKIN_ZONES,
      payload: { requestedByUserId: VALID_MONGO_ID },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("rejects an export-checkin-zones payload with an invalid format", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.EXPORT_CHECKIN_ZONES,
      payload: {
        dto: { eventId: VALID_MONGO_ID, format: "pdf" },
        requestedByUserId: VALID_MONGO_ID,
      },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("accepts a refund-failure-alert payload matching its expected shape", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.REFUND_FAILURE_ALERT,
      payload: {
        bookingId: VALID_MONGO_ID,
        paymentRef: "pi_123",
        source: "stripe",
        errorMessage: "Stripe refund failed",
        occurredAt: new Date().toISOString(),
      },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects a refund-failure-alert payload with an unknown source", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.REFUND_FAILURE_ALERT,
      payload: {
        bookingId: VALID_MONGO_ID,
        paymentRef: "pi_123",
        source: "momo",
        errorMessage: "Refund failed",
        occurredAt: new Date().toISOString(),
      },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("accepts a send-booking-confirmation payload matching BookingConfirmationData", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_BOOKING_CONFIRMATION,
      payload: {
        email: "user@example.com",
        customerName: "Nguyen Van A",
        bookingCode: "BK123",
        eventTitle: "Concert",
        eventLocation: "HCMC",
        eventDate: new Date().toISOString(),
        zoneName: "VIP",
        seats: ["A1", "A2"],
        quantity: 2,
        totalPrice: 500000,
        currency: "VND",
      },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects a send-booking-confirmation payload with an extra unexpected field (mass-assignment guard)", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.SEND_BOOKING_CONFIRMATION,
      payload: {
        email: "user@example.com",
        customerName: "Nguyen Van A",
        bookingCode: "BK123",
        eventTitle: "Concert",
        eventLocation: "HCMC",
        eventDate: new Date().toISOString(),
        zoneName: "VIP",
        seats: ["A1", "A2"],
        quantity: 2,
        totalPrice: 500000,
        currency: "VND",
        isAdmin: true,
      },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "payload")).toBe(true);
  });

  it("reuses the same payload shape for finalize-ticket-delivery as send-booking-confirmation", async () => {
    const dto = plainToInstance(AdminAddJobDto, {
      type: QueueJobType.FINALIZE_TICKET_DELIVERY,
      payload: {
        email: "user@example.com",
        customerName: "Nguyen Van A",
        bookingCode: "BK123",
        eventTitle: "Concert",
        eventLocation: "HCMC",
        eventDate: new Date().toISOString(),
        zoneName: "VIP",
        seats: ["A1"],
        quantity: 1,
        totalPrice: 250000,
        currency: "VND",
      },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

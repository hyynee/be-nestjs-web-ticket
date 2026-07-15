import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { AuditService, AUDIT_EXPORT_MAX_ROWS } from "./audit.service";
import { AuditLog, AuditAction } from "@src/schemas/audit-log.schema";
import { Types } from "mongoose";

const chainable = (resolved: unknown) => ({
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(resolved),
});

describe("AuditService", () => {
  let service: AuditService;
  let auditLogModel: any;

  const actorId = new Types.ObjectId().toString();
  const bookingId = new Types.ObjectId().toString();

  beforeEach(async () => {
    auditLogModel = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn(),
      findById: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
    };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getModelToken(AuditLog.name), useValue: auditLogModel },
      ],
    }).compile();

    service = module.get(AuditService);
  });

  afterEach(() => jest.restoreAllMocks());

  it("persists an audit entry with all required fields", async () => {
    await service.record({
      action: AuditAction.BOOKING_ADMIN_CANCEL,
      actorId,
      actorRole: "admin",
      bookingId,
      reason: "Event cancelled",
    });

    expect(auditLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.BOOKING_ADMIN_CANCEL,
        reason: "Event cancelled",
      })
    );
  });

  it("stores valid ObjectIds for actorId and bookingId", async () => {
    await service.record({
      action: AuditAction.TICKET_CHECKIN,
      actorId,
      bookingId,
    });

    const call = auditLogModel.create.mock.calls[0][0];
    expect(call.actorId).toBeInstanceOf(Types.ObjectId);
    expect(call.bookingId).toBeInstanceOf(Types.ObjectId);
  });

  it("does not persist undefined optional fields", async () => {
    await service.record({
      action: AuditAction.TICKET_CANCEL,
      actorId,
    });

    const call = auditLogModel.create.mock.calls[0][0];
    expect(call.bookingId).toBeUndefined();
    expect(call.eventId).toBeUndefined();
    expect(call.ticketId).toBeUndefined();
  });

  it("does not throw when DB write fails — logs error instead", async () => {
    auditLogModel.create.mockRejectedValueOnce(
      new Error("MongoDB write failed")
    );

    await expect(
      service.record({
        action: AuditAction.BOOKING_ADMIN_CANCEL,
        actorId,
      })
    ).resolves.toBeUndefined();

    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("AuditService.record failed")
    );
  });

  it("records event cancellation with eventId", async () => {
    const eventId = new Types.ObjectId().toString();
    await service.record({
      action: AuditAction.EVENT_CANCEL,
      actorId,
      actorRole: "admin",
      eventId,
      reason: "Venue issue",
    });

    const call = auditLogModel.create.mock.calls[0][0];
    expect(call.action).toBe(AuditAction.EVENT_CANCEL);
    expect(call.eventId).toBeInstanceOf(Types.ObjectId);
  });

  it("records ticket cancellation with ticketId", async () => {
    const ticketId = new Types.ObjectId().toString();
    await service.record({
      action: AuditAction.TICKET_CANCEL,
      actorId,
      actorRole: "admin",
      ticketId,
      reason: "Duplicate ticket",
    });

    const call = auditLogModel.create.mock.calls[0][0];
    expect(call.ticketId).toBeInstanceOf(Types.ObjectId);
  });

  it("includes ipAddress and metadata when provided", async () => {
    await service.record({
      action: AuditAction.BOOKING_ADMIN_CANCEL,
      actorId,
      ipAddress: "192.168.1.1",
      metadata: { note: "Admin override" },
    });

    const call = auditLogModel.create.mock.calls[0][0];
    expect(call.ipAddress).toBe("192.168.1.1");
    expect(call.metadata).toEqual({ note: "Admin override" });
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  describe("findAll", () => {
    const makeRow = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      action: AuditAction.BOOKING_CANCEL,
      actorId: {
        _id: new Types.ObjectId(actorId),
        email: "admin@x.com",
        fullName: "Admin",
        role: "admin",
      },
      bookingId: new Types.ObjectId(bookingId),
      reason: "test reason",
      ipAddress: "127.0.0.1",
      metadata: { note: "ok", resetToken: "leak-me" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    });

    it("lists audit logs with populated actor and total count", async () => {
      auditLogModel.find.mockReturnValue(chainable([makeRow()]));
      auditLogModel.countDocuments.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 } as any);

      expect(result.total).toBe(1);
      expect(result.data[0].actor.email).toBe("admin@x.com");
      expect(result.data[0].actor.role).toBe("admin");
    });

    it("redacts sensitive metadata keys before returning", async () => {
      auditLogModel.find.mockReturnValue(chainable([makeRow()]));

      const result = await service.findAll({ page: 1, limit: 20 } as any);
      expect(result.data[0].metadata?.note).toBe("ok");
      expect(result.data[0].metadata?.resetToken).toBe("***REDACTED***");
    });

    it("applies actorId/action/date filters as ObjectId / range query", async () => {
      const chain = chainable([]);
      auditLogModel.find.mockReturnValue(chain);

      await service.findAll({
        action: AuditAction.TICKET_CHECKIN,
        actorId,
        from: "2026-01-01",
        to: "2026-01-31",
        page: 1,
        limit: 20,
      } as any);

      const passedFilter = auditLogModel.find.mock.calls[0][0];
      expect(passedFilter.action).toBe(AuditAction.TICKET_CHECKIN);
      expect(passedFilter.actorId).toBeInstanceOf(Types.ObjectId);
      expect(passedFilter.createdAt.$gte).toBeInstanceOf(Date);
      expect(passedFilter.createdAt.$lte).toBeInstanceOf(Date);
    });

    it("paginates using skip/limit derived from page and limit", async () => {
      const chain = chainable([]);
      auditLogModel.find.mockReturnValue(chain);

      await service.findAll({ page: 3, limit: 10 } as any);

      expect(chain.skip).toHaveBeenCalledWith(20);
      expect(chain.limit).toHaveBeenCalledWith(10);
    });
  });

  // ── findById ──────────────────────────────────────────────────────────────

  describe("findById", () => {
    it("returns a single audit log by id", async () => {
      const row = {
        _id: new Types.ObjectId(),
        action: AuditAction.TICKET_CHECKIN,
        actorId: {
          _id: new Types.ObjectId(actorId),
          email: "a@b.com",
          role: "admin",
        },
        createdAt: new Date(),
      };
      auditLogModel.findById.mockReturnValue(chainable(row));

      const result = await service.findById(row._id.toString());
      expect(result.id).toBe(String(row._id));
    });

    it("throws BadRequestException for a malformed id", async () => {
      await expect(service.findById("not-an-object-id")).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws NotFoundException when no matching document exists", async () => {
      auditLogModel.findById.mockReturnValue(chainable(null));
      await expect(
        service.findById(new Types.ObjectId().toString())
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── exportCsv ─────────────────────────────────────────────────────────────

  describe("exportCsv", () => {
    const makeRow = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      action: AuditAction.BOOKING_CANCEL,
      actorId: {
        _id: new Types.ObjectId(actorId),
        email: "admin@x.com",
        role: "admin",
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    });

    it("exports rows as CSV including a header row", async () => {
      auditLogModel.find.mockReturnValue(chainable([makeRow()]));

      const csv = await service.exportCsv({} as any);
      expect(csv).toContain("action");
      expect(csv).toContain("booking.cancel");
    });

    it("throws BadRequestException when result set exceeds the export cap", async () => {
      const tooMany = Array.from({ length: AUDIT_EXPORT_MAX_ROWS + 1 }, () =>
        makeRow()
      );
      auditLogModel.find.mockReturnValue(chainable(tooMany));

      await expect(service.exportCsv({} as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it("never leaks resetToken/password metadata into the CSV", async () => {
      auditLogModel.find.mockReturnValue(
        chainable([makeRow({ metadata: { password: "hunter2" } })])
      );

      const csv = await service.exportCsv({} as any);
      expect(csv).not.toContain("hunter2");
    });
  });
});

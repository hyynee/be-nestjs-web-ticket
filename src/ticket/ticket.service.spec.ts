import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import { TicketService } from "./ticket.service";
import { QueryTicketDto } from "./dto/query.dto";
import { Ticket } from "@src/schemas/ticket.schema";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { CheckInLog } from "@src/schemas/checkin-log.schema";
import { TicketGateway } from "./ticket.gateway";
import { RedisService } from "@src/redis/redis.service";
import { UploadService } from "@src/upload/upload.service";
import { AuditService } from "@src/audit/audit.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import * as QRCode from "qrcode";

jest.mock("qrcode", () => ({
  toBuffer: jest.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

const makeTicket = (overrides: Record<string, any> = {}) => ({
  _id: new Types.ObjectId(),
  ticketCode: "TK123456789ABCDEF",
  status: "valid",
  userId: new Types.ObjectId(),
  zoneId: new Types.ObjectId(),
  eventId: {
    startDate: new Date(Date.now() - HOUR), // started 1h ago
    endDate: new Date(Date.now() + HOUR), // ends in 1h
  },
  isDeleted: false,
  ...overrides,
});

// Mock the .populate(...).session(...).exec() query chain from findOne.
// checkInTicket now calls findOne().populate().session(dbSession).exec()
// since the lookup was moved inside the transaction.
const chainPopulate = (resolvedValue: any) => {
  const execChain = { exec: jest.fn().mockResolvedValue(resolvedValue) };
  const sessionChain = {
    ...execChain,
    session: jest.fn().mockReturnValue(execChain),
  };
  return { populate: jest.fn().mockReturnValue(sessionChain) };
};

// Mock the .select(...).lean().exec() query chain (status lookup after failure).
// Now also supports .session() in the chain (passthrough).
const chainSelectLean = (resolvedValue: any) => {
  const leanChain = {
    lean: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(resolvedValue),
    }),
  };
  const sessionChain = {
    ...leanChain,
    session: jest.fn().mockReturnValue(leanChain),
  };
  return {
    select: jest.fn().mockReturnValue(sessionChain),
  };
};

// Build a minimal MongoDB session mock that executes the callback immediately
const makeDbSession = () => {
  const session = {
    withTransaction: jest
      .fn()
      .mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  return session;
};

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("TicketService – checkInTicket", () => {
  let service: TicketService;
  let ticketModel: any;
  let checkInLogModel: any;
  let ticketGateway: any;
  let mockAuditService: { record: jest.Mock };

  const adminId = new Types.ObjectId().toString();
  const mockCurrentUser = { userId: adminId, role: "admin" } as any;
  const ticketCode = "TK123456789ABCDEF";
  const location = "Hall A – Gate 1";
  const deviceInfo = "iPad Pro #1";
  const ipAddress = "192.168.1.10";

  beforeEach(async () => {
    const dbSession = makeDbSession();

    ticketModel = {
      findOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findOneAndUpdate: jest.fn(),
      insertMany: jest.fn(),
      bulkWrite: jest.fn(),
      find: jest.fn(),
      exists: jest.fn(),
      db: { startSession: jest.fn().mockResolvedValue(dbSession) },
    };

    checkInLogModel = {
      create: jest.fn().mockResolvedValue([{}]),
    };

    ticketGateway = {
      emitTicketCheckedIn: jest.fn(),
      emitTicketCreated: jest.fn(),
    };

    mockAuditService = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        {
          provide: getModelToken(Booking.name),
          useValue: {
            findOne: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              session: jest.fn().mockReturnThis(),
              lean: jest.fn().mockResolvedValue({
                status: "confirmed",
                paymentStatus: "paid",
              }),
            }),
          },
        },
        { provide: getModelToken(Event.name), useValue: {} },
        {
          provide: getModelToken(Zone.name),
          useValue: { updateOne: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: checkInLogModel,
        },
        { provide: TicketGateway, useValue: ticketGateway },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn().mockResolvedValue("OK"),
              eval: jest.fn().mockResolvedValue(1),
              del: jest.fn().mockResolvedValue(1),
              scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
              get: jest.fn().mockResolvedValue(null),
              sMembers: jest.fn().mockResolvedValue([]),
              sAdd: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
            scanKeys: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: UploadService,
          useValue: {
            uploadQRCodeBuffer: jest
              .fn()
              .mockResolvedValue("https://cdn.example.com/qr/TK123.png"),
            deleteQRCode: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
            hasCheckInAccess: jest.fn().mockReturnValue(true),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("successful check-in", () => {
    it("returns success and emits WebSocket event", async () => {
      const ticket = makeTicket();
      const checkedInAt = new Date();
      const updatedTicket = {
        ...ticket,
        status: "used",
        checkedInAt,
        checkInLocation: location,
      };

      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);

      const result = await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        mockCurrentUser
      );

      expect(result.success).toBe(true);
      expect(result.ticket).toEqual(updatedTicket);
    });

    it("calls findOneAndUpdate with _id AND status: 'valid' (atomic guard)", async () => {
      const ticket = makeTicket();
      const updatedTicket = { ...ticket, status: "used" };
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);

      await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        mockCurrentUser
      );

      expect(ticketModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: ticket._id, status: "valid", isDeleted: false },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "used" }),
        }),
        expect.objectContaining({ new: true }) // session is also passed
      );
    });

    it("creates a log entry with success: true", async () => {
      const ticket = makeTicket();
      const updatedTicket = { ...ticket, status: "used" };
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);

      await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        mockCurrentUser
      );

      // create() is now called with an array (first arg) and options (second arg)
      expect(checkInLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            ticketId: ticket._id,
            adminId,
            success: true,
            message: "Check-in success",
          }),
        ]),
        expect.objectContaining({ session: expect.anything() })
      );
    });

    it("emits ticket:checked-in WebSocket event after successful check-in", async () => {
      const ticket = makeTicket();
      const updatedTicket = {
        ...ticket,
        status: "used",
        checkedInAt: new Date(),
        ticketCode,
      };
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);

      await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        mockCurrentUser
      );

      expect(ticketGateway.emitTicketCheckedIn).toHaveBeenCalledWith(
        expect.objectContaining({ ticketCode })
      );
    });
  });

  // ── Authorization: organizer/staff scope ────────────────────────────────────

  describe("check-in authorization (organizer/staff scope)", () => {
    let eventOwnershipService: { hasCheckInAccess: jest.Mock };

    beforeEach(() => {
      eventOwnershipService = (service as any).eventOwnershipService;
    });

    it("allows checkin_staff assigned to the ticket's event", async () => {
      const staffUser = {
        userId: new Types.ObjectId().toString(),
        role: "checkin_staff",
      } as any;
      const ticket = makeTicket();
      const updatedTicket = { ...ticket, status: "used" };
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);
      eventOwnershipService.hasCheckInAccess.mockReturnValueOnce(true);

      const result = await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        staffUser
      );

      expect(result.success).toBe(true);
      expect(eventOwnershipService.hasCheckInAccess).toHaveBeenCalledWith(
        staffUser,
        ticket.eventId
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: staffUser.userId,
          actorRole: "checkin_staff",
        })
      );
    });

    it("records the actual actor role (organizer) in the check-in audit log, not a hardcoded admin", async () => {
      const organizerUser = {
        userId: new Types.ObjectId().toString(),
        role: "organizer",
      } as any;
      const ticket = makeTicket();
      const updatedTicket = { ...ticket, status: "used" };
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);
      eventOwnershipService.hasCheckInAccess.mockReturnValueOnce(true);

      await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        organizerUser
      );

      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: organizerUser.userId,
          actorRole: "organizer",
        })
      );
    });

    it("rejects checkin_staff not assigned to the ticket's event", async () => {
      const staffUser = { userId: "staff-2", role: "checkin_staff" } as any;
      const ticket = makeTicket();
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      eventOwnershipService.hasCheckInAccess.mockReturnValueOnce(false);

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          staffUser
        )
      ).rejects.toThrow(ForbiddenException);
      expect(ticketModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects check-in when the ticket has no eventId, before checking status", async () => {
      const ticket = makeTicket({ eventId: null });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(BadRequestException);
      expect(eventOwnershipService.hasCheckInAccess).not.toHaveBeenCalled();
    });
  });

  // ── Validation failures ────────────────────────────────────────────────────

  describe("validation failures", () => {
    it("throws BadRequestException when ticket not found or already used", async () => {
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(null));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(
        new BadRequestException("Ticket không hợp lệ hoặc đã được check-in")
      );
    });

    it("rejects check-in of a refunded ticket — status:'cancelled' throws appropriate error", async () => {
      // After handleChargeRefunded runs, tickets are set to status:'cancelled'.
      // The new checkInTicket loads the ticket regardless of status, then checks
      // status explicitly inside the transaction, giving a precise error message.
      const cancelledTicket = makeTicket({ status: "cancelled" });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(cancelledTicket));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(
        new BadRequestException("Vé không hợp lệ vì đã bị hủy hoặc hoàn tiền")
      );
    });

    it("throws BadRequestException when event has not started yet", async () => {
      const ticket = makeTicket({
        eventId: {
          startDate: new Date(Date.now() + 24 * HOUR),
          endDate: new Date(Date.now() + 48 * HOUR),
        },
      });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(
        new BadRequestException("Sự kiện chưa bắt đầu, không thể check-in")
      );
    });

    it("throws BadRequestException and expires ticket when event has ended", async () => {
      const ticket = makeTicket({
        eventId: {
          startDate: new Date(Date.now() - 2 * HOUR),
          endDate: new Date(Date.now() - HOUR),
        },
      });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(
        new BadRequestException("Sự kiện đã kết thúc, vé đã hết hạn")
      );
    });

    it("throws BadRequestException when ticket has no eventId", async () => {
      const ticket = makeTicket({ eventId: null });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(new BadRequestException("Event not found"));
    });
  });

  // ── Expire path race condition ─────────────────────────────────────────────

  describe("expire path – race condition guard", () => {
    it("expire updateOne MUST include status: 'valid' to prevent overwriting checked-in ticket", async () => {
      const ticket = makeTicket({
        eventId: {
          startDate: new Date(Date.now() - 2 * HOUR),
          endDate: new Date(Date.now() - 1000),
        },
      });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow();

      expect(ticketModel.updateOne).toHaveBeenCalledWith(
        { _id: ticket._id, status: "valid", isDeleted: false },
        { $set: { status: "expired" } },
        expect.objectContaining({ session: expect.anything() })
      );

      expect(ticketModel.updateOne).not.toHaveBeenCalledWith(
        { _id: ticket._id },
        expect.any(Object)
      );
    });

    it("expires ticket only when status is still 'valid', not when already 'used'", async () => {
      const ticket = makeTicket({
        eventId: {
          startDate: new Date(Date.now() - 2 * HOUR),
          endDate: new Date(Date.now() - 1000),
        },
      });
      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(BadRequestException);

      expect(ticketModel.updateOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── Double check-in scenarios ──────────────────────────────────────────────

  describe("double check-in", () => {
    it("throws 'Vé đã được check-in bởi thiết bị khác' when another device checked in first", async () => {
      const ticket = makeTicket();
      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));

      ticketModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(
        new BadRequestException("Vé đã được check-in bởi thiết bị khác")
      );
    });

    it("creates a failure log with accurate message when duplicate check-in detected", async () => {
      const ticket = makeTicket();
      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow();

      expect(checkInLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            ticketId: ticket._id,
            success: false,
            message: "Failed: already used by another device",
          }),
        ]),
        expect.objectContaining({ session: expect.anything() })
      );
    });

    it("throws 'Vé đã hết hạn' (not wrong error) when concurrent request expired the ticket", async () => {
      const ticket = makeTicket();
      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "expired" }));

      ticketModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(new BadRequestException("Vé đã hết hạn"));

      expect(checkInLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            success: false,
            message: "Failed: ticket expired concurrently",
          }),
        ]),
        expect.objectContaining({ session: expect.anything() })
      );
    });

    it("does NOT emit WebSocket event when check-in fails", async () => {
      const ticket = makeTicket();
      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow();

      expect(ticketGateway.emitTicketCheckedIn).not.toHaveBeenCalled();
    });
  });

  // ── Concurrent double check-in simulation ─────────────────────────────────

  describe("concurrent double check-in – atomic guard via Promise.allSettled", () => {
    it("only the first concurrent request succeeds, second gets rejected", async () => {
      const ticket = makeTicket();
      const updatedTicket = {
        ...ticket,
        status: "used",
        checkedInAt: new Date(),
      };

      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));

      ticketModel.findOneAndUpdate
        .mockResolvedValueOnce(updatedTicket)
        .mockResolvedValueOnce(null);

      const [r1, r2] = await Promise.allSettled([
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        ),
        service.checkInTicket(
          ticketCode,
          location,
          "Device 2",
          "127.0.0.2",
          mockCurrentUser
        ),
      ]);

      expect(r1.status).toBe("fulfilled");
      expect((r1 as PromiseFulfilledResult<any>).value.success).toBe(true);

      expect(r2.status).toBe("rejected");
      expect((r2 as PromiseRejectedResult).reason).toBeInstanceOf(
        BadRequestException
      );
    });

    it("findOneAndUpdate is called with status: 'valid' guard on BOTH concurrent requests", async () => {
      const ticket = makeTicket();
      const updatedTicket = { ...ticket, status: "used" };

      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));

      ticketModel.findOneAndUpdate
        .mockResolvedValueOnce(updatedTicket)
        .mockResolvedValueOnce(null);

      await Promise.allSettled([
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        ),
        service.checkInTicket(
          ticketCode,
          location,
          "Device 2",
          "127.0.0.2",
          mockCurrentUser
        ),
      ]);

      expect(ticketModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(ticketModel.findOneAndUpdate).toHaveBeenNthCalledWith(
        1,
        { _id: ticket._id, status: "valid", isDeleted: false },
        expect.any(Object),
        expect.objectContaining({ new: true })
      );
      expect(ticketModel.findOneAndUpdate).toHaveBeenNthCalledWith(
        2,
        { _id: ticket._id, status: "valid", isDeleted: false },
        expect.any(Object),
        expect.objectContaining({ new: true })
      );
    });

    it("exactly one success log and one failure log created across two concurrent requests", async () => {
      const ticket = makeTicket();
      const updatedTicket = { ...ticket, status: "used" };

      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));

      ticketModel.findOneAndUpdate
        .mockResolvedValueOnce(updatedTicket)
        .mockResolvedValueOnce(null);

      await Promise.allSettled([
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        ),
        service.checkInTicket(
          ticketCode,
          location,
          "Device 2",
          "127.0.0.2",
          mockCurrentUser
        ),
      ]);

      expect(checkInLogModel.create).toHaveBeenCalledTimes(2);

      const logCalls = checkInLogModel.create.mock.calls.map(
        ([arrArg]: [any[]]) => (Array.isArray(arrArg) ? arrArg[0] : arrArg)
      );
      const successLogs = logCalls.filter((l: any) => l?.success === true);
      const failureLogs = logCalls.filter((l: any) => l?.success === false);

      expect(successLogs).toHaveLength(1);
      expect(failureLogs).toHaveLength(1);
    });
  });

  // ── Post-transaction fallback guard (line 496) ─────────────────────────

  describe("post-transaction null updatedTicket guard", () => {
    it("throws BadRequestException when updatedTicket is null after transaction", async () => {
      const ticket = makeTicket();
      const swallowSession = {
        withTransaction: jest
          .fn()
          .mockImplementation(async (fn: () => Promise<unknown>) => {
            try {
              return await fn();
            } catch {
              return null;
            }
          }),
        endSession: jest.fn().mockResolvedValue(undefined),
      };
      ticketModel.db.startSession.mockResolvedValue(swallowSession);

      ticketModel.findOne
        .mockReturnValueOnce(chainPopulate(ticket))
        .mockReturnValueOnce(chainSelectLean({ status: "used" }));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.checkInTicket(
          ticketCode,
          location,
          deviceInfo,
          ipAddress,
          mockCurrentUser
        )
      ).rejects.toThrow(
        new BadRequestException("Ticket không hợp lệ hoặc đã được check-in")
      );
    });
  });

  // ── Audit service failure (line 522) ───────────────────────────────────

  describe("audit service failure", () => {
    it("handles audit record rejection gracefully", async () => {
      const ticket = makeTicket();
      const updatedTicket = {
        ...ticket,
        status: "used",
        checkedInAt: new Date(),
        checkInLocation: location,
      };

      ticketModel.findOne.mockReturnValueOnce(chainPopulate(ticket));
      ticketModel.findOneAndUpdate.mockResolvedValueOnce(updatedTicket);
      mockAuditService.record.mockRejectedValue(
        new Error("Audit DB unavailable")
      );

      const result = await service.checkInTicket(
        ticketCode,
        location,
        deviceInfo,
        ipAddress,
        mockCurrentUser
      );

      expect(result.success).toBe(true);
      expect(result.ticket).toEqual(updatedTicket);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelTicket — inventory restore (BLOCKER 2 regression tests)
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – cancelTicket inventory restore", () => {
  let service: TicketService;
  let ticketModel: any;
  let zoneModel: any;
  let bookingModel: any;
  let uploadService: any;

  const userId = new Types.ObjectId().toString();
  const ticketCode = "TKCANCEL123ABC";
  const zoneId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();

  beforeEach(async () => {
    const dbSession = makeDbSession();

    const cancelledTicket = {
      _id: new Types.ObjectId(),
      ticketCode,
      status: "cancelled",
      zoneId,
      bookingId,
      areaId: null,
      seatNumber: "A1",
    };

    ticketModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ bookingId }),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue(cancelledTicket),
      countDocuments: jest.fn().mockResolvedValue(0),
      db: { startSession: jest.fn().mockResolvedValue(dbSession) },
    };

    zoneModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    bookingModel = {
      // Default: pending+unpaid so the pre-check (bookingCheck) passes through.
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest
          .fn()
          .mockResolvedValue({ status: "pending", paymentStatus: "unpaid" }),
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    uploadService = {
      uploadQRCodeBuffer: jest
        .fn()
        .mockResolvedValue("https://cdn.example.com/qr/TK.png"),
      deleteQRCode: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Event.name), useValue: {} },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn() },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn().mockResolvedValue("OK"),
              eval: jest.fn().mockResolvedValue(1),
              del: jest.fn().mockResolvedValue(1),
              get: jest.fn().mockResolvedValue(null),
              sMembers: jest.fn().mockResolvedValue([]),
              sAdd: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
          },
        },
        {
          provide: UploadService,
          useValue: uploadService,
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  it("decrements soldCount by 1 when ticket is cancelled", async () => {
    await service.cancelTicket(ticketCode, userId);
    expect(zoneModel.updateOne).toHaveBeenCalledWith(
      { _id: zoneId },
      expect.arrayContaining([
        expect.objectContaining({
          $set: expect.objectContaining({ soldCount: expect.anything() }),
        }),
      ]),
      expect.any(Object)
    );
  });

  it("throws BadRequestException when booking is CONFIRMED+PAID (blocks individual cancellation)", async () => {
    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockResolvedValue({ status: "confirmed", paymentStatus: "paid" }),
    });

    await expect(service.cancelTicket(ticketCode, userId)).rejects.toThrow(
      BadRequestException
    );
    // Zone inventory must NOT be touched
    expect(zoneModel.updateOne).not.toHaveBeenCalled();
  });

  it("only decrements soldCount (not confirmedSoldCount) for pending bookings", async () => {
    // Default mock is already pending+unpaid — just verify only one updateOne call
    await service.cancelTicket(ticketCode, userId);
    expect(zoneModel.updateOne).toHaveBeenCalledTimes(1);
  });

  it("throws BadRequestException when ticket is already cancelled", async () => {
    ticketModel.findOne.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });
    await expect(service.cancelTicket(ticketCode, userId)).rejects.toThrow(
      BadRequestException
    );
  });

  it("returns success with ticketCode and seatNumber", async () => {
    const result = await service.cancelTicket(ticketCode, userId);
    expect(result.success).toBe(true);
    expect(result.ticket.ticketCode).toBe(ticketCode);
  });

  it("calls deleteQRCode asynchronously (does not block)", async () => {
    await service.cancelTicket(ticketCode, userId);
    expect(uploadService.deleteQRCode).toHaveBeenCalledWith(ticketCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllTickets aggregation
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – getAllTickets aggregation", () => {
  let service: TicketService;
  let ticketModel: any;
  let redisClient: any;
  const adminUser = {
    userId: new Types.ObjectId().toString(),
    role: "admin",
  } as any;

  beforeEach(async () => {
    const mockDbSession = makeDbSession();

    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
      get: jest.fn().mockResolvedValue(null),
      sMembers: jest.fn().mockResolvedValue([]),
      sAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    };

    ticketModel = {
      findOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findOneAndUpdate: jest.fn(),
      insertMany: jest.fn(),
      bulkWrite: jest.fn(),
      find: jest.fn(),
      exists: jest.fn(),
      aggregate: jest.fn().mockResolvedValue([]),
      countDocuments: jest.fn().mockResolvedValue(0),
      db: { startSession: jest.fn().mockResolvedValue(mockDbSession) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        {
          provide: getModelToken(Booking.name),
          useValue: {
            findOne: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              session: jest.fn().mockReturnThis(),
              lean: jest.fn().mockResolvedValue({
                status: "confirmed",
                paymentStatus: "paid",
              }),
            }),
          },
        },
        { provide: getModelToken(Event.name), useValue: {} },
        {
          provide: getModelToken(Zone.name),
          useValue: { updateOne: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn().mockResolvedValue([{}]) },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: { client: redisClient },
        },
        {
          provide: UploadService,
          useValue: {
            uploadQRCodeBuffer: jest
              .fn()
              .mockResolvedValue("https://cdn.example.com/qr/TK123.png"),
            deleteQRCode: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  it("uses aggregate() not find().populate() — verifies N+1 fix is in place", async () => {
    const query: QueryTicketDto = {
      page: 1,
      limit: 10,
      sortBy: "createdAt",
      sortOrder: "desc",
    };

    await service.getAllTickets(query, adminUser);

    expect(ticketModel.aggregate).toHaveBeenCalledTimes(1);
    expect(ticketModel.find).not.toHaveBeenCalled();
  });

  it("aggregate pipeline includes $lookup stages for all 7 referenced collections", async () => {
    const query: QueryTicketDto = {
      page: 1,
      limit: 10,
      sortBy: "createdAt",
      sortOrder: "desc",
    };

    await service.getAllTickets(query, adminUser);

    const pipeline: any[] = ticketModel.aggregate.mock.calls[0][0];
    const lookupFroms = pipeline
      .filter((s: any) => s.$lookup)
      .map((s: any) => s.$lookup.from);

    expect(lookupFroms).toContain("events");
    expect(lookupFroms).toContain("bookings");
    expect(lookupFroms).toContain("zones");
    expect(lookupFroms).toContain("areas");
    expect(lookupFroms).toContain("users");
    expect(lookupFroms.filter((f: string) => f === "users")).toHaveLength(3);
  });

  it("returns correct pagination meta from countDocuments and aggregate results", async () => {
    ticketModel.aggregate.mockResolvedValueOnce([{ _id: "t1" }, { _id: "t2" }]);
    ticketModel.countDocuments.mockResolvedValueOnce(25);

    const result = await service.getAllTickets(
      {
        page: 2,
        limit: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      },
      adminUser
    );

    expect(result.meta.currentPage).toBe(2);
    expect(result.meta.totalItems).toBe(25);
    expect(result.meta.totalPages).toBe(3);
    expect(result.items).toHaveLength(2);
  });

  it("returns cached data when cache hits", async () => {
    const cached = { items: [], meta: { totalItems: 0 } };
    redisClient.get.mockResolvedValueOnce(JSON.stringify(cached));

    const result = await service.getAllTickets(
      {
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      },
      adminUser
    );

    expect(result).toEqual(cached);
    expect(ticketModel.aggregate).not.toHaveBeenCalled();
  });

  it("stores result in cache after DB query", async () => {
    ticketModel.aggregate.mockResolvedValueOnce([]);
    ticketModel.countDocuments.mockResolvedValueOnce(0);

    await service.getAllTickets(
      {
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      },
      adminUser
    );

    expect(redisClient.set).toHaveBeenCalled();
    expect(redisClient.sAdd).toHaveBeenCalled();
    expect(redisClient.expire).toHaveBeenCalled();
  });

  it("builds filter with eventId, zoneId, areaId, userId, status", async () => {
    ticketModel.aggregate.mockResolvedValueOnce([]);
    ticketModel.countDocuments.mockResolvedValueOnce(0);

    const eventId = new Types.ObjectId().toString();
    const zoneId = new Types.ObjectId().toString();
    const areaId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();

    await service.getAllTickets(
      {
        eventId,
        zoneId,
        areaId,
        userId,
        status: "valid",
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      },
      adminUser
    );

    const pipeline: any[] = ticketModel.aggregate.mock.calls[0][0];
    const matchStage = pipeline[0];
    expect(matchStage.$match.eventId).toEqual(expect.any(Types.ObjectId));
    expect(matchStage.$match.zoneId).toEqual(expect.any(Types.ObjectId));
    expect(matchStage.$match.areaId).toEqual(expect.any(Types.ObjectId));
    expect(matchStage.$match.userId).toEqual(expect.any(Types.ObjectId));
    expect(matchStage.$match.status).toBe("valid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateTicket — event window checks
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – validateTicket", () => {
  let service: TicketService;
  let ticketModel: any;

  const userId = new Types.ObjectId().toString();
  const ticketCode = "TK_VALIDATE";
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    ticketModel = {
      findOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
      findOneAndUpdate: jest.fn(),
      insertMany: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      aggregate: jest.fn().mockResolvedValue([]),
      db: {
        startSession: jest.fn().mockResolvedValue({
          withTransaction: jest.fn(async (fn: any) => fn()),
          endSession: jest.fn(),
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        {
          provide: getModelToken(Booking.name),
          useValue: {
            findOne: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              session: jest.fn().mockReturnThis(),
              lean: jest.fn().mockResolvedValue({
                status: "confirmed",
                paymentStatus: "paid",
              }),
            }),
          },
        },
        { provide: getModelToken(Event.name), useValue: {} },
        {
          provide: getModelToken(Zone.name),
          useValue: { updateOne: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn() },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn().mockResolvedValue("OK"),
              eval: jest.fn().mockResolvedValue(1),
              del: jest.fn().mockResolvedValue(1),
              get: jest.fn().mockResolvedValue(null),
              sMembers: jest.fn().mockResolvedValue([]),
              sAdd: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
          },
        },
        {
          provide: UploadService,
          useValue: {
            uploadQRCodeBuffer: jest
              .fn()
              .mockResolvedValue("https://cdn.example.com/qr/TK.png"),
            deleteQRCode: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
            hasCheckInAccess: jest
              .fn()
              .mockImplementation((user: any) => user.role === "admin"),
          },
        },
      ],
    }).compile();
    service = module.get(TicketService);
  });

  it("returns valid:true for a valid ticket during event window", async () => {
    const ticket = {
      status: "valid",
      userId: new Types.ObjectId(userId),
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "user",
    } as any);
    expect(result.valid).toBe(true);
  });

  it("returns valid:false for a used ticket", async () => {
    const ticket = {
      status: "used",
      userId: new Types.ObjectId(userId),
      checkedInAt: new Date(),
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "user",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("đã được sử dụng");
  });

  it("returns valid:false for a cancelled ticket", async () => {
    const ticket = {
      status: "cancelled",
      userId: new Types.ObjectId(userId),
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "user",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("bị hủy");
  });

  it("returns valid:false for an expired ticket", async () => {
    const ticket = {
      status: "expired",
      userId: new Types.ObjectId(userId),
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "user",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("hết hạn");
  });

  it("returns valid:false when event has not started", async () => {
    const ticket = {
      status: "valid",
      userId: new Types.ObjectId(userId),
      eventId: {
        startDate: new Date(Date.now() + HOUR),
        endDate: new Date(Date.now() + 2 * HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "user",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("chưa bắt đầu");
  });

  it("returns valid:false when event has ended", async () => {
    const ticket = {
      status: "valid",
      userId: new Types.ObjectId(userId),
      eventId: {
        startDate: new Date(Date.now() - 2 * HOUR),
        endDate: new Date(Date.now() - HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "user",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("đã kết thúc");
  });

  it("allows admin to validate any ticket regardless of userId", async () => {
    const otherUserId = new Types.ObjectId();
    const ticket = {
      status: "valid",
      userId: otherUserId,
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    const result = await service.validateTicket(ticketCode, {
      userId,
      role: "admin",
    } as any);
    expect(result.valid).toBe(true);
  });

  it("allows checkin_staff with hasCheckInAccess to validate another user's ticket", async () => {
    const otherUserId = new Types.ObjectId();
    const ticket = {
      status: "valid",
      userId: otherUserId,
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });

    const staffUser = { userId, role: "checkin_staff" } as any;
    const eventOwnershipService = (service as any).eventOwnershipService;
    eventOwnershipService.hasCheckInAccess.mockReturnValueOnce(true);

    const result = await service.validateTicket(ticketCode, staffUser);
    expect(result.valid).toBe(true);
    expect(eventOwnershipService.hasCheckInAccess).toHaveBeenCalledWith(
      staffUser,
      ticket.eventId
    );
  });

  it("rejects checkin_staff not assigned to the ticket's event", async () => {
    const otherUserId = new Types.ObjectId();
    const ticket = {
      status: "valid",
      userId: otherUserId,
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });

    const staffUser = { userId, role: "checkin_staff" } as any;
    const eventOwnershipService = (service as any).eventOwnershipService;
    eventOwnershipService.hasCheckInAccess.mockReturnValueOnce(false);

    await expect(service.validateTicket(ticketCode, staffUser)).rejects.toThrow(
      ForbiddenException
    );
  });

  it("throws ForbiddenException when non-admin tries to validate another user's ticket", async () => {
    const otherUserId = new Types.ObjectId();
    const ticket = {
      status: "valid",
      userId: otherUserId,
      eventId: {
        startDate: new Date(Date.now() - HOUR),
        endDate: new Date(Date.now() + HOUR),
      },
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    await expect(
      service.validateTicket(ticketCode, { userId, role: "user" } as any)
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws BadRequestException when ticket not found", async () => {
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    });
    await expect(
      service.validateTicket(ticketCode, { userId, role: "user" } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when event not found on ticket", async () => {
    const ticket = {
      status: "valid",
      userId: new Types.ObjectId(userId),
      eventId: null,
    };
    ticketModel.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(ticket),
    });
    await expect(
      service.validateTicket(ticketCode, { userId, role: "user" } as any)
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTicketsFromBooking
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – createTicketsFromBooking", () => {
  let service: TicketService;
  let ticketModel: any;
  let bookingModel: any;
  let redisClient: any;
  let ticketGateway: any;
  let uploadService: any;

  const userId = new Types.ObjectId().toString();
  const bookingId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();
  const eventId = new Types.ObjectId();
  const bookingCode = "BK001";

  const makePopulatedZone = (id: Types.ObjectId, hasSeating: boolean) => ({
    _id: id,
    id: id.toHexString(),
    hasSeating,
    toHexString: jest.fn(() => id.toHexString()),
  });

  const makeBooking = (overrides: Record<string, any> = {}) => ({
    _id: bookingId,
    bookingCode,
    userId: new Types.ObjectId(userId),
    status: BookingStatus.CONFIRMED,
    eventId,
    zoneId: makePopulatedZone(zoneId, true),
    areaId: new Types.ObjectId(),
    seats: ["A1", "A2"],
    quantity: 2,
    pricePerTicket: 100,
    ...overrides,
  });

  beforeEach(async () => {
    const dbSession = makeDbSession();

    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      sMembers: jest.fn().mockResolvedValue([]),
      sAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    };

    ticketModel = {
      find: jest.fn(),
      insertMany: jest.fn(),
      db: { startSession: jest.fn().mockResolvedValue(dbSession) },
    };

    bookingModel = {
      findOne: jest.fn(),
    };

    ticketGateway = {
      emitTicketCreated: jest.fn(),
      emitTicketCheckedIn: jest.fn(),
    };

    uploadService = {
      uploadQRCodeBuffer: jest
        .fn()
        .mockResolvedValue("https://cdn.example.com/qr/TK.png"),
      deleteQRCode: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Event.name), useValue: {} },
        {
          provide: getModelToken(Zone.name),
          useValue: { updateOne: jest.fn() },
        },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn() },
        },
        { provide: TicketGateway, useValue: ticketGateway },
        { provide: RedisService, useValue: { client: redisClient } },
        { provide: UploadService, useValue: uploadService },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  const mockFindSessionChain = (result: any) => ({
    session: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(result),
    }),
  });

  const mockBookingFindOne = (booking: any) => {
    bookingModel.findOne.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(booking),
    });
  };

  it("throws BadRequestException when booking code is invalid", async () => {
    mockBookingFindOne(null);
    await expect(service.createTicketsFromBooking(bookingCode)).rejects.toThrow(
      BadRequestException
    );
  });

  it("throws ForbiddenException when user does not own the booking", async () => {
    const booking = makeBooking({ userId: new Types.ObjectId() });
    mockBookingFindOne(booking);
    await expect(
      service.createTicketsFromBooking(bookingCode, undefined, userId)
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws BadRequestException when booking is not confirmed", async () => {
    const booking = makeBooking({ status: BookingStatus.PENDING });
    mockBookingFindOne(booking);
    await expect(
      service.createTicketsFromBooking(bookingCode, undefined, userId)
    ).rejects.toThrow(BadRequestException);
  });

  it("acquires lock and creates tickets for seated zone with seats", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([])) // lock check
      .mockReturnValueOnce(mockFindSessionChain([])); // idempotency check
    jest
      .spyOn(service as any, "generateQRCode")
      .mockResolvedValue("https://cdn.example.com/qr/TK.png");
    const createdTickets = [
      { ticketCode: "TK1", eventId, zoneId },
      { ticketCode: "TK2", eventId, zoneId },
    ];
    ticketModel.insertMany.mockResolvedValueOnce(createdTickets);

    const result = await service.createTicketsFromBooking(
      bookingCode,
      undefined,
      userId
    );

    expect(result).toEqual(createdTickets);
    expect(ticketModel.insertMany).toHaveBeenCalledTimes(1);
    expect(ticketGateway.emitTicketCreated).toHaveBeenCalled();
  });

  it("acquires lock and creates tickets for non-seated zone", async () => {
    const booking = makeBooking({
      zoneId: makePopulatedZone(zoneId, false),
      seats: [],
    });
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([]))
      .mockReturnValueOnce(mockFindSessionChain([]));
    jest
      .spyOn(service as any, "generateQRCode")
      .mockResolvedValue("https://cdn.example.com/qr/TK.png");
    const createdTickets = [
      { ticketCode: "TK1", eventId, zoneId },
      { ticketCode: "TK2", eventId, zoneId },
    ];
    ticketModel.insertMany.mockResolvedValueOnce(createdTickets);

    const result = await service.createTicketsFromBooking(
      bookingCode,
      undefined,
      userId
    );

    expect(result).toEqual(createdTickets);
    expect(ticketModel.insertMany).toHaveBeenCalledTimes(1);
  });

  it("lock not acquired, existing tickets found → returns existing", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce(null);
    const existingTickets = [{ ticketCode: "EXISTING1" }];
    ticketModel.find.mockReturnValueOnce(mockFindSessionChain(existingTickets));

    const result = await service.createTicketsFromBooking(
      bookingCode,
      undefined,
      userId
    );

    expect(result).toEqual(existingTickets);
    expect(ticketModel.insertMany).not.toHaveBeenCalled();
  });

  it("lock not acquired, no existing tickets → ConflictException", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce(null);
    ticketModel.find.mockReturnValueOnce(mockFindSessionChain([]));

    await expect(
      service.createTicketsFromBooking(bookingCode, undefined, userId)
    ).rejects.toThrow(ConflictException);
  });

  it("idempotency: existing tickets found before creation → returns existing", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find.mockReturnValueOnce(
      mockFindSessionChain([{ ticketCode: "EXISTING1" }])
    );

    const result = await service.createTicketsFromBooking(
      bookingCode,
      undefined,
      userId
    );

    expect(result).toEqual([{ ticketCode: "EXISTING1" }]);
    expect(ticketModel.insertMany).not.toHaveBeenCalled();
  });

  it("E11000 on insertMany → fallback and return existing", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([]))
      .mockReturnValueOnce(mockFindSessionChain([{ ticketCode: "FALLBACK" }]));
    jest
      .spyOn(service as any, "generateQRCode")
      .mockResolvedValue("https://cdn.example.com/qr/TK.png");
    const err = new Error("E11000 duplicate") as any;
    err.code = 11000;
    ticketModel.insertMany.mockRejectedValueOnce(err);

    const result = await service.createTicketsFromBooking(
      bookingCode,
      undefined,
      userId
    );

    expect(result).toEqual([{ ticketCode: "FALLBACK" }]);
  });

  it("publishes ticket creation via gateway when no session", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([]))
      .mockReturnValueOnce(mockFindSessionChain([]));
    jest
      .spyOn(service as any, "generateQRCode")
      .mockResolvedValue("https://cdn.example.com/qr/TK.png");
    ticketModel.insertMany.mockResolvedValueOnce([{ ticketCode: "TK1" }]);

    await service.createTicketsFromBooking(bookingCode, undefined, userId);

    expect(ticketGateway.emitTicketCreated).toHaveBeenCalled();
  });

  it("executes generateQRCode real implementation with mocked QRCode and uploadService", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([]))
      .mockReturnValueOnce(mockFindSessionChain([]));
    (QRCode.toBuffer as jest.Mock).mockResolvedValue(
      Buffer.from("fake-png-data")
    );
    const createdTickets = [{ ticketCode: "TK_QR1" }, { ticketCode: "TK_QR2" }];
    ticketModel.insertMany.mockResolvedValueOnce(createdTickets);

    const result = await service.createTicketsFromBooking(
      bookingCode,
      undefined,
      userId
    );

    expect(result).toEqual(createdTickets);
    expect(QRCode.toBuffer).toHaveBeenCalled();
    expect(uploadService.uploadQRCodeBuffer).toHaveBeenCalled();
  });

  it("throws BadRequestException when QR code generation fails", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([]))
      .mockReturnValueOnce(mockFindSessionChain([]));
    (QRCode.toBuffer as jest.Mock).mockRejectedValue(
      new Error("QR lib failure")
    );

    await expect(
      service.createTicketsFromBooking(bookingCode, undefined, userId)
    ).rejects.toThrow(BadRequestException);
  });

  it("re-throws error when E11000 occurs and no existing tickets found", async () => {
    const booking = makeBooking();
    mockBookingFindOne(booking);
    redisClient.set.mockResolvedValueOnce("OK");
    ticketModel.find
      .mockReturnValueOnce(mockFindSessionChain([]))
      .mockReturnValueOnce(mockFindSessionChain([]));
    jest
      .spyOn(service as any, "generateQRCode")
      .mockResolvedValue("https://cdn.example.com/qr/TK.png");
    const err = new Error("E11000 duplicate key") as any;
    err.code = 11000;
    ticketModel.insertMany.mockRejectedValueOnce(err);

    await expect(
      service.createTicketsFromBooking(bookingCode, undefined, userId)
    ).rejects.toThrow("E11000 duplicate key");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCheckInHistory
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – getCheckInHistory", () => {
  let service: TicketService;
  let ticketModel: any;
  let checkInLogModel: any;
  let mockEventOwnershipService: any;

  beforeEach(async () => {
    const dbSession = makeDbSession();

    mockEventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };

    ticketModel = {
      findOne: jest.fn(),
      aggregate: jest.fn(),
      db: { startSession: jest.fn().mockResolvedValue(dbSession) },
    };

    checkInLogModel = {
      aggregate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        {
          provide: getModelToken(Booking.name),
          useValue: { findOne: jest.fn() },
        },
        { provide: getModelToken(Event.name), useValue: {} },
        {
          provide: getModelToken(Zone.name),
          useValue: { updateOne: jest.fn() },
        },
        { provide: getModelToken(CheckInLog.name), useValue: checkInLogModel },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn(),
              eval: jest.fn(),
              del: jest.fn(),
              get: jest.fn(),
              sMembers: jest.fn(),
              sAdd: jest.fn(),
              expire: jest.fn(),
            },
          },
        },
        {
          provide: UploadService,
          useValue: { uploadQRCodeBuffer: jest.fn(), deleteQRCode: jest.fn() },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: EventOwnershipService,
          useValue: mockEventOwnershipService,
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  it("throws BadRequestException when ticket not found", async () => {
    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      }),
    });

    await expect(
      service.getCheckInHistory("NONEXISTENT", {
        userId: "admin-1",
        role: "admin",
      } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("returns event title and check-in logs", async () => {
    const ticketId = new Types.ObjectId();
    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: ticketId,
            eventId: new Types.ObjectId(),
          }),
        }),
      }),
    });
    ticketModel.aggregate.mockResolvedValueOnce([{ eventTitle: "Concert" }]);
    checkInLogModel.aggregate.mockResolvedValueOnce([
      { success: true, createdAt: new Date() },
    ]);

    const result = await service.getCheckInHistory("TK001", {
      userId: "admin-1",
      role: "admin",
    } as any);

    expect(result.ticketCode).toBe("TK001");
    expect(result.eventTitle).toBe("Concert");
    expect(result.history).toHaveLength(1);
  });

  it("checks event ownership before returning history", async () => {
    const ticketId = new Types.ObjectId();
    const eventObjectId = new Types.ObjectId();
    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: ticketId,
            eventId: eventObjectId,
          }),
        }),
      }),
    });
    ticketModel.aggregate.mockResolvedValueOnce([{ eventTitle: "Concert" }]);
    checkInLogModel.aggregate.mockResolvedValueOnce([]);

    const currentUser = { userId: "organizer-1", role: "organizer" } as any;
    await service.getCheckInHistory("TK001", currentUser);

    expect(mockEventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
      currentUser,
      eventObjectId.toString()
    );
  });

  it("propagates ForbiddenException from the ownership check", async () => {
    const { ForbiddenException } = require("@nestjs/common");
    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(),
            eventId: new Types.ObjectId(),
          }),
        }),
      }),
    });
    mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
      new ForbiddenException("nope")
    );

    await expect(
      service.getCheckInHistory("TK001", {
        userId: "stranger-1",
        role: "organizer",
      } as any)
    ).rejects.toThrow(ForbiddenException);
    expect(ticketModel.aggregate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelTicket — booking status pre-check (Fix 4)
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – cancelTicket", () => {
  let service: TicketService;
  let ticketModel: any;
  let bookingModel: any;
  let zoneModel: any;
  let redisService: any;
  let mockUploadService: { deleteQRCode: jest.Mock };

  const userId = new Types.ObjectId().toString();
  const ticketCode = "TK_CANCEL_TEST";
  const zoneId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();

  const makeDbSession = () => ({
    withTransaction: jest
      .fn()
      .mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(async () => {
    ticketModel = {
      db: { startSession: jest.fn() },
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
    };

    bookingModel = {
      findById: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };

    zoneModel = {
      updateOne: jest.fn().mockResolvedValue({}),
    };

    mockUploadService = {
      deleteQRCode: jest.fn().mockResolvedValue(undefined),
    };

    redisService = {
      client: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue("OK"),
        sAdd: jest.fn().mockResolvedValue(1),
        sMembers: jest.fn().mockResolvedValue([]),
        del: jest.fn().mockResolvedValue(0),
        expire: jest.fn().mockResolvedValue(1),
        eval: jest.fn().mockResolvedValue(1),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        {
          provide: getModelToken(Event.name),
          useValue: { findOne: jest.fn() },
        },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn() },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCreated: jest.fn(),
            emitTicketCheckedIn: jest.fn(),
          },
        },
        { provide: RedisService, useValue: redisService },
        { provide: UploadService, useValue: mockUploadService },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  it("throws BadRequestException when ticket not found", async () => {
    const dbSession = makeDbSession();
    ticketModel.db.startSession.mockResolvedValue(dbSession);

    // findOne returns null (ticket not found / not owned by user)
    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });

    await expect(service.cancelTicket(ticketCode, userId)).rejects.toThrow(
      BadRequestException
    );
  });

  it("throws BadRequestException when booking is CONFIRMED+PAID", async () => {
    const dbSession = makeDbSession();
    ticketModel.db.startSession.mockResolvedValue(dbSession);

    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ bookingId }),
    });

    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        status: BookingStatus.CONFIRMED,
        paymentStatus: "paid",
      }),
    });

    await expect(service.cancelTicket(ticketCode, userId)).rejects.toThrow(
      BadRequestException
    );
  });

  it("cancels ticket when booking is PENDING+UNPAID", async () => {
    const dbSession = makeDbSession();
    ticketModel.db.startSession.mockResolvedValue(dbSession);

    const cancelledTicket = {
      _id: new Types.ObjectId(),
      ticketCode,
      userId: new Types.ObjectId(userId),
      bookingId,
      zoneId: new Types.ObjectId(),
      status: "cancelled",
    };

    // First findOne (pre-check) returns ticket info
    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ bookingId }),
    });

    // findById for booking check returns PENDING+UNPAID
    bookingModel.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      })
      // second findById for isConfirmedAndPaid check (inside cancelTicket after findOneAndUpdate)
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      });

    ticketModel.findOneAndUpdate.mockResolvedValue(cancelledTicket);
    zoneModel.updateOne.mockResolvedValue({});

    const result = await service.cancelTicket(ticketCode, userId);

    expect(result.success).toBe(true);
    expect(ticketModel.findOneAndUpdate).toHaveBeenCalled();
    expect(zoneModel.updateOne).toHaveBeenCalled();
  });

  it("throws BadRequestException when findOneAndUpdate returns null (race condition)", async () => {
    const dbSession = makeDbSession();
    ticketModel.db.startSession.mockResolvedValue(dbSession);

    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ bookingId }),
    });

    bookingModel.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      });

    ticketModel.findOneAndUpdate.mockResolvedValue(null);
    ticketModel.countDocuments.mockResolvedValue(0);

    await expect(service.cancelTicket(ticketCode, userId)).rejects.toThrow(
      BadRequestException
    );
  });

  it("decrements confirmedSoldCount for confirmed+paid bookings", async () => {
    const dbSession = makeDbSession();
    ticketModel.db.startSession.mockResolvedValue(dbSession);

    const cancelledTicket = {
      _id: new Types.ObjectId(),
      ticketCode,
      userId: new Types.ObjectId(userId),
      bookingId,
      zoneId,
      status: "cancelled",
    };

    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ bookingId }),
    });

    bookingModel.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
        }),
      });

    ticketModel.findOneAndUpdate.mockResolvedValue(cancelledTicket);
    ticketModel.countDocuments.mockResolvedValue(1);

    await service.cancelTicket(ticketCode, userId);

    expect(zoneModel.updateOne).toHaveBeenCalledWith(
      { _id: zoneId },
      expect.arrayContaining([
        expect.objectContaining({
          $set: expect.objectContaining({
            confirmedSoldCount: expect.anything(),
          }),
        }),
      ]),
      expect.any(Object)
    );
  });

  it("handles deleteQRCode failure gracefully", async () => {
    const dbSession = makeDbSession();
    ticketModel.db.startSession.mockResolvedValue(dbSession);

    const cancelledTicket = {
      _id: new Types.ObjectId(),
      ticketCode,
      userId: new Types.ObjectId(userId),
      bookingId,
      zoneId,
      status: "cancelled",
    };

    ticketModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ bookingId }),
    });

    bookingModel.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          status: BookingStatus.PENDING,
          paymentStatus: "unpaid",
        }),
      });

    ticketModel.findOneAndUpdate.mockResolvedValue(cancelledTicket);
    ticketModel.countDocuments.mockResolvedValue(1);
    mockUploadService.deleteQRCode.mockRejectedValue(
      new Error("Cloudinary upload error")
    );

    const result = await service.cancelTicket(ticketCode, userId);

    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getTicketByCode
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – getTicketByCode", () => {
  let service: TicketService;
  let ticketModel: any;
  let bookingModel: any;
  let zoneModel: any;

  beforeEach(async () => {
    const dbSession = makeDbSession();

    ticketModel = {
      findOne: jest.fn(),
      db: { startSession: jest.fn().mockResolvedValue(dbSession) },
    };

    bookingModel = { findOne: jest.fn() };
    zoneModel = { updateOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Event.name), useValue: {} },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn() },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn(),
              eval: jest.fn(),
              del: jest.fn(),
              scan: jest.fn(),
              get: jest.fn(),
              sMembers: jest.fn(),
              sAdd: jest.fn(),
              expire: jest.fn(),
            },
          },
        },
        {
          provide: UploadService,
          useValue: { uploadQRCodeBuffer: jest.fn(), deleteQRCode: jest.fn() },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  it("throws BadRequestException when userId is missing", async () => {
    await expect((service as any).getTicketByCode("", "TK123")).rejects.toThrow(
      BadRequestException
    );
  });

  const makeGetTicketByCodeChain = (resolvedValue: any) => ({
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  });

  it("returns ticket when found", async () => {
    const ticketDoc = { _id: new Types.ObjectId(), ticketCode: "TK123" };
    ticketModel.findOne.mockReturnValue(makeGetTicketByCodeChain(ticketDoc));

    const result = await (service as any).getTicketByCode(
      new Types.ObjectId().toString(),
      "TK123"
    );

    expect(result).toEqual(ticketDoc);
  });

  it("throws BadRequestException when ticket not found", async () => {
    ticketModel.findOne.mockReturnValue(makeGetTicketByCodeChain(null));

    await expect(
      (service as any).getTicketByCode(
        new Types.ObjectId().toString(),
        "INVALID"
      )
    ).rejects.toThrow(BadRequestException);
  });

  it("prefers the booking's snapshot over the live-populated event/zone/area when present", async () => {
    const ticketDoc = {
      _id: new Types.ObjectId(),
      ticketCode: "TK123",
      eventId: { title: "Live title", location: "Live location" },
      zoneId: { name: "Live zone" },
      areaId: { name: "Live area" },
      bookingId: {
        snapshot: {
          eventTitle: "Snapshot title",
          location: "Snapshot location",
          eventStartDate: new Date("2029-01-01T00:00:00.000Z"),
          eventEndDate: new Date("2029-01-02T00:00:00.000Z"),
          zoneName: "Snapshot zone",
          areaName: "Snapshot area",
        },
      },
    };
    ticketModel.findOne.mockReturnValue(makeGetTicketByCodeChain(ticketDoc));

    const result = await (service as any).getTicketByCode(
      new Types.ObjectId().toString(),
      "TK123"
    );

    expect(result.eventId.title).toBe("Snapshot title");
    expect(result.eventId.location).toBe("Snapshot location");
    expect(result.zoneId.name).toBe("Snapshot zone");
    expect(result.areaId.name).toBe("Snapshot area");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllTickets – ticketCode regex filter
// ─────────────────────────────────────────────────────────────────────────────
describe("TicketService – getAllTickets", () => {
  let service: TicketService;
  let ticketModel: any;

  beforeEach(async () => {
    ticketModel = {
      aggregate: jest.fn(),
      countDocuments: jest.fn(),
      db: { startSession: jest.fn() },
    };

    const mockRedisGet = jest.fn().mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        {
          provide: getModelToken(Booking.name),
          useValue: { findOne: jest.fn() },
        },
        { provide: getModelToken(Event.name), useValue: {} },
        {
          provide: getModelToken(Zone.name),
          useValue: { updateOne: jest.fn() },
        },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn() },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn(),
              get: mockRedisGet,
              del: jest.fn(),
              scan: jest.fn(),
              sMembers: jest.fn(),
              sAdd: jest.fn(),
              expire: jest.fn(),
            },
          },
        },
        {
          provide: UploadService,
          useValue: { uploadQRCodeBuffer: jest.fn(), deleteQRCode: jest.fn() },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  it("applies ticketCode regex filter when ticketCode is provided", async () => {
    ticketModel.aggregate.mockResolvedValue([]);
    ticketModel.countDocuments.mockResolvedValue(0);

    const queryDto = { ticketCode: "TK001", page: 1, limit: 20 } as any;
    const adminUser = {
      userId: new Types.ObjectId().toString(),
      role: "admin",
    } as any;
    await service.getAllTickets(queryDto, adminUser);

    expect(ticketModel.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          $match: expect.objectContaining({
            ticketCode: expect.objectContaining({ $regex: "TK001" }),
          }),
        }),
      ])
    );
  });
});

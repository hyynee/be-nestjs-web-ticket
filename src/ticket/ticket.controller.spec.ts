import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { TicketController } from "./ticket.controller";
import { TicketService } from "./ticket.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";

describe("TicketController", () => {
  let controller: TicketController;

  const mockTicketService = {
    createTicketsFromBooking: jest.fn(),
    validateTicket: jest.fn(),
    getTicketByCode: jest.fn(),
    checkInTicket: jest.fn(),
    cancelTicket: jest.fn(),
    getCheckInHistory: jest.fn(),
    getAllTickets: jest.fn(),
  };

  const mockCurrentUser = {
    userId: "user-1",
    role: "user",
    iat: 123,
    exp: 456,
  };
  const mockAdminUser = {
    userId: "admin-1",
    role: "admin",
    iat: 123,
    exp: 456,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketController],
      providers: [{ provide: TicketService, useValue: mockTicketService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<TicketController>(TicketController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("POST /ticket/from-booking", () => {
    it("should call createTicketsFromBooking with bookingCode only for admin manual issue", async () => {
      const bookingCode = "BK001";
      const expected = [{ ticketCode: "TK001" }];
      mockTicketService.createTicketsFromBooking.mockResolvedValue(expected);

      const result = await controller.createTicketsFromBooking(bookingCode);

      expect(mockTicketService.createTicketsFromBooking).toHaveBeenCalledWith(
        bookingCode
      );
      expect(result).toEqual(expected);
    });
  });

  describe("GET /ticket/validate/:ticketCode", () => {
    it("should call validateTicket with ticketCode and currentUser", async () => {
      const ticketCode = "TK001";
      const expected = { valid: true };
      mockTicketService.validateTicket.mockResolvedValue(expected);

      const result = await controller.validateTicket(
        mockCurrentUser as any,
        ticketCode
      );

      expect(mockTicketService.validateTicket).toHaveBeenCalledWith(
        ticketCode,
        mockCurrentUser
      );
      expect(result).toEqual(expected);
    });
  });

  describe("GET /ticket/:ticketCode", () => {
    it("should call getTicketByCode with userId and ticketCode", async () => {
      const ticketCode = "TK001";
      const expected = { ticketCode: "TK001", eventId: {} };
      mockTicketService.getTicketByCode.mockResolvedValue(expected);

      const result = await controller.getTicketByCode(
        mockCurrentUser as any,
        ticketCode
      );

      expect(mockTicketService.getTicketByCode).toHaveBeenCalledWith(
        "user-1",
        ticketCode
      );
      expect(result).toEqual(expected);
    });
  });

  describe("POST /ticket/checkin", () => {
    it("should call checkInTicket with all params resolved", async () => {
      const ticketCode = "TK001";
      const location = "Gate A";
      const deviceInfo = "iPhone 15";
      const expected = { success: true };
      mockTicketService.checkInTicket.mockResolvedValue(expected);

      const req = {
        headers: { "x-forwarded-for": "192.168.1.1" },
        ip: "10.0.0.1",
        socket: { remoteAddress: "::1" },
      };

      const result = await controller.checkInTicket(
        ticketCode,
        req as any,
        mockAdminUser as any,
        location,
        deviceInfo
      );

      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        ticketCode,
        location,
        deviceInfo,
        "192.168.1.1",
        mockAdminUser
      );
      expect(result).toEqual(expected);
    });

    it("should default location and deviceInfo to empty strings", async () => {
      const ticketCode = "TK001";
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });

      const req = {
        headers: {},
        ip: "10.0.0.1",
        socket: { remoteAddress: "::1" },
      };

      await controller.checkInTicket(
        ticketCode,
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );

      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        ticketCode,
        "",
        "",
        "10.0.0.1",
        mockAdminUser
      );
    });
  });

  describe("resolveClientIp (tested via checkInTicket)", () => {
    it("should use x-forwarded-for single IP", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: { "x-forwarded-for": "203.0.113.1" },
        ip: "10.0.0.1",
        socket: { remoteAddress: "::1" },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "203.0.113.1",
        mockAdminUser
      );
    });

    it("should use first IP from x-forwarded-for array", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: { "x-forwarded-for": ["198.51.100.1", "198.51.100.2"] },
        ip: "10.0.0.1",
        socket: { remoteAddress: "::1" },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "198.51.100.1",
        mockAdminUser
      );
    });

    it("should use first IP from comma-separated x-forwarded-for", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5, 192.0.2.8" },
        ip: "10.0.0.1",
        socket: { remoteAddress: "::1" },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "198.51.100.1",
        mockAdminUser
      );
    });

    it("should trim IP from comma-separated x-forwarded-for", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: { "x-forwarded-for": "  198.51.100.1  , 203.0.113.5" },
        ip: "10.0.0.1",
        socket: { remoteAddress: "::1" },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "198.51.100.1",
        mockAdminUser
      );
    });

    it("should fall back to req.ip when x-forwarded-for is missing", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: {},
        ip: "10.0.0.99",
        socket: { remoteAddress: "::1" },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "10.0.0.99",
        mockAdminUser
      );
    });

    it("should fall back to req.socket.remoteAddress when req.ip is also missing", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: {},
        ip: undefined,
        socket: { remoteAddress: "::1" },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "::1",
        mockAdminUser
      );
    });

    it("should return empty string when all sources are missing", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: {},
        ip: undefined,
        socket: { remoteAddress: undefined },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "",
        mockAdminUser
      );
    });

    it("should return empty string when x-forwarded-for is not a valid value and ip/socket are missing", async () => {
      mockTicketService.checkInTicket.mockResolvedValue({ success: true });
      const req = {
        headers: { "x-forwarded-for": "" },
        ip: undefined,
        socket: { remoteAddress: undefined },
      };
      await controller.checkInTicket(
        "TK001",
        req as any,
        mockAdminUser as any,
        undefined,
        undefined
      );
      expect(mockTicketService.checkInTicket).toHaveBeenCalledWith(
        "TK001",
        "",
        "",
        "",
        mockAdminUser
      );
    });
  });

  describe("POST /ticket/cancel", () => {
    it("should call cancelTicket with ticketCode and userId", async () => {
      const ticketCode = "TK001";
      const expected = { success: true };
      mockTicketService.cancelTicket.mockResolvedValue(expected);

      const result = await controller.cancelTicket(
        ticketCode,
        mockCurrentUser as any
      );

      expect(mockTicketService.cancelTicket).toHaveBeenCalledWith(
        ticketCode,
        "user-1"
      );
      expect(result).toEqual(expected);
    });
  });

  describe("GET /ticket/checkin-history/:ticketCode", () => {
    it("should call getCheckInHistory with ticketCode and currentUser", async () => {
      const ticketCode = "TK001";
      const expected = { ticketCode, history: [] };
      mockTicketService.getCheckInHistory.mockResolvedValue(expected);

      const result = await controller.getCheckInHistory(
        ticketCode,
        mockAdminUser as any
      );

      expect(mockTicketService.getCheckInHistory).toHaveBeenCalledWith(
        ticketCode,
        mockAdminUser
      );
      expect(result).toEqual(expected);
    });
  });

  describe("GET /ticket/admin/all-tickets", () => {
    it("should call getAllTickets with query DTO and current user", async () => {
      const query = { page: 1, limit: 20 };
      const expected = { items: [], meta: {} };
      mockTicketService.getAllTickets.mockResolvedValue(expected);

      const result = await controller.getAllTickets(
        query as any,
        mockAdminUser as any
      );

      expect(mockTicketService.getAllTickets).toHaveBeenCalledWith(
        query,
        mockAdminUser
      );
      expect(result).toEqual(expected);
    });
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer to list all tickets", () => {
      expect(reflector.get(ROLES_KEY, controller.getAllTickets)).toEqual([
        "admin",
        "organizer",
      ]);
    });

    it("allows admin, organizer, and checkin_staff to check in tickets", () => {
      expect(reflector.get(ROLES_KEY, controller.checkInTicket)).toEqual([
        "admin",
        "organizer",
        "checkin_staff",
      ]);
    });

    it("restricts check-in history to admin and organizer (not checkin_staff)", () => {
      expect(reflector.get(ROLES_KEY, controller.getCheckInHistory)).toEqual([
        "admin",
        "organizer",
      ]);
    });

    it("keeps ticket generation from a booking admin-only", () => {
      expect(
        reflector.get(ROLES_KEY, controller.createTicketsFromBooking)
      ).toEqual(["admin"]);
    });
  });
});

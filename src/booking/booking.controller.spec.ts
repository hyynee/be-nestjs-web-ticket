import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { GUARDS_METADATA } from "@nestjs/common/constants";

describe("BookingController", () => {
  let controller: BookingController;

  const mockBookingService = {
    createBooking: jest.fn(),
    getMyBookings: jest.fn(),
    getBookingByCode: jest.fn(),
    getZoneBookingInfo: jest.fn(),
    cancelBooking: jest.fn(),
    getAllBookings: jest.fn(),
    adminCancelBooking: jest.fn(),
  };

  const mockCurrentUser = {
    userId: "user-1",
    role: "user",
    iat: 123,
    exp: 456,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BookingController],
      providers: [{ provide: BookingService, useValue: mockBookingService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<BookingController>(BookingController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("POST /booking", () => {
    it("should call bookingService.createBooking with userId and DTO", async () => {
      const dto = {
        eventId: "507f1f77bcf86cd799439011",
        zoneId: "507f1f77bcf86cd799439012",
        quantity: 2,
        customerEmail: "test@test.com",
      };
      const expectedResult = {
        success: true,
        message: "Tạo booking thành công",
      };
      mockBookingService.createBooking.mockResolvedValue(expectedResult);

      const result = await controller.createBooking(
        mockCurrentUser as any,
        dto as any
      );

      expect(mockBookingService.createBooking).toHaveBeenCalledWith(
        "user-1",
        dto
      );
      expect(result).toEqual(expectedResult);
    });

    it("requires VerifiedUserGuard in addition to AuthGuard(jwt)", () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        controller.createBooking
      );
      expect(guards).toContain(VerifiedUserGuard);
    });
  });

  describe("GET /booking/my-bookings", () => {
    it("should call bookingService.getMyBookings with userId", async () => {
      const expectedResult = { success: true, items: [], meta: {} };
      mockBookingService.getMyBookings.mockResolvedValue(expectedResult);

      const result = await controller.getMyBookings(mockCurrentUser as any);

      expect(mockBookingService.getMyBookings).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(expectedResult);
    });
  });

  describe("GET /booking/:bookingCode", () => {
    it("should call bookingService.getBookingByCode with userId and bookingCode", async () => {
      const expectedResult = { success: true, data: { bookingCode: "BK001" } };
      mockBookingService.getBookingByCode.mockResolvedValue(expectedResult);

      const result = await controller.getBookingByCode(
        mockCurrentUser as any,
        "BK001"
      );

      expect(mockBookingService.getBookingByCode).toHaveBeenCalledWith(
        "user-1",
        "BK001"
      );
      expect(result).toEqual(expectedResult);
    });
  });

  describe("GET /booking/zone-info/:eventId/:zoneId", () => {
    it("should call bookingService.getZoneBookingInfo with eventId and zoneId", async () => {
      const expectedResult = { success: true, data: {} };
      mockBookingService.getZoneBookingInfo.mockResolvedValue(expectedResult);

      const result = await controller.getZoneBookingInfo(
        "event-id-1",
        "zone-id-1"
      );

      expect(mockBookingService.getZoneBookingInfo).toHaveBeenCalledWith(
        "event-id-1",
        "zone-id-1"
      );
      expect(result).toEqual(expectedResult);
    });
  });

  describe("PATCH /booking/cancel-booking", () => {
    it("should call bookingService.cancelBooking with userId and DTO", async () => {
      const dto = { bookingCode: "BK001" };
      const expectedResult = { message: "Booking cancelled successfully" };
      mockBookingService.cancelBooking.mockResolvedValue(expectedResult);

      const result = await controller.cancelBooking(
        mockCurrentUser as any,
        dto as any
      );

      expect(mockBookingService.cancelBooking).toHaveBeenCalledWith(
        "user-1",
        dto
      );
      expect(result).toEqual(expectedResult);
    });
  });

  describe("GET /booking/admin/all-bookings", () => {
    it("should call bookingService.getAllBookings with query DTO and current user", async () => {
      const query = { page: 1, limit: 20 };
      const expectedResult = { items: [], meta: {} };
      mockBookingService.getAllBookings.mockResolvedValue(expectedResult);

      const result = await controller.getAllBookings(
        query as any,
        mockCurrentUser as any
      );

      expect(mockBookingService.getAllBookings).toHaveBeenCalledWith(
        query,
        mockCurrentUser
      );
      expect(result).toEqual(expectedResult);
    });
  });

  describe("PATCH /booking/admin/cancel/:bookingId", () => {
    it("should call bookingService.adminCancelBooking with bookingId, userId, and reason", async () => {
      const dto = { reason: "Event cancelled" };
      const expectedResult = { message: "Booking cancelled by admin" };
      mockBookingService.adminCancelBooking.mockResolvedValue(expectedResult);

      const result = await controller.adminCancelBooking(
        mockCurrentUser as any,
        "booking-id-1",
        dto as any
      );

      expect(mockBookingService.adminCancelBooking).toHaveBeenCalledWith(
        "booking-id-1",
        "user-1",
        "Event cancelled"
      );
      expect(result).toEqual(expectedResult);
    });

    it("should call bookingService.adminCancelBooking with undefined reason when not provided", async () => {
      const dto = {};
      mockBookingService.adminCancelBooking.mockResolvedValue({
        message: "Booking cancelled by admin",
      });

      await controller.adminCancelBooking(
        mockCurrentUser as any,
        "booking-id-1",
        dto as any
      );

      expect(mockBookingService.adminCancelBooking).toHaveBeenCalledWith(
        "booking-id-1",
        "user-1",
        undefined
      );
    });
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer to list all bookings", () => {
      expect(reflector.get(ROLES_KEY, controller.getAllBookings)).toEqual([
        "admin",
        "organizer",
      ]);
    });

    it("keeps admin-cancel-booking admin-only", () => {
      expect(reflector.get(ROLES_KEY, controller.adminCancelBooking)).toEqual([
        "admin",
      ]);
    });
  });
});

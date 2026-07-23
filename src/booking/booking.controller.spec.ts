import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { BookingService } from "./booking.service";
import { BookingAdminController } from "./controllers/booking-admin.controller";
import { BookingCommandController } from "./controllers/booking-command.controller";
import { BookingQueryController } from "./controllers/booking-query.controller";

describe("Booking controllers", () => {
  let adminController: BookingAdminController;
  let commandController: BookingCommandController;
  let queryController: BookingQueryController;

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
      controllers: [
        BookingAdminController,
        BookingCommandController,
        BookingQueryController,
      ],
      providers: [{ provide: BookingService, useValue: mockBookingService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(VerifiedUserGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    adminController = module.get<BookingAdminController>(
      BookingAdminController
    );
    commandController = module.get<BookingCommandController>(
      BookingCommandController
    );
    queryController = module.get<BookingQueryController>(
      BookingQueryController
    );
  });

  it("should be defined", () => {
    expect(adminController).toBeDefined();
    expect(commandController).toBeDefined();
    expect(queryController).toBeDefined();
  });

  it("creates a booking with current user id and DTO", async () => {
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

    const result = await commandController.createBooking(
      mockCurrentUser as any,
      dto as any
    );

    expect(mockBookingService.createBooking).toHaveBeenCalledWith(
      "user-1",
      dto
    );
    expect(result).toEqual(expectedResult);
  });

  it("requires VerifiedUserGuard for creating bookings", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      commandController.createBooking
    );
    expect(guards).toContain(VerifiedUserGuard);
  });

  it("loads my bookings with current user id", async () => {
    const expectedResult = { success: true, items: [], meta: {} };
    mockBookingService.getMyBookings.mockResolvedValue(expectedResult);

    const result = await queryController.getMyBookings(mockCurrentUser as any);

    expect(mockBookingService.getMyBookings).toHaveBeenCalledWith("user-1");
    expect(result).toEqual(expectedResult);
  });

  it("loads booking detail by code with current user id", async () => {
    const expectedResult = { success: true, data: { bookingCode: "BK001" } };
    mockBookingService.getBookingByCode.mockResolvedValue(expectedResult);

    const result = await queryController.getBookingByCode(
      mockCurrentUser as any,
      "BK001"
    );

    expect(mockBookingService.getBookingByCode).toHaveBeenCalledWith(
      "user-1",
      "BK001"
    );
    expect(result).toEqual(expectedResult);
  });

  it("loads zone booking info by event and zone id", async () => {
    const expectedResult = {
      event: {},
      zone: {},
      areas: null,
      bookedSeatsByArea: null,
    };
    mockBookingService.getZoneBookingInfo.mockResolvedValue(expectedResult);

    const result = await queryController.getZoneBookingInfo(
      "event-id-1",
      "zone-id-1"
    );

    expect(mockBookingService.getZoneBookingInfo).toHaveBeenCalledWith(
      "event-id-1",
      "zone-id-1"
    );
    expect(result).toEqual(expectedResult);
  });

  it("cancels own booking with current user id", async () => {
    const dto = { bookingCode: "BK001" };
    const expectedResult = { message: "Booking cancelled successfully" };
    mockBookingService.cancelBooking.mockResolvedValue(expectedResult);

    const result = await commandController.cancelBooking(
      mockCurrentUser as any,
      dto as any
    );

    expect(mockBookingService.cancelBooking).toHaveBeenCalledWith(
      "user-1",
      dto
    );
    expect(result).toEqual(expectedResult);
  });

  it("lists all bookings for admin or organizer", async () => {
    const query = { page: 1, limit: 20 };
    const expectedResult = { items: [], meta: {} };
    mockBookingService.getAllBookings.mockResolvedValue(expectedResult);

    const result = await adminController.getAllBookings(
      query as any,
      mockCurrentUser as any
    );

    expect(mockBookingService.getAllBookings).toHaveBeenCalledWith(
      query,
      mockCurrentUser
    );
    expect(result).toEqual(expectedResult);
  });

  it("admin-cancels a booking with optional reason", async () => {
    const dto = { reason: "Event cancelled" };
    const expectedResult = { message: "Booking cancelled by admin" };
    mockBookingService.adminCancelBooking.mockResolvedValue(expectedResult);

    const result = await adminController.adminCancelBooking(
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

    await adminController.adminCancelBooking(
      mockCurrentUser as any,
      "booking-id-1",
      {} as any
    );

    expect(mockBookingService.adminCancelBooking).toHaveBeenLastCalledWith(
      "booking-id-1",
      "user-1",
      undefined
    );
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer to list all bookings", () => {
      expect(reflector.get(ROLES_KEY, adminController.getAllBookings)).toEqual([
        "admin",
        "organizer",
      ]);
    });

    it("keeps admin-cancel-booking admin-only", () => {
      expect(
        reflector.get(ROLES_KEY, adminController.adminCancelBooking)
      ).toEqual(["admin"]);
    });
  });
});

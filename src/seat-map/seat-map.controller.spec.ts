import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  EventSeatMapController,
  ZoneSeatMapController,
  SeatMapController,
} from "./seat-map.controller";
import { SeatMapService } from "./seat-map.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BlockSeatsDto } from "./dto/block-seats.dto";
import { UnblockSeatsDto } from "./dto/unblock-seats.dto";

describe("SeatMap controllers", () => {
  const mockUser: JwtPayload = {
    userId: "admin-id",
    role: "admin",
    iat: 0,
    exp: 0,
  };
  const eventId = "507f1f77bcf86cd799439011";
  const zoneId = "507f1f77bcf86cd799439012";

  let eventSeatMapController: EventSeatMapController;
  let zoneSeatMapController: ZoneSeatMapController;
  let seatMapController: SeatMapController;
  let seatMapService: jest.Mocked<SeatMapService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [
        EventSeatMapController,
        ZoneSeatMapController,
        SeatMapController,
      ],
      providers: [
        {
          provide: SeatMapService,
          useValue: {
            getEventSeatMap: jest.fn(),
            getZoneSeatMap: jest.fn(),
            blockSeats: jest.fn(),
            unblockSeats: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    eventSeatMapController = module.get(EventSeatMapController);
    zoneSeatMapController = module.get(ZoneSeatMapController);
    seatMapController = module.get(SeatMapController);
    seatMapService = module.get(SeatMapService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("EventSeatMapController.getEventSeatMap", () => {
    it("delegates to the service with the event id", async () => {
      const seatMap = [{ zoneId, zoneName: "VIP" }];
      seatMapService.getEventSeatMap.mockResolvedValue(seatMap as any);

      const result = await eventSeatMapController.getEventSeatMap(eventId);

      expect(seatMapService.getEventSeatMap).toHaveBeenCalledWith(eventId);
      expect(result).toEqual(seatMap);
    });
  });

  describe("ZoneSeatMapController.getZoneSeatMap", () => {
    it("delegates to the service with the zone id", async () => {
      const seatMap = { zoneId, zoneName: "VIP" };
      seatMapService.getZoneSeatMap.mockResolvedValue(seatMap as any);

      const result = await zoneSeatMapController.getZoneSeatMap(zoneId);

      expect(seatMapService.getZoneSeatMap).toHaveBeenCalledWith(zoneId);
      expect(result).toEqual(seatMap);
    });
  });

  describe("SeatMapController.blockSeats", () => {
    it("delegates to the service with the current user and DTO", async () => {
      const dto: BlockSeatsDto = {
        zoneId,
        areaId: "507f1f77bcf86cd799439013",
        seats: ["A1"],
      };
      const response = { seats: [{ seat: "A1", status: "blocked" }] };
      seatMapService.blockSeats.mockResolvedValue(response as any);

      const result = await seatMapController.blockSeats(mockUser, dto);

      expect(seatMapService.blockSeats).toHaveBeenCalledWith(mockUser, dto);
      expect(result).toEqual(response);
    });
  });

  describe("SeatMapController.unblockSeats", () => {
    it("delegates to the service with the current user and DTO", async () => {
      const dto: UnblockSeatsDto = {
        zoneId,
        areaId: "507f1f77bcf86cd799439013",
        seats: ["A1"],
      };
      const response = { seats: [{ seat: "A1", status: "available" }] };
      seatMapService.unblockSeats.mockResolvedValue(response as any);

      const result = await seatMapController.unblockSeats(mockUser, dto);

      expect(seatMapService.unblockSeats).toHaveBeenCalledWith(mockUser, dto);
      expect(result).toEqual(response);
    });
  });

  describe("route protection metadata", () => {
    const reflector = new Reflector();

    it("keeps block/unblock admin+organizer only", () => {
      expect(reflector.get(ROLES_KEY, seatMapController.blockSeats)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, seatMapController.unblockSeats)).toEqual([
        "admin",
        "organizer",
      ]);
    });
  });
});

// ── DTO validation ──────────────────────────────────────────────────────────

describe("BlockSeatsDto validation", () => {
  it("rejects a seats array with duplicate entries", async () => {
    const dto = plainToInstance(BlockSeatsDto, {
      zoneId: "507f1f77bcf86cd799439011",
      areaId: "507f1f77bcf86cd799439012",
      seats: ["A1", "A1"],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "seats")).toBe(true);
  });

  it("accepts a seats array with unique entries", async () => {
    const dto = plainToInstance(BlockSeatsDto, {
      zoneId: "507f1f77bcf86cd799439011",
      areaId: "507f1f77bcf86cd799439012",
      seats: ["A1", "A2"],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe("UnblockSeatsDto validation", () => {
  it("rejects a seats array with duplicate entries", async () => {
    const dto = plainToInstance(UnblockSeatsDto, {
      zoneId: "507f1f77bcf86cd799439011",
      areaId: "507f1f77bcf86cd799439012",
      seats: ["A1", "A1"],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "seats")).toBe(true);
  });
});

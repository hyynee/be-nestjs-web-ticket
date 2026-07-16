import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { AiccBookingTool } from "./booking.tool";
import { Booking } from "@src/schemas/booking.schema";

describe("AiccBookingTool", () => {
  let tool: AiccBookingTool;
  let bookingModel: any;

  const userId = new Types.ObjectId().toString();

  const baseBooking = (overrides: Record<string, any> = {}) => ({
    _id: new Types.ObjectId(),
    bookingCode: "BK-001",
    status: "confirmed",
    paymentStatus: "paid",
    quantity: 1,
    totalPrice: 100_000,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    eventId: {
      _id: new Types.ObjectId(),
      title: "Live title (renamed since booking)",
      startDate: new Date("2031-01-01T00:00:00.000Z"),
      endDate: new Date("2031-01-02T00:00:00.000Z"),
      location: "Live location",
      status: "active",
      thumbnail: "https://example.com/thumb.jpg",
    },
    zoneId: {
      _id: new Types.ObjectId(),
      name: "Live zone name",
      price: 999_000,
    },
    areaId: {
      _id: new Types.ObjectId(),
      name: "Live area name",
      rowLabel: "A",
    },
    ...overrides,
  });

  beforeEach(async () => {
    bookingModel = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiccBookingTool,
        { provide: getModelToken(Booking.name), useValue: bookingModel },
      ],
    }).compile();

    tool = module.get(AiccBookingTool);
  });

  const mockFindOne = (result: any) => {
    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(result),
    });
  };

  describe("lookupBooking", () => {
    it("falls back to the live-populated event/zone/area when no snapshot exists", async () => {
      mockFindOne(baseBooking());

      const result = await tool.lookupBooking({
        bookingCode: "BK-001",
        access: { userId },
      });

      expect(result.found).toBe(true);
      expect(result.booking?.event?.title).toBe(
        "Live title (renamed since booking)"
      );
      expect(result.booking?.event?.location).toBe("Live location");
      expect(result.booking?.zone?.name).toBe("Live zone name");
      expect(result.booking?.area?.name).toBe("Live area name");
    });

    it("prefers the booking's immutable snapshot for title/dates/location/zone/area names", async () => {
      mockFindOne(
        baseBooking({
          snapshot: {
            eventTitle: "Original title at booking time",
            eventStartDate: new Date("2029-06-01T00:00:00.000Z"),
            eventEndDate: new Date("2029-06-02T00:00:00.000Z"),
            location: "Original location at booking time",
            zoneName: "Original zone name",
            areaName: "Original area name",
          },
        })
      );

      const result = await tool.lookupBooking({
        bookingCode: "BK-001",
        access: { userId },
      });

      expect(result.booking?.event?.title).toBe(
        "Original title at booking time"
      );
      expect(result.booking?.event?.startDate).toBe("2029-06-01T00:00:00.000Z");
      expect(result.booking?.event?.endDate).toBe("2029-06-02T00:00:00.000Z");
      expect(result.booking?.event?.location).toBe(
        "Original location at booking time"
      );
      expect(result.booking?.zone?.name).toBe("Original zone name");
      expect(result.booking?.area?.name).toBe("Original area name");
    });

    it("always uses the live event status and thumbnail even when a snapshot exists (current-state fields, not historical facts)", async () => {
      mockFindOne(
        baseBooking({
          eventId: {
            _id: new Types.ObjectId(),
            title: "Live title",
            startDate: new Date("2031-01-01T00:00:00.000Z"),
            endDate: new Date("2031-01-02T00:00:00.000Z"),
            location: "Live location",
            status: "cancelled",
            thumbnail: "https://example.com/current-thumb.jpg",
          },
          snapshot: {
            eventTitle: "Snapshot title",
            eventStartDate: new Date("2029-06-01T00:00:00.000Z"),
            eventEndDate: new Date("2029-06-02T00:00:00.000Z"),
            location: "Snapshot location",
            zoneName: "Snapshot zone",
          },
        })
      );

      const result = await tool.lookupBooking({
        bookingCode: "BK-001",
        access: { userId },
      });

      expect(result.booking?.event?.status).toBe("cancelled");
      expect(result.booking?.event?.thumbnail).toBe(
        "https://example.com/current-thumb.jpg"
      );
    });

    it("returns found: false when the booking does not exist", async () => {
      mockFindOne(null);

      const result = await tool.lookupBooking({
        bookingCode: "NOPE",
        access: { userId },
      });

      expect(result).toEqual({ found: false });
    });

    it("returns found: false without querying when access filter cannot be applied", async () => {
      const result = await tool.lookupBooking({ bookingCode: "BK-001" });

      expect(result).toEqual({ found: false });
      expect(bookingModel.findOne).not.toHaveBeenCalled();
    });
  });
});

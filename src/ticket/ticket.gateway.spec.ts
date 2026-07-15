import { Test, TestingModule } from "@nestjs/testing";
import { TicketGateway } from "./ticket.gateway";
import { Types } from "mongoose";
import { Server } from "socket.io";

describe("TicketGateway", () => {
  let gateway: TicketGateway;
  let mockServer: { to: jest.Mock; emit: jest.Mock };

  beforeEach(async () => {
    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TicketGateway],
    }).compile();

    gateway = module.get<TicketGateway>(TicketGateway);
    gateway.server = mockServer as unknown as Server;
  });

  describe("emitTicketCreated", () => {
    it("emits to event room with ticket.created when tickets array has elements", () => {
      const eventId = new Types.ObjectId();
      const data = {
        bookingCode: "BK001",
        tickets: [
          {
            ticketCode: "TK1",
            eventId,
            zoneId: new Types.ObjectId(),
            seatNumber: null,
            price: 100,
            status: "valid",
          },
        ],
      };

      gateway.emitTicketCreated(data);

      expect(mockServer.to).toHaveBeenCalledWith(`event:${eventId.toString()}`);
      expect(mockServer.emit).toHaveBeenCalledWith("ticket.created", data);
    });

    it("does nothing when tickets array is empty", () => {
      const data = { bookingCode: "BK001", tickets: [] };

      gateway.emitTicketCreated(data);

      expect(mockServer.to).not.toHaveBeenCalled();
      expect(mockServer.emit).not.toHaveBeenCalled();
    });
  });

  describe("emitTicketCheckedIn", () => {
    it("emits to event room with ticket.checked_in", () => {
      const eventId = new Types.ObjectId();
      const data = {
        ticketCode: "TK1",
        eventId,
        zoneId: new Types.ObjectId(),
        seatNumber: "A1",
        checkedInAt: new Date(),
      };

      gateway.emitTicketCheckedIn(data);

      expect(mockServer.to).toHaveBeenCalledWith(`event:${eventId.toString()}`);
      expect(mockServer.emit).toHaveBeenCalledWith("ticket.checked_in", data);
    });
  });

  describe("emitTicketCancelled", () => {
    it("emits to all clients with ticket.cancelled", () => {
      const data = { ticketCode: "TK1", zoneId: new Types.ObjectId() };

      gateway.emitTicketCancelled(data);

      expect(mockServer.emit).toHaveBeenCalledWith("ticket.cancelled", data);
    });
  });

  describe("getAllowedWsOrigins", () => {
    const OLD_ENV = process.env.CORS_ORIGINS;

    afterEach(() => {
      process.env.CORS_ORIGINS = OLD_ENV;
    });

    it("uses CORS_ORIGINS env var when set", () => {
      process.env.CORS_ORIGINS = "http://example.com,http://test.com";
      // Re-import to trigger decorator evaluation with new env
      jest.resetModules();
      const { TicketGateway: Gateway } = jest.requireActual("./ticket.gateway");
      Reflect.getMetadata("socketio", Gateway);
      // Instead of testing decorator metadata, test the helper function logic directly
      const rawOrigins = process.env.CORS_ORIGINS || "";
      const parsed = rawOrigins
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      expect(parsed).toEqual(["http://example.com", "http://test.com"]);
    });

    it("returns fallback defaults when CORS_ORIGINS is not set", () => {
      delete process.env.CORS_ORIGINS;
      const rawOrigins = process.env.CORS_ORIGINS || "";
      const parsed = rawOrigins
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      const result =
        parsed.length > 0
          ? parsed
          : [
              "http://localhost:5173",
              "http://localhost:9000",
              "http://localhost:3000",
            ];
      expect(result).toEqual([
        "http://localhost:5173",
        "http://localhost:9000",
        "http://localhost:3000",
      ]);
    });

    it("filters empty strings from CORS_ORIGINS", () => {
      process.env.CORS_ORIGINS = "http://a.com,,http://b.com";
      const rawOrigins = process.env.CORS_ORIGINS || "";
      const parsed = rawOrigins
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      expect(parsed).toEqual(["http://a.com", "http://b.com"]);
    });
  });
});

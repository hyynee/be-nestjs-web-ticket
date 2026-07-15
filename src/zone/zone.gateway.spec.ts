/**
 * Integration test: Socket.IO cross-instance event propagation via Redis adapter.
 * Requires Redis running at REDIS_HOST:REDIS_PORT (defaults: localhost:6379).
 */
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import * as http from "http";
import { AddressInfo } from "net";

const REDIS_URL = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? 6379}`;

describe("Socket.IO cross-instance propagation via Redis adapter", () => {
  let serverA: Server;
  let serverB: Server;
  let httpA: http.Server;
  let httpB: http.Server;
  let portB: number;
  let pubA: ReturnType<typeof createClient>;
  let subA: ReturnType<typeof createClient>;
  let pubB: ReturnType<typeof createClient>;
  let subB: ReturnType<typeof createClient>;

  beforeAll(async () => {
    pubA = createClient({ url: REDIS_URL });
    subA = pubA.duplicate();
    pubB = createClient({ url: REDIS_URL });
    subB = pubB.duplicate();

    pubA.on("error", () => undefined);
    subA.on("error", () => undefined);
    pubB.on("error", () => undefined);
    subB.on("error", () => undefined);

    await Promise.all([
      pubA.connect(),
      subA.connect(),
      pubB.connect(),
      subB.connect(),
    ]);

    httpA = http.createServer();
    serverA = new Server(httpA, { cors: { origin: "*" } });
    serverA.adapter(createAdapter(pubA, subA));
    await new Promise<void>((resolve) => httpA.listen(0, resolve));
    const _portA = (httpA.address() as AddressInfo).port;

    httpB = http.createServer();
    serverB = new Server(httpB, { cors: { origin: "*" } });
    serverB.adapter(createAdapter(pubB, subB));
    // Auto-join client to the room it requests via query param
    serverB.on("connection", (socket) => {
      const room = socket.handshake.query.room as string;
      if (room) void socket.join(room);
    });
    await new Promise<void>((resolve) => httpB.listen(0, resolve));
    portB = (httpB.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // Close both servers in parallel so their adapters can unsubscribe from Redis
    await Promise.all([
      new Promise<void>((resolve) => serverA.close(() => resolve())),
      new Promise<void>((resolve) => serverB.close(() => resolve())),
    ]);
    // Brief delay for the Redis adapter to flush its internal subscriptions
    // before we send QUIT, preventing unhandled DisconnectsClientError rejections
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await Promise.allSettled([
      pubA.quit(),
      subA.quit(),
      pubB.quit(),
      subB.quit(),
    ]);
  });

  function connectToB(room: string): Promise<ClientSocket> {
    return new Promise((resolve) => {
      const client = ioClient(`http://localhost:${portB}`, {
        transports: ["websocket"],
        query: { room },
      });
      client.on("connect", () => resolve(client));
    });
  }

  it("zone.ticket_update: emitted on instance A, received by client on instance B", async () => {
    const room = "event:zone-cross-test";
    const payload = {
      zoneId: "zone-1",
      eventId: "zone-cross-test",
      capacity: 100,
      soldCount: 10,
      confirmedSoldCount: 8,
      availableTickets: 90,
    };

    const client = await connectToB(room);
    // Give Redis pub/sub time to propagate the join
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const received = new Promise((resolve) =>
      client.once("zone.ticket_update", resolve)
    );
    serverA.to(room).emit("zone.ticket_update", payload);
    const data = await received;

    expect(data).toMatchObject(payload);
    client.disconnect();
  }, 10_000);

  it("ticket.created: emitted on instance A, received by client on instance B", async () => {
    const room = "event:ticket-created-cross-test";
    const payload = {
      bookingCode: "BK-CROSS-001",
      tickets: [
        {
          ticketCode: "TK-001",
          eventId: "ticket-created-cross-test",
          zoneId: "zone-1",
          seatNumber: null,
          price: 150_000,
          status: "valid",
        },
      ],
    };

    const client = await connectToB(room);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const received = new Promise((resolve) =>
      client.once("ticket.created", resolve)
    );
    serverA.to(room).emit("ticket.created", payload);
    const data = await received;

    expect(data).toMatchObject(payload);
    client.disconnect();
  }, 10_000);

  it("ticket.checked_in: emitted on instance A, received by client on instance B", async () => {
    const room = "event:ticket-checkin-cross-test";
    const payload = {
      ticketCode: "TK-CHECKIN-001",
      eventId: "ticket-checkin-cross-test",
      zoneId: "zone-1",
      seatNumber: "A1",
    };

    const client = await connectToB(room);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const received = new Promise((resolve) =>
      client.once("ticket.checked_in", resolve)
    );
    serverA.to(room).emit("ticket.checked_in", payload);
    const data = await received;

    expect(data).toMatchObject(payload);
    client.disconnect();
  }, 10_000);
});

// ─── Unit tests ──────────────────────────────────────────────────────────────

import { Test, TestingModule } from "@nestjs/testing";
import { ZoneGateway, getAllowedWsOrigins } from "./zone.gateway";
import { Server } from "socket.io";
import { Types } from "mongoose";

describe("ZoneGateway (unit)", () => {
  let gateway: ZoneGateway;
  let mockServer: { to: jest.Mock; emit: jest.Mock };

  beforeEach(async () => {
    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    process.env.CORS_ORIGINS = "";

    const module: TestingModule = await Test.createTestingModule({
      providers: [ZoneGateway],
    }).compile();

    gateway = module.get<ZoneGateway>(ZoneGateway);
    gateway.server = mockServer as unknown as Server;
  });

  describe("emitZoneTicketUpdate", () => {
    it("calls server.to().emit() with zone.ticket_update", () => {
      const payload = {
        zoneId: new Types.ObjectId(),
        eventId: new Types.ObjectId(),
        capacity: 100,
        soldCount: 10,
        confirmedSoldCount: 8,
        availableTickets: 90,
      };

      gateway.emitZoneTicketUpdate(payload);

      expect(mockServer.to).toHaveBeenCalledWith(
        `event:${payload.eventId.toString()}`
      );
      expect(mockServer.emit).toHaveBeenCalledWith(
        "zone.ticket_update",
        payload
      );
    });
  });

  describe("emitSeatMapUpdate", () => {
    it("calls server.to().emit() with seat_map.update", () => {
      const payload = {
        eventId: new Types.ObjectId(),
        zoneId: new Types.ObjectId(),
        areaId: new Types.ObjectId(),
        seats: [{ seat: "A1", status: "blocked" }],
      };

      gateway.emitSeatMapUpdate(payload);

      expect(mockServer.to).toHaveBeenCalledWith(
        `event:${payload.eventId.toString()}`
      );
      expect(mockServer.emit).toHaveBeenCalledWith("seat_map.update", payload);
    });
  });

  describe("getAllowedWsOrigins", () => {
    const OLD_ENV = process.env.CORS_ORIGINS;

    afterAll(() => {
      process.env.CORS_ORIGINS = OLD_ENV;
    });

    it("returns parsed origins when CORS_ORIGINS is set", () => {
      process.env.CORS_ORIGINS =
        "http://app.example.com,https://admin.example.com";
      expect(getAllowedWsOrigins()).toEqual([
        "http://app.example.com",
        "https://admin.example.com",
      ]);
    });

    it("returns fallback defaults when CORS_ORIGINS is empty string", () => {
      process.env.CORS_ORIGINS = "";
      expect(getAllowedWsOrigins()).toEqual([
        "http://localhost:5173",
        "http://localhost:9000",
        "http://localhost:3000",
      ]);
    });

    it("returns fallback defaults when CORS_ORIGINS is not set", () => {
      delete process.env.CORS_ORIGINS;
      expect(getAllowedWsOrigins()).toEqual([
        "http://localhost:5173",
        "http://localhost:9000",
        "http://localhost:3000",
      ]);
    });
  });
});

import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server } from "socket.io";
import { Logger } from "@nestjs/common";
import { Types } from "mongoose";

export function getAllowedWsOrigins(): string[] {
  const rawOrigins = process.env.CORS_ORIGINS || "";
  const parsedOrigins = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (parsedOrigins.length > 0) {
    return parsedOrigins;
  }

  return [
    "http://localhost:5173",
    "http://localhost:9000",
    "http://localhost:3000",
  ];
}

interface ZoneTicketUpdatePayload {
  zoneId: Types.ObjectId;
  eventId: Types.ObjectId;
  capacity: number;
  soldCount: number;
  confirmedSoldCount: number;
  availableTickets: number;
}

interface SeatMapUpdatePayload {
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  areaId: Types.ObjectId;
  seats: Array<{ seat: string; status: string }>;
}

@WebSocketGateway({
  cors: {
    origin: getAllowedWsOrigins(),
    credentials: true,
  },
  namespace: "/zone",
})
export class ZoneGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ZoneGateway.name);

  emitZoneTicketUpdate(data: ZoneTicketUpdatePayload) {
    this.server
      .to(`event:${data.eventId.toString()}`)
      .emit("zone.ticket_update", data);
    // chia room theo eventId de chi nhan thong bao cap nhat ve zone cho nhung client quan tam den event do
  }

  emitSeatMapUpdate(data: SeatMapUpdatePayload) {
    this.server
      .to(`event:${data.eventId.toString()}`)
      .emit("seat_map.update", data);
  }
}

// ticket.gateway.ts
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server } from "socket.io";

import { Types } from "mongoose";

function getAllowedWsOrigins(): string[] {
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

interface TicketCreatedPayload {
  bookingCode: string;
  tickets: Array<{
    ticketCode: string;
    eventId: Types.ObjectId;
    zoneId: Types.ObjectId;
    seatNumber: string | null;
    price: number;
    status: string;
  }>;
}

interface TicketCheckinPayload {
  ticketCode: string;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  seatNumber: string | null;
  checkedInAt: Date;
}

interface TicketCancelledPayload {
  ticketCode: string;
  eventId?: Types.ObjectId | string;
  zoneId?: Types.ObjectId | string;
  reason?: string;
  cancelledAt?: Date;
}

@WebSocketGateway({
  cors: {
    origin: getAllowedWsOrigins(),
    credentials: true,
  },
  namespace: "/ticket",
})
export class TicketGateway {
  @WebSocketServer()
  server: Server;

  emitTicketCreated(data: TicketCreatedPayload) {
    const eventId = data.tickets[0]?.eventId;
    if (!eventId) return;
    this.server.to(`event:${eventId.toString()}`).emit("ticket.created", data);
  }

  emitTicketCheckedIn(data: TicketCheckinPayload) {
    this.server
      .to(`event:${data.eventId.toString()}`)
      .emit("ticket.checked_in", data);
    // chia room theo eventId de chi nhan thong bao checkin ve cho nhung client quan tam den event do
  }

  emitTicketCancelled(data: TicketCancelledPayload) {
    this.server.emit("ticket.cancelled", data);
  }
}

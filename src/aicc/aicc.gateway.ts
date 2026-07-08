import { Logger } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server } from "socket.io";
import { getAllowedWsOrigins } from "@src/zone/zone.gateway";
import {
  AiccHandoffPriority,
  AiccHandoffReason,
  AiccHandoffStatus,
} from "./schemas/aicc-handoff.schema";

export interface AiccHandoffEventPayload {
  id: string;
  sessionId: string;
  reason: AiccHandoffReason;
  priority: AiccHandoffPriority;
  status: AiccHandoffStatus;
  summary: string;
  assignedTo?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

@WebSocketGateway({
  cors: {
    origin: getAllowedWsOrigins(),
    credentials: true,
  },
  namespace: "/aicc",
})
export class AiccGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AiccGateway.name);

  emitHandoffCreated(payload: AiccHandoffEventPayload): void {
    this.server.emit("aicc.handoff.created", payload);
    this.logger.debug(`AICC handoff created emitted: ${payload.id}`);
  }

  emitHandoffPicked(payload: AiccHandoffEventPayload): void {
    this.server.emit("aicc.handoff.picked", payload);
    this.logger.debug(`AICC handoff picked emitted: ${payload.id}`);
  }

  emitHandoffResolved(payload: AiccHandoffEventPayload): void {
    this.server.emit("aicc.handoff.resolved", payload);
    this.logger.debug(`AICC handoff resolved emitted: ${payload.id}`);
  }

  emitSessionUpdated(sessionId: string, status: string): void {
    this.server.emit("aicc.session.updated", { sessionId, status });
  }
}

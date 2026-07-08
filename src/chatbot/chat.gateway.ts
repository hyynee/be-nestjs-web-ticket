import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";

const chatAllowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

@WebSocketGateway({
  cors: {
    origin: chatAllowedOrigins.length ? chatAllowedOrigins : false,
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    const token =
      ((client.handshake.auth as Record<string, unknown>)?.token as
        string | undefined) ??
      (client.handshake.headers?.authorization as string | undefined)?.replace(
        /^Bearer\s+/i,
        ""
      );

    if (!token || typeof token !== "string") {
      this.logger.warn(
        `ChatGateway: unauthenticated connection rejected from ${client.id}`
      );
      client.emit("error", { message: "Unauthorized" });
      client.disconnect();
      return;
    }

    try {
      const payload = this.jwtService.verify(token) as Record<string, unknown>;
      client.data.user = payload;
      this.logger.debug(
        `ChatGateway: client ${client.id} authenticated as userId=${payload["userId"]}`
      );
    } catch {
      this.logger.warn(`ChatGateway: invalid token from ${client.id}`);
      client.emit("error", { message: "Unauthorized" });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`ChatGateway: client ${client.id} disconnected`);
  }

  @SubscribeMessage("message")
  handleMessage(
    @MessageBody() data: unknown,
    @ConnectedSocket() client: Socket
  ) {
    if (!client.data?.user) {
      client.emit("error", { message: "Unauthorized" });
      client.disconnect();
      return;
    }

    try {
      client.emit("message", data);
    } catch (error) {
      this.logger.error("ChatGateway: handleMessage error", error);
    }
  }
}

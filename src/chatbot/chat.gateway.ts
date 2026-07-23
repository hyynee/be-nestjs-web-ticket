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
import { RedisSecurityService } from "@src/redis/redis-security.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";

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

  constructor(
    private readonly jwtService: JwtService,
    private readonly redisSecurityService: RedisSecurityService
  ) {}

  private rejectUnauthorized(client: Socket): void {
    client.emit("error", { message: "Unauthorized" });
    client.disconnect();
  }

  private async isTokenBlacklisted(token: string): Promise<boolean> {
    const blacklistEntry = await this.redisSecurityService.client.get(
      `blacklist:access:${token}`
    );
    return blacklistEntry !== null;
  }

  async handleConnection(client: Socket): Promise<void> {
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
      this.rejectUnauthorized(client);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = this.jwtService.verify(token) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(
        `ChatGateway: invalid token from ${client.id}: ${getErrorMessage(error)}`
      );
      this.rejectUnauthorized(client);
      return;
    }

    try {
      if (await this.isTokenBlacklisted(token)) {
        this.logger.warn(
          `ChatGateway: blacklisted token rejected from ${client.id}`
        );
        this.rejectUnauthorized(client);
        return;
      }
    } catch (error) {
      this.logger.error(
        `ChatGateway: blacklist check unavailable, failing closed for ${client.id}: ${getErrorMessage(error)}`
      );
      this.rejectUnauthorized(client);
      return;
    }

    client.data.user = payload;
    client.data.token = token;
    this.logger.debug(
      `ChatGateway: client ${client.id} authenticated as userId=${payload["userId"]}`
    );
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`ChatGateway: client ${client.id} disconnected`);
  }

  @SubscribeMessage("message")
  async handleMessage(
    @MessageBody() data: unknown,
    @ConnectedSocket() client: Socket
  ): Promise<void> {
    const token = client.data?.token as string | undefined;
    if (!client.data?.user || !token) {
      this.rejectUnauthorized(client);
      return;
    }

    try {
      if (await this.isTokenBlacklisted(token)) {
        this.logger.warn(
          `ChatGateway: message rejected, token revoked mid-session for ${client.id}`
        );
        this.rejectUnauthorized(client);
        return;
      }
    } catch (error) {
      this.logger.error(
        `ChatGateway: blacklist check unavailable, failing closed for ${client.id}: ${getErrorMessage(error)}`
      );
      this.rejectUnauthorized(client);
      return;
    }

    try {
      client.emit("message", data);
    } catch (error) {
      this.logger.error("ChatGateway: handleMessage error", error);
    }
  }
}

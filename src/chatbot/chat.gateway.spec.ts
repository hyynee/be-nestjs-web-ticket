import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ChatGateway } from "./chat.gateway";
import { RedisSecurityService } from "@src/redis/redis-security.service";
import { Server, Socket } from "socket.io";

describe("ChatGateway", () => {
  let gateway: ChatGateway;

  const mockJwtService = {
    verify: jest.fn(),
    sign: jest.fn(),
    decode: jest.fn(),
  };

  const mockRedisSecurityClient = {
    get: jest.fn(),
  };

  function createMockSocket(
    overrides: Record<string, any> = {}
  ): jest.Mocked<Socket> {
    const client = {
      id: "socket-1",
      handshake: {
        auth: {},
        headers: {},
        ...overrides.handshake,
      },
      data: {},
      emit: jest.fn(),
      disconnect: jest.fn(),
      ...overrides,
    } as any;
    return client;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedisSecurityClient.get.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: JwtService, useValue: mockJwtService },
        {
          provide: RedisSecurityService,
          useValue: { client: mockRedisSecurityClient },
        },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
    gateway.server = { emit: jest.fn() } as unknown as Server;
  });

  it("should be defined", () => {
    expect(gateway).toBeDefined();
  });

  describe("handleConnection", () => {
    it("should authenticate client with valid token from auth", async () => {
      const payload = { userId: "user-1", role: "user" };
      mockJwtService.verify.mockReturnValue(payload);
      const client = createMockSocket({
        handshake: { auth: { token: "valid-jwt-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).toHaveBeenCalledWith("valid-jwt-token");
      expect(client.data.user).toEqual(payload);
      expect(client.data.token).toBe("valid-jwt-token");
      expect(client.emit).not.toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it("should authenticate client with valid token from Authorization header", async () => {
      const payload = { userId: "user-2", role: "admin" };
      mockJwtService.verify.mockReturnValue(payload);
      const client = createMockSocket({
        handshake: {
          auth: {},
          headers: { authorization: "Bearer header-jwt-token" },
        },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).toHaveBeenCalledWith("header-jwt-token");
      expect(client.data.user).toEqual(payload);
    });

    it("should reject client without token", async () => {
      const client = createMockSocket({
        handshake: { auth: {}, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should reject client with null token", async () => {
      const client = createMockSocket({
        handshake: { auth: { token: null }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should reject client with empty string token", async () => {
      const client = createMockSocket({
        handshake: { auth: { token: "" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should reject client with empty Authorization header", async () => {
      const client = createMockSocket({
        handshake: {
          auth: {},
          headers: { authorization: "" },
        },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should reject client when JWT verify throws", async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error("jwt expired");
      });
      const client = createMockSocket({
        handshake: { auth: { token: "expired-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).toHaveBeenCalledWith("expired-token");
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should reject client when JWT verify throws with specific error", async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error("invalid signature");
      });
      const client = createMockSocket({
        handshake: { auth: { token: "forged-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should prefer auth token over Authorization header", async () => {
      const payload = { userId: "from-auth" };
      mockJwtService.verify.mockReturnValue(payload);
      const client = createMockSocket({
        handshake: {
          auth: { token: "auth-token" },
          headers: { authorization: "Bearer header-token" },
        },
      });

      await gateway.handleConnection(client);

      expect(mockJwtService.verify).toHaveBeenCalledWith("auth-token");
    });

    it("should reject a connection whose token is blacklisted (revoked/logged-out)", async () => {
      const payload = { userId: "user-1", role: "user" };
      mockJwtService.verify.mockReturnValue(payload);
      mockRedisSecurityClient.get.mockResolvedValue("1");
      const client = createMockSocket({
        handshake: { auth: { token: "revoked-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockRedisSecurityClient.get).toHaveBeenCalledWith(
        "blacklist:access:revoked-token"
      );
      expect(client.data.user).toBeUndefined();
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should accept a connection whose token is not blacklisted", async () => {
      const payload = { userId: "user-1", role: "user" };
      mockJwtService.verify.mockReturnValue(payload);
      mockRedisSecurityClient.get.mockResolvedValue(null);
      const client = createMockSocket({
        handshake: { auth: { token: "clean-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(client.data.user).toEqual(payload);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it("should fail closed (reject) when the blacklist check itself errors", async () => {
      const payload = { userId: "user-1", role: "user" };
      mockJwtService.verify.mockReturnValue(payload);
      mockRedisSecurityClient.get.mockRejectedValue(
        new Error("Redis connection lost")
      );
      const client = createMockSocket({
        handshake: { auth: { token: "some-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(client.data.user).toBeUndefined();
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should not check the blacklist when the token itself is invalid", async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error("jwt expired");
      });
      const client = createMockSocket({
        handshake: { auth: { token: "expired-token" }, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(mockRedisSecurityClient.get).not.toHaveBeenCalled();
    });
  });

  describe("handleDisconnect", () => {
    it("should handle disconnect without throwing", () => {
      const client = createMockSocket();

      expect(() => gateway.handleDisconnect(client)).not.toThrow();
    });
  });

  describe("handleMessage", () => {
    it("should echo message back to authenticated client whose token is not blacklisted", async () => {
      const client = createMockSocket();
      client.data.user = { userId: "user-1" };
      client.data.token = "clean-token";
      mockRedisSecurityClient.get.mockResolvedValue(null);
      const messageData = { text: "Hello" };

      await gateway.handleMessage(messageData, client);

      expect(mockRedisSecurityClient.get).toHaveBeenCalledWith(
        "blacklist:access:clean-token"
      );
      expect(client.emit).toHaveBeenCalledWith("message", messageData);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it("should disconnect unauthenticated client", async () => {
      const client = createMockSocket();
      client.data.user = undefined;
      client.data.token = undefined;
      const messageData = { text: "Hello" };

      await gateway.handleMessage(messageData, client);

      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
      expect(mockRedisSecurityClient.get).not.toHaveBeenCalled();
    });

    it("should disconnect client with data.user set to null", async () => {
      const client = createMockSocket();
      client.data.user = null;
      client.data.token = undefined;
      const messageData = "test";

      await gateway.handleMessage(messageData, client);

      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("should handle emit error gracefully", async () => {
      const client = createMockSocket();
      client.data.user = { userId: "user-1" };
      client.data.token = "clean-token";
      mockRedisSecurityClient.get.mockResolvedValue(null);
      client.emit = jest.fn().mockImplementation(() => {
        throw new Error("Emit failed");
      });

      await expect(
        gateway.handleMessage("test", client)
      ).resolves.not.toThrow();
    });

    it("should handle various message data types", async () => {
      const client = createMockSocket();
      client.data.user = { userId: "user-1" };
      client.data.token = "clean-token";
      mockRedisSecurityClient.get.mockResolvedValue(null);

      await gateway.handleMessage("string message", client);
      expect(client.emit).toHaveBeenCalledWith("message", "string message");

      await gateway.handleMessage({ key: "value" }, client);
      expect(client.emit).toHaveBeenCalledWith("message", { key: "value" });

      await gateway.handleMessage(42, client);
      expect(client.emit).toHaveBeenCalledWith("message", 42);
    });

    it("should reject and disconnect when the token was blacklisted after connect (logout mid-session)", async () => {
      const client = createMockSocket();
      client.data.user = { userId: "user-1" };
      client.data.token = "now-revoked-token";
      mockRedisSecurityClient.get.mockResolvedValue("1");
      const messageData = { text: "Hello" };

      await gateway.handleMessage(messageData, client);

      expect(mockRedisSecurityClient.get).toHaveBeenCalledWith(
        "blacklist:access:now-revoked-token"
      );
      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
      expect(client.emit).not.toHaveBeenCalledWith("message", messageData);
    });

    it("should fail closed (reject) when the blacklist check errors mid-session", async () => {
      const client = createMockSocket();
      client.data.user = { userId: "user-1" };
      client.data.token = "some-token";
      mockRedisSecurityClient.get.mockRejectedValue(
        new Error("Redis connection lost")
      );
      const messageData = { text: "Hello" };

      await gateway.handleMessage(messageData, client);

      expect(client.emit).toHaveBeenCalledWith("error", {
        message: "Unauthorized",
      });
      expect(client.disconnect).toHaveBeenCalled();
      expect(client.emit).not.toHaveBeenCalledWith("message", messageData);
    });
  });
});

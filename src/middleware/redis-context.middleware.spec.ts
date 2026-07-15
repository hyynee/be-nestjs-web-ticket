import { RedisContextMiddleware } from "./redis-context.middleware";
import { RedisService } from "@src/redis/redis.service";
import type { Request, Response, NextFunction } from "express";

describe("RedisContextMiddleware", () => {
  it("attaches redis client to request", () => {
    const mockClient = { isOpen: true };
    const redisService = { client: mockClient } as unknown as RedisService;
    const middleware = new RedisContextMiddleware(redisService);
    const req = {} as Request;
    const next = jest.fn() as NextFunction;

    middleware.use(req, {} as Response, next);

    expect((req as any).redisUserTokenCache).toBe(mockClient);
    expect(next).toHaveBeenCalled();
  });
});

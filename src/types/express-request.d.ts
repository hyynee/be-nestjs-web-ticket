import type { createClient } from "redis";
import type { Lookup } from "geoip-lite";
import type { JwtPayload } from "@src/auth/dto/jwt-payload.dto";

type AppRedisClient = ReturnType<typeof createClient>;

declare global {
  namespace Express {
    interface Request {
      ipInfo?: (Lookup & { ip: string }) | null;
      redisUserTokenCache?: AppRedisClient;
      currentUser?: JwtPayload;
    }
  }
}

export {};

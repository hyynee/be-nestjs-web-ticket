import { Injectable } from "@nestjs/common";
import * as mongoose from "mongoose";
import { RedisService } from "./redis/redis.service";

@Injectable()
export class AppService {
  constructor(private readonly redisService: RedisService) {}

  getHealth() {
    return { status: "ok" };
  }

  getReadiness() {
    try {
      const mongoConnectedState =
        mongoose.ConnectionStates?.connected ?? mongoose.STATES.connected;
      const mongoReady =
        mongoose.connection.readyState === mongoConnectedState;
      const redisReady = Boolean(this.redisService?.client?.isOpen);
      const ready = mongoReady && redisReady;

      return {
        status: ready ? "ready" : "not_ready",
        dependencies: {
          mongodb: mongoReady ? "up" : "down",
          redis: redisReady ? "up" : "down",
        },
      };
    } catch {
      return {
        status: "not_ready",
        dependencies: {
          mongodb: "down",
          redis: "down",
        },
      };
    }
  }
}

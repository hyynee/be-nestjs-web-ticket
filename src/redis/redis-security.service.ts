import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { RedisClientOptions, createClient } from "redis";

type RedisEndpointSource = "security" | "queue" | "cache";

interface RedisEndpoint {
  host: string;
  port: number;
  password?: string;
  tls?: boolean;
  source: RedisEndpointSource;
}

/**
 * Dedicated Redis connection for security-critical revocation data (JWT
 * access-token blacklist). MUST stay isolated from BOTH:
 * - the general-purpose app cache (`REDIS_HOST`), which runs `volatile-lru`
 *   and can evict TTL'd keys under memory pressure, silently un-revoking a
 *   logged-out/force-revoked token (production-readiness-audit-2026-07-22.md
 *   PRE-1); and
 * - the BullMQ queue instance (`REDIS_QUEUE_HOST`), which was the previous
 *   fix for PRE-1 but collapsed auth and job processing into one failure
 *   domain — a single `redis-queue` outage then 401'd 100% of authenticated
 *   traffic in addition to halting every queued job (2026-07-23 audit, "NEW
 *   HIGH — Redis outage blast-radius merged").
 *
 * `REDIS_SECURITY_*` is therefore its own, third, independent Redis
 * endpoint. In production, `REDIS_SECURITY_HOST`/`REDIS_SECURITY_PORT` are
 * required (enforced primarily by `env.validation.ts` at Nest bootstrap) and
 * MUST NOT resolve to the same host+port as either the cache or the queue —
 * this class re-checks that itself as a defense-in-depth measure in case
 * some other bootstrap path skipped `validateEnvironment`. Falling back to
 * the queue, then the cache, is only ever permitted outside production, and
 * always logs a clear warning identifying which fallback tier was used.
 */
@Injectable()
export class RedisSecurityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSecurityService.name);
  readonly client: ReturnType<typeof createClient>;

  constructor(private readonly configService: ConfigService) {
    const isProduction =
      this.configService.get<string>("NODE_ENV") === "production";

    const endpoint = this.resolveEndpoint(isProduction);
    this.assertNoProductionCollision(isProduction, endpoint);

    const rawDatabase = this.configService.get<string>("REDIS_SECURITY_DB");
    const database = rawDatabase ? Number(rawDatabase) : 1;
    if (Number.isNaN(database)) {
      throw new Error(
        "[RedisSecurity] REDIS_SECURITY_DB must be a valid number"
      );
    }

    const redisOptions: RedisClientOptions = {
      socket: {
        host: endpoint.host,
        port: endpoint.port,
        ...(endpoint.tls ? { tls: true as const } : {}),
        reconnectStrategy: (retries: number) => {
          if (retries > 20) {
            this.logger.error(
              "[RedisSecurity] Max reconnection attempts reached — giving up"
            );
            return new Error("Max RedisSecurity reconnection attempts reached");
          }
          const delay = Math.min(retries * 100, 2000);
          this.logger.warn(
            `[RedisSecurity] reconnecting in ${delay}ms (attempt ${retries})`
          );
          return delay;
        },
        connectTimeout: 5000,
      },
      commandsQueueMaxLength: 5000,
      database,
    };
    if (endpoint.password) {
      redisOptions.password = endpoint.password;
    }
    this.client = createClient(redisOptions);

    this.client.on("error", (err) => {
      this.logger.error(`[RedisSecurity] error: ${getErrorMessage(err)}`);
    });

    this.logger.log(
      `[RedisSecurity] using ${endpoint.source} endpoint — host=${endpoint.host}, port=${endpoint.port}, db=${database}`
    );
  }

  /**
   * Resolves the endpoint this service connects to, in strict priority
   * order: dedicated security Redis first, then (non-production only) the
   * queue Redis, then (non-production only) the general cache Redis. Each
   * tier's host/port/password are read together so a partial mix (e.g.
   * security host with queue port) can never happen.
   */
  private resolveEndpoint(isProduction: boolean): RedisEndpoint {
    const securityHost = this.configService.get<string>("REDIS_SECURITY_HOST");
    if (securityHost) {
      const rawPort = this.configService.get<string>("REDIS_SECURITY_PORT");
      const port = Number(rawPort);
      if (Number.isNaN(port)) {
        throw new Error(
          "[RedisSecurity] REDIS_SECURITY_PORT must be a valid number"
        );
      }
      return {
        host: securityHost,
        port,
        password: this.configService.get<string>("REDIS_SECURITY_PASSWORD"),
        // Managed/hosted Redis providers (e.g. Upstash) require TLS on the
        // standard Redis-protocol port; self-hosted instances (local Docker,
        // docker-compose) do not speak TLS at all. Opt-in only, so the
        // existing plain-TCP docker-compose/local setups are unaffected.
        tls: this.configService.get<string>("REDIS_SECURITY_TLS") === "true",
        source: "security",
      };
    }

    if (isProduction) {
      // env.validation.ts already refuses to boot the app without
      // REDIS_SECURITY_HOST in production — this is the last line of
      // defense in case some other bootstrap path (a script, a different
      // entrypoint) skipped that validation.
      throw new Error(
        "[RedisSecurity] REDIS_SECURITY_HOST is required in production and must not fall back to redis-queue/redis-cache — a dedicated security Redis instance is required to avoid reintroducing PRE-1 (evictable blacklist) or collapsing auth into the queue's failure domain"
      );
    }

    const queueHost = this.configService.get<string>("REDIS_QUEUE_HOST");
    if (queueHost) {
      this.logger.warn(
        "[RedisSecurity] REDIS_SECURITY_HOST not set — falling back to REDIS_QUEUE_HOST for local/dev/test only. This fallback is refused in production."
      );
      const rawPort = this.configService.get<string>("REDIS_QUEUE_PORT");
      const port = Number(rawPort);
      if (Number.isNaN(port)) {
        throw new Error(
          "[RedisSecurity] REDIS_QUEUE_PORT must be a valid number"
        );
      }
      return {
        host: queueHost,
        port,
        password:
          this.configService.get<string>("REDIS_QUEUE_PASSWORD") ??
          this.configService.get<string>("REDIS_PASSWORD"),
        source: "queue",
      };
    }

    this.logger.warn(
      "[RedisSecurity] REDIS_SECURITY_HOST and REDIS_QUEUE_HOST not set — falling back to REDIS_HOST (general-purpose cache) for local/dev/test only. This fallback is refused in production."
    );
    const cacheHost = this.configService.getOrThrow<string>("REDIS_HOST");
    const rawPort = this.configService.getOrThrow<string>("REDIS_PORT");
    const port = Number(rawPort);
    if (Number.isNaN(port)) {
      throw new Error("[RedisSecurity] REDIS_PORT must be a valid number");
    }
    return {
      host: cacheHost,
      port,
      password: this.configService.get<string>("REDIS_PASSWORD"),
      source: "cache",
    };
  }

  /**
   * Defense-in-depth: in production, refuse to start if the resolved
   * security endpoint happens to be the same physical host+port as either
   * the cache or the queue Redis — even though `resolveEndpoint` should
   * already have thrown before ever reaching a non-"security" source in
   * production, this catches the case where REDIS_SECURITY_HOST/PORT were
   * explicitly (mis)configured to literally equal one of the other two
   * instances. Host/port is compared, not the logical DB index: two
   * connections to the same physical instance still share its memory
   * policy and its availability — the entire point of this separation is
   * SPOF elimination, which only host/port isolation actually guarantees.
   */
  private assertNoProductionCollision(
    isProduction: boolean,
    endpoint: RedisEndpoint
  ): void {
    if (!isProduction || endpoint.source !== "security") {
      return;
    }

    const cacheHost = this.configService.getOrThrow<string>("REDIS_HOST");
    const cachePort = Number(
      this.configService.getOrThrow<string>("REDIS_PORT")
    );
    if (this.sameEndpoint(endpoint, cacheHost, cachePort)) {
      throw new Error(
        "[RedisSecurity] Refusing to start: REDIS_SECURITY_HOST/PORT must not be the same endpoint as REDIS_HOST/PORT (the evictable cache instance) in production"
      );
    }

    const queueHost =
      this.configService.get<string>("REDIS_QUEUE_HOST") ?? cacheHost;
    const queuePortRaw = this.configService.get<string>("REDIS_QUEUE_PORT");
    const queuePort = queuePortRaw ? Number(queuePortRaw) : cachePort;
    if (this.sameEndpoint(endpoint, queueHost, queuePort)) {
      throw new Error(
        "[RedisSecurity] Refusing to start: REDIS_SECURITY_HOST/PORT must not be the same endpoint as the queue Redis (REDIS_QUEUE_HOST/PORT, or REDIS_HOST/PORT if the queue has no dedicated host) in production — a shared instance collapses auth and BullMQ into a single failure domain"
      );
    }
  }

  private sameEndpoint(
    endpoint: RedisEndpoint,
    otherHost: string,
    otherPort: number
  ): boolean {
    return (
      endpoint.host.trim().toLowerCase() === otherHost.trim().toLowerCase() &&
      endpoint.port === otherPort
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log("[RedisSecurity] connected successfully");
    } catch (err) {
      const isProduction =
        this.configService.get<string>("NODE_ENV") === "production";
      const message = `[RedisSecurity] connect failed: ${getErrorMessage(err)}`;
      this.logger.error(message);

      if (isProduction) {
        throw new Error(
          "[RedisSecurity] Startup aborted because the security Redis instance is unavailable in production"
        );
      }

      this.logger.warn(
        "[RedisSecurity] continuing startup because NODE_ENV is not production"
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}

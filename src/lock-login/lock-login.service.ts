import { Inject, Injectable } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";

@Injectable()
export class LockLoginService {
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LOCK_TIME_SECONDS = 15 * 60; // 15 minutes

  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly redisService: RedisService
  ) {}

  private buildLockKey(identifier: string, ipAddress: string): string {
    const safeIdentifier = encodeURIComponent(
      (identifier || "unknown").trim().toLowerCase()
    );
    const safeIpAddress = encodeURIComponent((ipAddress || "unknown").trim());
    return `auth:fail:${safeIdentifier}:${safeIpAddress}`;
  }

  // Check tài khoản có bị khóa không
  async isLocked(identifier: string, ipAddress: string): Promise<boolean> {
    // Check global per-email lockout first
    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9@._-]/g, "");
    const emailKey = `auth:fail:email:${safeIdentifier}`;
    const globalFailures = await this.redisService.client.get(emailKey);
    if (globalFailures && parseInt(globalFailures, 10) >= 10) {
      return true;
    }

    const key = this.buildLockKey(identifier, ipAddress);
    const failedCount = Number((await this.redisService.client.get(key)) || 0);

    if (failedCount < this.MAX_FAILED_ATTEMPTS) {
      return false;
    }
    const ttl = await this.redisService.client.ttl(key);
    // TTL <= 0 nghĩa là key đã hết hạn hoặc không có expire, dọn key để tránh trạng thái kẹt.
    if (ttl <= 0) {
      await this.redisService.client.del(key);
      return false;
    }
    return true;
  }

  // Ghi nhận lần đăng nhập sai
  async recordFailedAttempt(
    identifier: string,
    ipAddress: string
  ): Promise<void> {
    const key = this.buildLockKey(identifier, ipAddress);
    const failedCount = await this.redisService.client.incr(key);
    await this.redisService.client.expire(key, this.LOCK_TIME_SECONDS, "NX");

    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9@._-]/g, "");
    const emailKey = `auth:fail:email:${safeIdentifier}`;
    await this.redisService.client.incr(emailKey);
    await this.redisService.client.expire(
      emailKey,
      this.LOCK_TIME_SECONDS,
      "NX"
    );

    const ttl = await this.redisService.client.ttl(key);
    if (failedCount >= this.MAX_FAILED_ATTEMPTS) {
      this.logger.error({
        message: "Account LOCKED due to too many failed attempts",
        context: "security",
        identifier,
        ipAddress,
        failedCount,
        ttlSeconds: ttl,
        lockDurationMinutes: this.LOCK_TIME_SECONDS / 60,
      });
      return;
    }

    this.logger.warn({
      message:
        failedCount === 1
          ? "First failed login attempt"
          : "Failed login attempt",
      context: "security",
      identifier,
      ipAddress,
      attemptCount: failedCount,
      remainingAttempts: this.MAX_FAILED_ATTEMPTS - failedCount,
      ttlSeconds: ttl,
    });
  }

  async resetLocked(identifier: string, ipAddress: string): Promise<void> {
    const key = this.buildLockKey(identifier, ipAddress);
    const deletedCount = await this.redisService.client.del(key);

    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9@._-]/g, "");
    const emailKey = `auth:fail:email:${safeIdentifier}`;
    await this.redisService.client.del(emailKey).catch(() => {});

    if (deletedCount > 0) {
      this.logger.info({
        message: "Login attempts reset (successful login or manual unlock)",
        context: "security",
        identifier,
        ipAddress,
      });
    }
  }
}

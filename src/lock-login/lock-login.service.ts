import { Inject, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { LoginAttempt } from "@src/schemas/lock-login.schema";
import { Model } from "mongoose";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";

@Injectable()
export class LockLoginService {
    private readonly MAX_FAILED_ATTEMPTS = 5;
    private readonly LOCK_TIME = 15 * 60 * 1000; // 15 minutes

    constructor(
        @InjectModel(LoginAttempt.name)
        private readonly loginModel: Model<LoginAttempt>,
        @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    ) { }

    // Check tài khoản có bị khóa không
    async isLocked(identifier: string, ipAddress: string): Promise<boolean> {
        const record = await this.loginModel.findOne({ identifier, ipAddress });
        if (!record || !record.lockedUntil) {
            return false;
        }
        const now = new Date();
        // Auto-unlock nếu hết thời gian
        if (record.lockedUntil <= now) {
            await this.resetLocked(identifier, ipAddress);
            this.logger.info({
                message: 'Account auto-unlocked after lock period expired',
                context: 'security',
                identifier,
                ipAddress,
                lockedUntil: record.lockedUntil.toISOString()
            });
            return false;
        }
        return true;
    }

    // Ghi nhận lần đăng nhập sai
    async recordFailedAttempt(identifier: string, ipAddress: string): Promise<void> {
        let record = await this.loginModel.findOne({ identifier, ipAddress });
        const now = new Date();

        if (!record) {
            record = new this.loginModel({
                identifier,
                ipAddress,
                failedCount: 1,
                lastFailedAt: now,
            });

            this.logger.warn({
                message: 'First failed login attempt',
                context: 'security',
                identifier,
                ipAddress,
                attemptCount: 1,
                remainingAttempts: this.MAX_FAILED_ATTEMPTS - 1
            });

        } else {
            if (record.lockedUntil && record.lockedUntil <= now) { // Hết thời gian khóa
                await this.loginModel.deleteOne({ identifier, ipAddress });
                record = new this.loginModel({
                    identifier,
                    ipAddress,
                    failedCount: 1,
                    lastFailedAt: now,
                });
                this.logger.warn({
                    message: 'Failed login after lock period expired (record reset)',
                    context: 'security',
                    identifier,
                    ipAddress,
                    attemptCount: 1,
                    remainingAttempts: this.MAX_FAILED_ATTEMPTS - 1
                });
            } else {
                record.failedCount += 1;
                record.lastFailedAt = now;

                if (record.failedCount >= this.MAX_FAILED_ATTEMPTS) {
                    record.lockedUntil = new Date(Date.now() + this.LOCK_TIME);

                    this.logger.error({
                        message: 'Account LOCKED due to too many failed attempts',
                        context: 'security',
                        identifier,
                        ipAddress,
                        failedCount: record.failedCount,
                        lockedUntil: record.lockedUntil.toISOString(),
                        lockDurationMinutes: this.LOCK_TIME / 60000
                    });

                } else {
                    this.logger.warn({
                        message: 'Failed login attempt',
                        context: 'security',
                        identifier,
                        ipAddress,
                        attemptCount: record.failedCount,
                        remainingAttempts: this.MAX_FAILED_ATTEMPTS - record.failedCount
                    });
                }
            }
        }
        await record.save();
    }

    async resetLocked(identifier: string, ipAddress: string): Promise<void> {
        const result = await this.loginModel.deleteOne({ identifier, ipAddress });

        if (result.deletedCount > 0) {
            this.logger.info({
                message: 'Login attempts reset (successful login or manual unlock)',
                context: 'security',
                identifier,
                ipAddress
            });
        }
    }
}
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { LoginAttempt } from "@src/schemas/lock-login.schema";
import { Model } from "mongoose";


@Injectable()
export class LockLoginService {
    private readonly MAX_FAILED_ATTEMPTS = 5;
    private readonly LOCK_TIME = 15 * 60 * 1000; // 15 minutes

    constructor(
    @InjectModel(LoginAttempt.name) 
    private readonly loginModel: Model<LoginAttempt>,
  ) {}
    // check tài khoản có bị khoá ip k
    async isLocked(identifier: string, ipAddress: string): Promise<boolean> {
        let record = await this.loginModel.findOne({ identifier, ipAddress });
        if (!record || !record.lockedUntil) return false;
        return record.lockedUntil > new Date();
    }
    // check số lần đăng nhập sai
    async recordFailedAttempt(identifier: string, ipAddress: string): Promise<void> {
        let record = await this.loginModel.findOne({ identifier, ipAddress });
        if (!record) {
            // check lần đầu đăng nhập sai
            record = new this.loginModel({
                identifier,
                ipAddress,
                failedCount: 1,
                lastFailedAt: new Date(),
            })
        } else {
            // cộng dồn số lần đăng nhập sai
            record.failedCount += 1;
            record.lastFailedAt = new Date();
            // band tk
            if (record.failedCount >= this.MAX_FAILED_ATTEMPTS) {
                record.lockedUntil = new Date(Date.now() + this.LOCK_TIME);
            }
        }
        await record.save();
    }
    async resetLocked(identifier: string, ipAddress: string): Promise<void> {
        await this.loginModel.deleteOne({ identifier, ipAddress });
    }
}
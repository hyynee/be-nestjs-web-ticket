import { Injectable, } from '@nestjs/common';
import { ThrottlerGuard, } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
        // Dùng userId nếu đã login, không thì dùng IP
        return req.user?.userId ? `user:${req.user.userId}` : req.ip;
    }
}


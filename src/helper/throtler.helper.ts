import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as {
      user?: { userId?: string };
      ip?: string;
    };

    if (request.user?.userId) {
      return Promise.resolve(`user:${request.user.userId}`);
    }

    return Promise.resolve(request.ip ?? "unknown");
  }
}

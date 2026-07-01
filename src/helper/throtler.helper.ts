import { ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { ThrottlerException, ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  private readonly throttlerLogger = new Logger(CustomThrottlerGuard.name);

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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (error instanceof ThrottlerException) {
        throw error;
      }
      this.throttlerLogger.error(
        `ThrottlerGuard: Redis storage error, failing open — ${(error as Error)?.message ?? "unknown"}`
      );
      return true;
    }
  }
}

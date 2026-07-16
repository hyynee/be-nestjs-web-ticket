import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard("jwt") {
  handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser | false | null,
    info: unknown,
    context: ExecutionContext,
    status?: unknown
  ): TUser | null {
    void info;
    void context;
    void status;
    if (err) return null;
    return user || null;
  }
}

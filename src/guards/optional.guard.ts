import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard("jwt") {
  handleRequest<TUser = any>(
    err: any,
    user: any,
    info: any,
    context: any,
    status?: any
  ): TUser {
    void info;
    void context;
    void status;
    if (err) return null as TUser;
    return (user ?? null) as TUser;
  }
}

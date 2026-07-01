import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { Request, Response } from "express";
import { MetricsService } from "./metrics.service";

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    if (!ctx) return next.handle();

    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const method = req.method ?? "UNKNOWN";
    // Use the route pattern (e.g. /api/v1/booking/:id) not the resolved URL
    // so cardinality stays bounded even with millions of unique IDs.
    const route =
      (req.route?.path as string | undefined) ?? req.path ?? "unknown";

    const endTimer = this.metricsService.httpRequestDuration.startTimer({
      method,
      route,
    });

    return next.handle().pipe(
      tap({
        next: () => endTimer({ status_code: String(res.statusCode) }),
        error: () => endTimer({ status_code: String(res.statusCode || 500) }),
      })
    );
  }
}

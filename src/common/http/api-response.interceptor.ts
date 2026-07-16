import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { Observable, map } from "rxjs";
import { CORRELATION_ID_HEADER } from "@src/middleware/correlation-id.middleware";
import { ApiResponse, SKIP_API_RESPONSE_METADATA } from "./api-response";

interface MessagePayload {
  message?: unknown;
}

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const handlerSkipped = this.reflector.getAllAndOverride<boolean>(
      SKIP_API_RESPONSE_METADATA,
      [context.getHandler(), context.getClass()]
    );

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();

    if (handlerSkipped || this.shouldSkip(req.path)) {
      return next.handle();
    }

    return next.handle().pipe(
      map((body: unknown) => {
        if (res.headersSent || ApiResponse.isEnvelope(body)) {
          return body;
        }

        return ApiResponse.success({
          data: body ?? null,
          statusCode: res.statusCode,
          message: this.resolveMessage(body),
          path: req.originalUrl ?? req.url,
          correlationId: this.resolveCorrelationId(req),
        });
      })
    );
  }

  private shouldSkip(path?: string): boolean {
    if (!path) {
      return false;
    }

    return (
      path === "/metrics" ||
      path === "/internal/metrics" ||
      path === "/health" ||
      path === "/ready" ||
      path === "/health/live" ||
      path === "/health/ready" ||
      path.includes("/payment/webhook") ||
      path.startsWith("/api/v1/export") ||
      path.startsWith("/export")
    );
  }

  private resolveMessage(body: unknown): string {
    if (!body || typeof body !== "object") {
      return "Success";
    }

    const maybeMessage = (body as MessagePayload).message;
    return typeof maybeMessage === "string" && maybeMessage.trim()
      ? maybeMessage
      : "Success";
  }

  private resolveCorrelationId(
    req: Request & { correlationId?: string }
  ): string | undefined {
    const headerValue = req.headers[CORRELATION_ID_HEADER];
    if (typeof req.correlationId === "string") {
      return req.correlationId;
    }

    if (typeof headerValue === "string") {
      return headerValue;
    }

    return undefined;
  }
}

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { CORRELATION_ID_HEADER } from "@src/middleware/correlation-id.middleware";

const MONGO_TRANSIENT_ERRORS = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyDestroyedError",
]);

function isMongoTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return typeof name === "string" && MONGO_TRANSIENT_ERRORS.has(name);
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();

    const correlationId =
      request.correlationId ??
      (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
      undefined;

    let status: number;
    let message: string | string[];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else {
        const raw = (res as Record<string, unknown>).message;
        if (Array.isArray(raw)) {
          message = raw as string[];
        } else if (raw !== undefined && raw !== null) {
          message = String(raw);
        } else {
          message = exception.message;
        }
      }
    } else if (isMongoTransient(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "Database temporarily unavailable, please retry";
      this.logger.error(
        `[${correlationId ?? "no-id"}] MongoDB transient error on ${request.method} ${request.url}: ${
          (exception as Error).message
        }`
      );
    } else if (
      exception instanceof Error &&
      exception.name === "CastError" &&
      (exception as unknown as Record<string, unknown>).kind === "ObjectId"
    ) {
      status = HttpStatus.BAD_REQUEST;
      message = "Invalid ID format";
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = "Internal server error";
      this.logger.error(
        `[${correlationId ?? "no-id"}] Unhandled exception on ${request.method} ${request.url}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
        exception instanceof Error ? exception.stack : undefined
      );
    }

    const body: Record<string, unknown> = {
      success: false,
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (correlationId) {
      body.correlationId = correlationId;
    }

    response.status(status).json(body);
  }
}

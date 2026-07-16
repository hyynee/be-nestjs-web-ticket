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
import { ApiResponse } from "@src/common/http/api-response";

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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function resolveExceptionMessage(
  responseBody: unknown,
  fallback: string
): string | string[] {
  if (typeof responseBody === "string") {
    return responseBody;
  }

  if (!isObject(responseBody)) {
    return fallback;
  }

  const rawMessage = responseBody.message;
  if (Array.isArray(rawMessage)) {
    return rawMessage.map((item) => String(item));
  }

  if (rawMessage !== undefined && rawMessage !== null) {
    return String(rawMessage);
  }

  return fallback;
}

function resolveExceptionCode(
  responseBody: unknown,
  status: number
): string | undefined {
  if (!isObject(responseBody)) {
    return undefined;
  }

  const rawCode = responseBody.code ?? responseBody.errorCode;
  if (typeof rawCode === "string" && rawCode.trim()) {
    return rawCode;
  }

  const rawError = responseBody.error;
  if (typeof rawError === "string" && rawError.trim()) {
    return rawError.toUpperCase().replace(/\s+/g, "_");
  }

  if (
    status === HttpStatus.BAD_REQUEST &&
    Array.isArray(responseBody.message)
  ) {
    return "VALIDATION_ERROR";
  }

  return undefined;
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
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = resolveExceptionMessage(res, exception.message);
      code = resolveExceptionCode(res, status);
    } else if (isMongoTransient(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "Database temporarily unavailable, please retry";
      code = "DATABASE_TEMPORARILY_UNAVAILABLE";
      this.logger.error(
        `[${correlationId ?? "no-id"}] MongoDB transient error on ${request.method} ${request.url}: ${
          (exception as Error).message
        }`
      );
    } else if (
      exception instanceof Error &&
      exception.name === "CastError" &&
      isObject(exception) &&
      exception.kind === "ObjectId"
    ) {
      status = HttpStatus.BAD_REQUEST;
      message = "Invalid ID format";
      code = "INVALID_ID_FORMAT";
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = "Internal server error";
      code = "INTERNAL_SERVER_ERROR";
      this.logger.error(
        `[${correlationId ?? "no-id"}] Unhandled exception on ${request.method} ${request.url}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
        exception instanceof Error ? exception.stack : undefined
      );
    }

    const body = ApiResponse.error({
      statusCode: status,
      code,
      message,
      path: request.url,
      correlationId,
    });

    response.status(status).json(body);
  }
}

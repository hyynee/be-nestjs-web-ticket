import { HttpStatus, SetMetadata } from "@nestjs/common";

export const API_RESPONSE_SCHEMA_VERSION = "v1";
export const SKIP_API_RESPONSE_METADATA = "skipApiResponseEnvelope";

export type ApiResponseMetaPrimitive = string | number | boolean | null | Date;

export type ApiResponseMetaValue =
  | ApiResponseMetaPrimitive
  | ApiResponseMetaPrimitive[]
  | Record<string, ApiResponseMetaPrimitive | ApiResponseMetaPrimitive[]>;

export type ApiResponseMeta = Record<string, ApiResponseMetaValue>;

export interface ApiErrorDetail {
  field?: string;
  code: string;
  message: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string | string[];
  details?: ApiErrorDetail[];
}

export interface ApiResponseEnvelope<TData> {
  success: true;
  schemaVersion: typeof API_RESPONSE_SCHEMA_VERSION;
  statusCode: number;
  code: string;
  message: string;
  data: TData;
  meta?: ApiResponseMeta;
  timestamp: string;
  path?: string;
  correlationId?: string;
}

export interface ApiErrorResponseEnvelope {
  success: false;
  schemaVersion: typeof API_RESPONSE_SCHEMA_VERSION;
  statusCode: number;
  code: string;
  message: string | string[];
  error: ApiErrorPayload;
  timestamp: string;
  path?: string;
  correlationId?: string;
}

export type ApiHttpResponse<TData> =
  ApiResponseEnvelope<TData> | ApiErrorResponseEnvelope;

export interface BuildSuccessResponseOptions<TData> {
  data: TData;
  statusCode?: number;
  code?: string;
  message?: string;
  meta?: ApiResponseMeta;
  path?: string;
  correlationId?: string;
  timestamp?: Date;
}

export interface BuildErrorResponseOptions {
  statusCode?: number;
  code?: string;
  message: string | string[];
  details?: ApiErrorDetail[];
  path?: string;
  correlationId?: string;
  timestamp?: Date;
}

export class ApiResponse {
  static success<TData>(
    options: BuildSuccessResponseOptions<TData>
  ): ApiResponseEnvelope<TData> {
    const statusCode = options.statusCode ?? HttpStatus.OK;

    return {
      success: true,
      schemaVersion: API_RESPONSE_SCHEMA_VERSION,
      statusCode,
      code: options.code ?? ApiResponse.defaultSuccessCode(statusCode),
      message: options.message ?? "Success",
      data: options.data,
      ...(options.meta ? { meta: options.meta } : {}),
      timestamp: (options.timestamp ?? new Date()).toISOString(),
      ...(options.path ? { path: options.path } : {}),
      ...(options.correlationId
        ? { correlationId: options.correlationId }
        : {}),
    };
  }

  static error(options: BuildErrorResponseOptions): ApiErrorResponseEnvelope {
    const statusCode = options.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const code = options.code ?? ApiResponse.defaultErrorCode(statusCode);

    return {
      success: false,
      schemaVersion: API_RESPONSE_SCHEMA_VERSION,
      statusCode,
      code,
      message: options.message,
      error: {
        code,
        message: options.message,
        ...(options.details ? { details: options.details } : {}),
      },
      timestamp: (options.timestamp ?? new Date()).toISOString(),
      ...(options.path ? { path: options.path } : {}),
      ...(options.correlationId
        ? { correlationId: options.correlationId }
        : {}),
    };
  }

  static isEnvelope(value: unknown): value is ApiHttpResponse<unknown> {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Partial<ApiHttpResponse<unknown>>;
    return (
      candidate.schemaVersion === API_RESPONSE_SCHEMA_VERSION &&
      typeof candidate.success === "boolean" &&
      typeof candidate.statusCode === "number" &&
      typeof candidate.code === "string"
    );
  }

  private static defaultSuccessCode(statusCode: number): string {
    if (statusCode === HttpStatus.CREATED) {
      return "CREATED";
    }

    if (statusCode === HttpStatus.ACCEPTED) {
      return "ACCEPTED";
    }

    if (statusCode === HttpStatus.NO_CONTENT) {
      return "NO_CONTENT";
    }

    return "OK";
  }

  private static defaultErrorCode(statusCode: number): string {
    switch (statusCode) {
      case HttpStatus.BAD_REQUEST:
        return "BAD_REQUEST";
      case HttpStatus.UNAUTHORIZED:
        return "UNAUTHORIZED";
      case HttpStatus.FORBIDDEN:
        return "FORBIDDEN";
      case HttpStatus.NOT_FOUND:
        return "NOT_FOUND";
      case HttpStatus.CONFLICT:
        return "CONFLICT";
      case HttpStatus.TOO_MANY_REQUESTS:
        return "TOO_MANY_REQUESTS";
      case HttpStatus.SERVICE_UNAVAILABLE:
        return "SERVICE_UNAVAILABLE";
      default:
        return "INTERNAL_SERVER_ERROR";
    }
  }
}

export const SkipApiResponse = () =>
  SetMetadata(SKIP_API_RESPONSE_METADATA, true);

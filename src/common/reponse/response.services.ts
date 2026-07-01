import { Injectable, HttpStatus } from "@nestjs/common";
import {
  ApiResponse,
  ErrorResponse,
  PaginatedResponse,
} from "./response.interface";

@Injectable()
export class ResponseService {
  success<T>(
    data: T,
    message: string = "Success",
    statusCode: number = HttpStatus.OK
  ): ApiResponse<T> {
    return {
      success: true,
      statusCode,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
  }
  successWithoutData(
    message: string = "Success",
    statusCode: number = HttpStatus.OK
  ): ApiResponse {
    return {
      success: true,
      statusCode,
      message,
      timestamp: new Date().toISOString(),
    };
  }

  successWithPagination<T>(
    data: T[],
    page: number,
    limit: number,
    total: number,
    message: string = "Success"
  ): PaginatedResponse<T> {
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      statusCode: HttpStatus.OK,
      message,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      timestamp: new Date().toISOString(),
    };
  }
  error(
    message: string,
    statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode?: string,
    errors?: string[],
    details?: any
  ): ErrorResponse {
    return {
      success: false,
      statusCode,
      message,
      errorCode,
      errors,
      details,
      timestamp: new Date().toISOString(),
    };
  }
  validationError(
    errors: string[],
    message: string = "Validation failed"
  ): ErrorResponse {
    return this.error(
      message,
      HttpStatus.BAD_REQUEST,
      "VALIDATION_ERROR",
      errors
    );
  }
  unauthorized(
    message: string = "Unauthorized",
    errorCode?: string
  ): ErrorResponse {
    return this.error(
      message,
      HttpStatus.UNAUTHORIZED,
      errorCode || "UNAUTHORIZED"
    );
  }
  forbidden(message: string = "Forbidden", errorCode?: string): ErrorResponse {
    return this.error(message, HttpStatus.FORBIDDEN, errorCode || "FORBIDDEN");
  }

  notFound(message: string = "Not found", errorCode?: string): ErrorResponse {
    return this.error(message, HttpStatus.NOT_FOUND, errorCode || "NOT_FOUND");
  }
  conflict(message: string = "Conflict", errorCode?: string): ErrorResponse {
    return this.error(message, HttpStatus.CONFLICT, errorCode || "CONFLICT");
  }
}

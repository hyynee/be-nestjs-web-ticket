import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

export const CORRELATION_ID_HEADER = "x-correlation-id";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const existing = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof existing === "string" && SAFE_ID_PATTERN.test(existing)
        ? existing
        : randomUUID();

    // Attach to request so services/guards can read it
    (req as Request & { correlationId: string }).correlationId = correlationId;

    // Echo back to caller so client can correlate their own logs
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}

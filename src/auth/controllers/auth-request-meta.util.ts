import type { Request } from "express";
import { SessionRequestMeta } from "../domain/types/auth.types";

export function extractSessionMeta(req: Request): SessionRequestMeta {
  return {
    ipAddress: req.ip || undefined,
    userAgent: req.headers["user-agent"],
  };
}

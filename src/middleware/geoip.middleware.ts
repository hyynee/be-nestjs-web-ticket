import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import * as geoip from "geoip-lite";

function normalizeIp(rawIp: string): string {
  if (!rawIp) {
    return "";
  }
  if (rawIp.includes("::ffff:")) {
    return rawIp.split(":").reverse()[0];
  }
  return rawIp;
}

@Injectable()
export class GeoIpMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const forwardedFor = req.headers["x-forwarded-for"];
    const rawForwardedFor = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor;
    const xForwardedFor = (rawForwardedFor || "").replace(/:\d+$/, "");
    const ip = normalizeIp(xForwardedFor || req.socket?.remoteAddress || "");

    try {
      const lookup = geoip.lookup(ip);
      req.ipInfo = lookup ? { ...lookup, ip } : null;
    } catch {
      req.ipInfo = null;
    }
    next();
  }
}

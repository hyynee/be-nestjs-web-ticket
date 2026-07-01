import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import * as geoip from "geoip-lite";

function normalizeIp(rawIp: string) {
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
  use(req: Request, _res: Response, next: NextFunction) {
    const request = req as any;
    const xForwardedFor = (
      (request.headers["x-forwarded-for"] as string) || ""
    ).replace(/:\d+$/, "");
    const ip = normalizeIp(
      xForwardedFor || request.socket?.remoteAddress || ""
    );

    try {
      const lookup = geoip.lookup(ip);
      request.ipInfo = lookup ? { ...lookup, ip } : null;
    } catch {
      request.ipInfo = null;
    }
    next();
  }
}

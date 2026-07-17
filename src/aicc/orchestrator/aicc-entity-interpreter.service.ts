import { Injectable } from "@nestjs/common";
import { ExtractedEntities } from "../tools/aicc-tool.types";
import { AiccIntent } from "./aicc-intents";

const OBJECT_ID_PATTERN = /\b[0-9a-fA-F]{24}\b/g;
const OBJECT_ID_ONLY_PATTERN = /^\s*[0-9a-fA-F]{24}\s*$/;
const BOOKING_CODE_PATTERN = /\bBK[A-Z0-9]{6,40}\b/i;
const TICKET_CODE_PATTERN = /\bTK[A-Z0-9]{6,40}\b/i;
const STRIPE_PI_PATTERN = /\bpi_[A-Za-z0-9_]{8,80}\b/;
const PAYPAL_ORDER_PATTERN = /\b[A-Z0-9]{12,32}\b/;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:\+?84|0)(?:\d[\s.-]?){8,11}\d/;

@Injectable()
export class AiccEntityInterpreterService {
  interpret(message: string): {
    intent: AiccIntent;
    entities: ExtractedEntities;
  } {
    const entities = this.extractEntities(message);
    return {
      intent: this.detectIntent(message, entities),
      entities,
    };
  }

  detectDateMode(message: string): "active_now" | "upcoming" | "all" {
    const normalized = message.toLowerCase();
    if (
      this.includesAny(normalized, [
        "đang diễn ra",
        "dang dien ra",
        "hiện tại",
        "hien tai",
      ])
    ) {
      return "active_now";
    }
    if (this.includesAny(normalized, ["sắp", "sap", "upcoming"])) {
      return "upcoming";
    }
    return "all";
  }

  private detectIntent(
    message: string,
    entities: ExtractedEntities
  ): AiccIntent {
    const normalized = message.toLowerCase();

    if (
      entities.bookingCode ||
      entities.paymentIntentId ||
      entities.paypalOrderId
    ) {
      return entities.paymentIntentId || entities.paypalOrderId
        ? AiccIntent.PAYMENT_LOOKUP
        : AiccIntent.BOOKING_LOOKUP;
    }
    if (
      this.includesAny(normalized, [
        "mua vé",
        "mua ve",
        "đặt vé",
        "dat ve",
        "checkout",
        "tiếp tục thanh toán",
        "tiep tuc thanh toan",
      ])
    ) {
      return AiccIntent.BOOKING_ASSISTANT;
    }
    if (
      this.includesAny(normalized, [
        "nhân viên",
        "nhan vien",
        "người thật",
        "nguoi that",
        "admin",
        "hỗ trợ viên",
        "ho tro vien",
      ])
    ) {
      return AiccIntent.HUMAN_REQUEST;
    }
    if (
      this.includesAny(normalized, [
        "khiếu nại",
        "khieu nai",
        "bực",
        "không hài lòng",
        "khong hai long",
      ])
    ) {
      return AiccIntent.COMPLAINT;
    }
    if (this.includesAny(normalized, ["hoàn tiền", "hoan tien", "refund"])) {
      return AiccIntent.REFUND_POLICY;
    }
    if (
      this.includesAny(normalized, [
        "thanh toán",
        "thanh toan",
        "payment",
        "trừ tiền",
        "tru tien",
      ])
    ) {
      return AiccIntent.PAYMENT_LOOKUP;
    }
    if (
      entities.ticketCode ||
      this.includesAny(normalized, ["qr", "check-in", "checkin"])
    ) {
      return this.includesAny(normalized, ["check-in", "checkin"])
        ? AiccIntent.CHECKIN_SUPPORT
        : AiccIntent.TICKET_LOOKUP;
    }
    if (this.includesAny(normalized, ["booking", "mã đặt", "ma dat"])) {
      return AiccIntent.BOOKING_LOOKUP;
    }
    if (
      this.includesAny(normalized, [
        "còn vé",
        "con ve",
        "hết vé",
        "het ve",
        "availability",
        "zone",
        "vip",
      ])
    ) {
      return AiccIntent.TICKET_AVAILABILITY;
    }
    if (
      entities.objectId &&
      this.includesAny(normalized, ["chi tiết", "chi tiet", "detail"])
    ) {
      return AiccIntent.EVENT_DETAIL;
    }
    if (
      this.includesAny(normalized, [
        "sự kiện",
        "su kien",
        "event",
        "đang diễn ra",
        "sap dien ra",
        "sắp diễn ra",
      ])
    ) {
      return AiccIntent.EVENT_SEARCH;
    }
    return AiccIntent.UNKNOWN;
  }

  private extractEntities(message: string): ExtractedEntities {
    const objectIds = Array.from(message.matchAll(OBJECT_ID_PATTERN)).map(
      (match) => match[0]
    );
    const bookingCode = message.match(BOOKING_CODE_PATTERN)?.[0]?.toUpperCase();
    const ticketCode = message.match(TICKET_CODE_PATTERN)?.[0]?.toUpperCase();
    const objectId = objectIds[0];
    const paymentIntentId = message.match(STRIPE_PI_PATTERN)?.[0];
    const email = message.match(EMAIL_PATTERN)?.[0]?.toLowerCase();
    const phone =
      bookingCode || ticketCode || paymentIntentId
        ? undefined
        : message.match(PHONE_PATTERN)?.[0]?.replace(/[^\d+]/g, "");
    const paypalOrderId =
      !bookingCode && !ticketCode
        ? message.match(PAYPAL_ORDER_PATTERN)?.[0]
        : undefined;

    return {
      objectId,
      objectIds,
      eventId: objectIds[0],
      zoneId: objectIds[1],
      bookingCode,
      ticketCode,
      paymentIntentId,
      paypalOrderId,
      email,
      phone,
      search: this.extractSearchText(message),
      quantity: this.extractQuantity(message),
    };
  }

  private extractQuantity(message: string): number | undefined {
    const match =
      message.match(/\b(\d{1,2})\s*(vé|ve|ticket|tickets)\b/i) ??
      message.match(/\b(vé|ve|ticket|tickets)\s*(\d{1,2})\b/i);
    const raw = match?.[1] && /^\d+$/.test(match[1]) ? match[1] : match?.[2];
    if (!raw || !/^\d+$/.test(raw)) {
      return undefined;
    }
    const quantity = Number(raw);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return undefined;
    }
    return Math.min(quantity, 10);
  }

  private extractSearchText(message: string): string | undefined {
    const trimmed = message.trim();
    if (trimmed.length < 3 || OBJECT_ID_ONLY_PATTERN.test(trimmed)) {
      return undefined;
    }
    if (
      this.includesAny(trimmed.toLowerCase(), [
        "booking",
        "payment",
        "thanh toán",
        "thanh toan",
        "ticket",
        "qr",
      ])
    ) {
      return undefined;
    }
    return trimmed.slice(0, 120);
  }

  private includesAny(value: string, keywords: string[]): boolean {
    return keywords.some((keyword) => value.includes(keyword));
  }
}

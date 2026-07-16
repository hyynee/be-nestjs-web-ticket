import { Injectable, Logger } from "@nestjs/common";
import { AiccOutcome, AiccSessionPhase } from "../schemas/aicc-session.schema";
import { AiccToolCallStatus } from "../schemas/aicc-tool-call.schema";
import {
  AiccHandoffPriority,
  AiccHandoffReason,
} from "../schemas/aicc-handoff.schema";
import { AiccKnowledgeCategory } from "../schemas/aicc-knowledge.schema";
import { AiccEventTool } from "../tools/event.tool";
import { AiccBookingTool } from "../tools/booking.tool";
import { AiccPaymentTool } from "../tools/payment.tool";
import { AiccTicketTool } from "../tools/ticket.tool";
import { AiccKnowledgeTool } from "../tools/knowledge.tool";
import {
  AiccExecutedToolCall,
  AiccToolArgs,
  AiccToolName,
  AiccToolResult,
  AvailabilityResult,
  BookingStatusExplanationResult,
  BookingLookupResult,
  CheckoutAction,
  CheckoutContextResult,
  AiccSensitiveLookupAccess,
  ExtractedEntities,
  GetEventDetailResult,
  KnowledgeSearchResult,
  PaymentStatusExplanationResult,
  PaymentLookupResult,
  SearchEventsResult,
  TicketLookupResult,
  ToolFailureResult,
} from "../tools/aicc-tool.types";
import { AiccIntent } from "./aicc-intents";
import { outcomeForIntent, phaseForIntent } from "./aicc-state-machine";

const OBJECT_ID_PATTERN = /\b[0-9a-fA-F]{24}\b/g;
const BOOKING_CODE_PATTERN = /\bBK[A-Z0-9]{6,40}\b/i;
const TICKET_CODE_PATTERN = /\bTK[A-Z0-9]{6,40}\b/i;
const STRIPE_PI_PATTERN = /\bpi_[A-Za-z0-9_]{8,80}\b/;
const PAYPAL_ORDER_PATTERN = /\b[A-Z0-9]{12,32}\b/;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:\+?84|0)(?:\d[\s.-]?){8,11}\d/;

export interface AiccOrchestratorInput {
  sessionId: string;
  turnNo: number;
  message: string;
  access?: AiccSensitiveLookupAccess;
  previousUnknownCount?: number;
}

export interface AiccOrchestratorResult {
  intent: AiccIntent;
  phase: AiccSessionPhase;
  outcome: AiccOutcome;
  reply: string;
  entities: ExtractedEntities;
  toolCalls: AiccExecutedToolCall[];
  actions: CheckoutAction[];
  handoffRequest?: AiccHandoffRequest;
}

export interface AiccHandoffRequest {
  reason: AiccHandoffReason;
  priority: AiccHandoffPriority;
  summary: string;
  metadata: Record<string, unknown>;
}

type ToolRunResult<TResult extends AiccToolResult> =
  TResult | ToolFailureResult;

@Injectable()
export class AiccOrchestratorService {
  private readonly logger = new Logger(AiccOrchestratorService.name);

  constructor(
    private readonly eventTool: AiccEventTool,
    private readonly bookingTool: AiccBookingTool,
    private readonly paymentTool: AiccPaymentTool,
    private readonly ticketTool: AiccTicketTool,
    private readonly knowledgeTool: AiccKnowledgeTool
  ) {}

  async handleMessage(
    input: AiccOrchestratorInput
  ): Promise<AiccOrchestratorResult> {
    const entities = this.extractEntities(input.message);
    const intent = this.detectIntent(input.message, entities);
    const toolCalls: AiccExecutedToolCall[] = [];
    const actions: CheckoutAction[] = [];
    let reply = this.defaultReply(intent);
    let handoffRequest: AiccHandoffRequest | undefined;

    if (intent === AiccIntent.EVENT_SEARCH) {
      const result = await this.runTool(
        input,
        AiccToolName.SEARCH_EVENTS,
        {
          dateMode: this.detectDateMode(input.message),
          search: entities.search,
        },
        () =>
          this.eventTool.searchEvents({
            dateMode: this.detectDateMode(input.message),
            search: entities.search,
            limit: 5,
          })
      );
      toolCalls.push(result.call);
      reply = this.replyForEventSearch(result.result);
    } else if (intent === AiccIntent.EVENT_DETAIL) {
      if (!entities.objectId) {
        reply =
          "Bạn gửi giúp mình mã sự kiện hoặc chọn một sự kiện cụ thể để mình xem chi tiết nhé.";
      } else {
        const result = await this.runTool(
          input,
          AiccToolName.GET_EVENT_DETAIL,
          { eventId: entities.objectId },
          () => this.eventTool.getEventDetail({ eventId: entities.objectId! })
        );
        toolCalls.push(result.call);
        reply = this.replyForEventDetail(result.result);
      }
    } else if (intent === AiccIntent.BOOKING_ASSISTANT) {
      if (!entities.eventId) {
        reply =
          "Bạn gửi giúp mình mã sự kiện hoặc chọn sự kiện trước, rồi mình sẽ kiểm tra khu vực vé và tạo lối tắt checkout.";
      } else {
        const result = await this.runTool(
          input,
          AiccToolName.BUILD_CHECKOUT_CONTEXT,
          {
            eventId: entities.eventId,
            zoneId: entities.zoneId,
            quantity: entities.quantity ?? 1,
          },
          () =>
            this.eventTool.buildCheckoutContext({
              eventId: entities.eventId!,
              zoneId: entities.zoneId,
              quantity: entities.quantity ?? 1,
            })
        );
        toolCalls.push(result.call);
        reply = this.replyForCheckoutContext(result.result);
        const action = this.actionForCheckoutContext(result.result);
        if (action) {
          actions.push(action);
        }
      }
    } else if (intent === AiccIntent.TICKET_AVAILABILITY) {
      if (!entities.objectId) {
        reply =
          "Bạn cho mình biết sự kiện hoặc mã event trước, rồi mình sẽ kiểm tra còn vé theo khu vực bạn muốn.";
      } else {
        const result = await this.runTool(
          input,
          AiccToolName.CHECK_TICKET_AVAILABILITY,
          { eventId: entities.objectId },
          () =>
            this.eventTool.checkTicketAvailability({
              eventId: entities.objectId!,
            })
        );
        toolCalls.push(result.call);
        reply = this.replyForAvailability(result.result);
      }
    } else if (intent === AiccIntent.BOOKING_LOOKUP) {
      if (!this.hasSensitiveLookupAccess(input.access)) {
        reply =
          "Để kiểm tra booking, bạn vui lòng đăng nhập hoặc cung cấp email/số điện thoại đã gắn với phiên hỗ trợ này để mình xác minh trước nhé.";
        return this.buildResult(
          input,
          intent,
          reply,
          entities,
          toolCalls,
          actions
        );
      }
      if (entities.bookingCode) {
        const result = await this.runTool(
          input,
          AiccToolName.EXPLAIN_BOOKING_STATUS,
          { bookingCode: entities.bookingCode },
          () =>
            this.bookingTool.explainBookingStatus({
              bookingCode: entities.bookingCode!,
              access: input.access,
            })
        );
        toolCalls.push(result.call);
        reply = this.replyForBookingExplanation(result.result);
        const action = this.actionForBookingExplanation(result.result);
        if (action) {
          actions.push(action);
        }
      } else {
        const result = await this.runTool(
          input,
          AiccToolName.LOOKUP_BOOKING,
          {
            email: entities.email,
            phone: entities.phone,
          },
          () =>
            this.bookingTool.lookupBooking({
              email: entities.email,
              phone: entities.phone,
              access: input.access,
            })
        );
        toolCalls.push(result.call);
        reply = this.replyForBooking(result.result);
      }
    } else if (intent === AiccIntent.PAYMENT_LOOKUP) {
      if (!this.hasSensitiveLookupAccess(input.access)) {
        reply =
          "Để kiểm tra thanh toán, bạn vui lòng đăng nhập hoặc xác minh bằng email/số điện thoại của booking trước nhé.";
        return this.buildResult(
          input,
          intent,
          reply,
          entities,
          toolCalls,
          actions
        );
      }
      const result = await this.runTool(
        input,
        AiccToolName.EXPLAIN_PAYMENT_STATUS,
        {
          bookingCode: entities.bookingCode,
          paymentIntentId: entities.paymentIntentId,
          paypalOrderId: entities.paypalOrderId,
        },
        () =>
          this.paymentTool.explainPaymentStatus({
            bookingCode: entities.bookingCode,
            paymentIntentId: entities.paymentIntentId,
            paypalOrderId: entities.paypalOrderId,
            access: input.access,
          })
      );
      toolCalls.push(result.call);
      reply = this.replyForPaymentExplanation(result.result);
      handoffRequest = this.paymentExplanationHandoffRequest(
        input.message,
        result.result,
        entities
      );
      if (!handoffRequest && this.shouldSearchPaymentKnowledge(entities)) {
        const knowledge = await this.searchKnowledge(
          input,
          input.message,
          AiccKnowledgeCategory.PAYMENT_POLICY
        );
        toolCalls.push(knowledge.call);
        if (!this.isKnowledgeBelowThreshold(knowledge.result)) {
          reply = this.replyForKnowledge(knowledge.result);
        }
      }
    } else if (
      intent === AiccIntent.TICKET_LOOKUP ||
      intent === AiccIntent.CHECKIN_SUPPORT
    ) {
      if (
        intent === AiccIntent.CHECKIN_SUPPORT &&
        !entities.ticketCode &&
        !entities.bookingCode
      ) {
        const knowledge = await this.searchKnowledge(
          input,
          input.message,
          AiccKnowledgeCategory.CHECKIN_POLICY
        );
        toolCalls.push(knowledge.call);
        reply = this.replyForKnowledge(knowledge.result);
        if (this.isKnowledgeBelowThreshold(knowledge.result)) {
          handoffRequest = this.buildHandoffRequest({
            reason: AiccHandoffReason.CHECKIN_ISSUE,
            priority: AiccHandoffPriority.NORMAL,
            userMessage: input.message,
            details:
              "Khách hỏi hướng dẫn check-in/QR nhưng KB chưa có tài liệu active phù hợp.",
            metadata: { ...entities },
          });
        }
      } else {
        if (!this.hasSensitiveLookupAccess(input.access)) {
          reply =
            "Để kiểm tra vé/QR, bạn vui lòng đăng nhập hoặc xác minh bằng email/số điện thoại của booking trước nhé.";
          return this.buildResult(
            input,
            intent,
            reply,
            entities,
            toolCalls,
            actions
          );
        }
        const result = await this.runTool(
          input,
          AiccToolName.LOOKUP_TICKET,
          {
            ticketCode: entities.ticketCode,
            bookingCode: entities.bookingCode,
          },
          () =>
            this.ticketTool.lookupTicket({
              ticketCode: entities.ticketCode,
              bookingCode: entities.bookingCode,
              access: input.access,
            })
        );
        toolCalls.push(result.call);
        reply = this.replyForTicket(result.result);
        handoffRequest = this.ticketHandoffRequest(
          input.message,
          result.result,
          entities,
          intent
        );
      }
    } else if (intent === AiccIntent.HUMAN_REQUEST) {
      handoffRequest = this.buildHandoffRequest({
        reason: AiccHandoffReason.HUMAN_REQUEST,
        priority: AiccHandoffPriority.NORMAL,
        userMessage: input.message,
        details:
          "Khách yêu cầu gặp nhân viên thật. Cần nhân viên tiếp nhận và hỗ trợ tiếp.",
        metadata: { ...entities },
      });
    } else if (intent === AiccIntent.COMPLAINT) {
      handoffRequest = this.buildHandoffRequest({
        reason: AiccHandoffReason.COMPLAINT,
        priority: AiccHandoffPriority.HIGH,
        userMessage: input.message,
        details:
          "Khách có dấu hiệu khiếu nại hoặc không hài lòng. Không để AI tự xử lý kéo dài.",
        metadata: { ...entities },
      });
    } else if (intent === AiccIntent.REFUND_POLICY) {
      const knowledge = await this.searchKnowledge(
        input,
        input.message,
        AiccKnowledgeCategory.REFUND_POLICY
      );
      toolCalls.push(knowledge.call);
      reply = this.replyForKnowledge(knowledge.result);
      if (this.isKnowledgeBelowThreshold(knowledge.result)) {
        handoffRequest = this.buildHandoffRequest({
          reason: AiccHandoffReason.REFUND,
          priority: AiccHandoffPriority.HIGH,
          userMessage: input.message,
          details:
            "Khách hỏi hoàn tiền/refund nhưng KB chưa có chính sách refund active phù hợp. Không để AI tự bịa chính sách.",
          metadata: { ...entities },
        });
      }
    } else if (intent === AiccIntent.UNKNOWN) {
      const knowledge = await this.searchKnowledge(
        input,
        input.message,
        AiccKnowledgeCategory.FAQ
      );
      toolCalls.push(knowledge.call);
      if (!this.isKnowledgeBelowThreshold(knowledge.result)) {
        reply = this.replyForKnowledge(knowledge.result);
      } else if ((input.previousUnknownCount ?? 0) >= 1) {
        handoffRequest = this.buildHandoffRequest({
          reason: AiccHandoffReason.AI_FAILED,
          priority: AiccHandoffPriority.NORMAL,
          userMessage: input.message,
          details:
            "AI không xác định được intent sau 2 lượt liên tiếp và KB FAQ không có tài liệu active phù hợp.",
          metadata: {
            ...entities,
            previousUnknownCount: input.previousUnknownCount,
          },
        });
      }
    }

    return this.buildResult(
      input,
      intent,
      reply,
      entities,
      toolCalls,
      actions,
      handoffRequest
    );
  }

  private buildResult(
    input: AiccOrchestratorInput,
    intent: AiccIntent,
    reply: string,
    entities: ExtractedEntities,
    toolCalls: AiccExecutedToolCall[],
    actions: CheckoutAction[],
    handoffRequest?: AiccHandoffRequest
  ): AiccOrchestratorResult {
    void input;
    return {
      intent,
      phase: phaseForIntent(intent),
      outcome: handoffRequest ? AiccOutcome.HANDOFF : outcomeForIntent(intent),
      reply,
      entities,
      toolCalls,
      actions,
      handoffRequest,
    };
  }

  private hasSensitiveLookupAccess(
    access?: AiccSensitiveLookupAccess
  ): boolean {
    return Boolean(access?.userId);
  }

  private async runTool<TResult extends AiccToolResult>(
    input: AiccOrchestratorInput,
    toolName: AiccToolName,
    args: AiccToolArgs,
    handler: () => Promise<TResult>
  ): Promise<{
    call: AiccExecutedToolCall;
    result: ToolRunResult<TResult>;
  }> {
    const startedAt = Date.now();
    try {
      const result = await handler();
      return {
        result,
        call: {
          sessionId: input.sessionId,
          turnNo: input.turnNo,
          toolName,
          args,
          result,
          status: AiccToolCallStatus.SUCCESS,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const errorCode = this.toErrorCode(error);
      this.logger.warn(
        `AICC tool failed: sessionId=${input.sessionId}, tool=${toolName}, error=${errorCode}`
      );
      const result: ToolFailureResult = {
        errorCode,
        message: "Tool execution failed",
      };
      return {
        result,
        call: {
          sessionId: input.sessionId,
          turnNo: input.turnNo,
          toolName,
          args,
          result,
          status: AiccToolCallStatus.FAILED,
          errorCode,
          durationMs: Date.now() - startedAt,
        },
      };
    }
  }

  private searchKnowledge(
    input: AiccOrchestratorInput,
    query: string,
    category: AiccKnowledgeCategory
  ): Promise<{
    call: AiccExecutedToolCall;
    result: ToolRunResult<KnowledgeSearchResult>;
  }> {
    return this.runTool(
      input,
      AiccToolName.SEARCH_KNOWLEDGE,
      {
        query,
        category,
        topK: 3,
      },
      () =>
        this.knowledgeTool.searchKnowledge({
          query,
          category,
          topK: 3,
        })
    );
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
    if (trimmed.length < 3 || OBJECT_ID_PATTERN.test(trimmed)) {
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

  private detectDateMode(message: string): "active_now" | "upcoming" | "all" {
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

  private isToolFailure(result: AiccToolResult): result is ToolFailureResult {
    return "errorCode" in result;
  }

  private isKnowledgeBelowThreshold(
    result: KnowledgeSearchResult | ToolFailureResult
  ): boolean {
    return this.isToolFailure(result) || result.belowThreshold;
  }

  private replyForEventSearch(
    result: SearchEventsResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result)) {
      return "Mình chưa thể tìm sự kiện ngay lúc này. Bạn thử lại sau giúp mình nhé.";
    }
    if (!result.events.length) {
      return "Mình chưa tìm thấy sự kiện phù hợp. Bạn thử gửi tên sự kiện hoặc thời gian mong muốn nhé.";
    }
    const lines = result.events
      .slice(0, 3)
      .map(
        (event, index) =>
          `${index + 1}. ${event.title} - ${this.formatDate(event.startDate)} tại ${event.location}`
      );
    return `Mình tìm thấy ${result.events.length} sự kiện phù hợp:\n${lines.join(
      "\n"
    )}\nBạn muốn xem chi tiết sự kiện nào?`;
  }

  private replyForEventDetail(
    result: GetEventDetailResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result) || !result.event) {
      return "Mình chưa tìm thấy sự kiện này. Bạn kiểm tra lại mã sự kiện giúp mình nhé.";
    }
    const zones = result.zones
      .slice(0, 3)
      .map(
        (zone) =>
          `${zone.name}: ${zone.price.toLocaleString("vi-VN")} VND, còn khoảng ${zone.availableTickets} vé`
      );
    return `${result.event.title} diễn ra từ ${this.formatDate(
      result.event.startDate
    )} đến ${this.formatDate(result.event.endDate)} tại ${
      result.event.location
    }. ${
      zones.length
        ? `Một số khu vực vé: ${zones.join("; ")}.`
        : "Hiện chưa có khu vực vé công khai."
    }`;
  }

  private replyForAvailability(
    result: AvailabilityResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result)) {
      return "Mình chưa kiểm tra được tình trạng vé ngay lúc này.";
    }
    return result.message;
  }

  private replyForCheckoutContext(
    result: CheckoutContextResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result)) {
      return "Mình chưa thể tạo lối tắt checkout ngay lúc này. Bạn thử lại sau giúp mình nhé.";
    }
    if (!result.canCheckout) {
      if (result.reason === "EVENT_NOT_BOOKABLE") {
        return "Sự kiện này hiện không thể mua vé. Bạn có thể chọn sự kiện khác đang mở bán.";
      }
      if (result.reason === "SOLD_OUT") {
        const suggestions = result.suggestedZones
          ?.slice(0, 3)
          .map((zone) => `${zone.name} còn khoảng ${zone.availableTickets} vé`)
          .join("; ");
        return suggestions
          ? `Khu vực bạn chọn chưa đủ vé. Một số lựa chọn khác: ${suggestions}.`
          : "Khu vực này hiện đã hết vé.";
      }
      if (result.reason === "ZONE_NOT_FOUND") {
        return "Mình chưa tìm thấy khu vực vé này. Bạn chọn lại zone giúp mình nhé.";
      }
      return "Mình chưa thể tạo lối tắt checkout với thông tin hiện tại. Bạn kiểm tra lại sự kiện/khu vực vé giúp mình nhé.";
    }

    const total = result.estimatedTotal?.toLocaleString("vi-VN") ?? "0";
    const zone = result.suggestedZones?.find(
      (item) => item.id === result.selection.zoneId
    );
    return `${result.event?.title ?? "Sự kiện này"} ${
      zone ? `zone ${zone.name} ` : ""
    }còn vé cho ${result.selection.quantity} vé. Tổng tạm tính khoảng ${total} VND.`;
  }

  private replyForBooking(
    result: BookingLookupResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result) || !result.found || !result.booking) {
      return "Mình chưa tìm thấy booking tương ứng. Bạn gửi mã booking, email hoặc số điện thoại đặt vé giúp mình nhé.";
    }
    const booking = result.booking;
    return `Booking ${booking.bookingCode} đang ở trạng thái ${booking.status}, thanh toán ${booking.paymentStatus}, số lượng ${booking.quantity}, tổng ${booking.totalPrice.toLocaleString(
      "vi-VN"
    )} VND${booking.event ? ` cho sự kiện ${booking.event.title}` : ""}.`;
  }

  private replyForBookingExplanation(
    result: BookingStatusExplanationResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result)) {
      return "Mình chưa kiểm tra được trạng thái booking ngay lúc này.";
    }
    if (!result.found) {
      return result.explanation;
    }
    return `Booking ${result.bookingCode} đang ở trạng thái ${result.status}, thanh toán ${result.paymentStatus}. ${result.explanation}`;
  }

  private replyForPayment(
    result: PaymentLookupResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result) || !result.found || !result.payment) {
      return "Mình chưa tìm thấy giao dịch thanh toán. Bạn gửi mã booking hoặc mã giao dịch để mình kiểm tra tiếp nhé.";
    }
    const payment = result.payment;
    return `Giao dịch hiện ở trạng thái ${payment.status}, số tiền ${payment.amount.toLocaleString(
      "vi-VN"
    )} ${payment.currency.toUpperCase()}${
      payment.paidAt
        ? `, đã ghi nhận lúc ${this.formatDate(payment.paidAt)}`
        : ""
    }.`;
  }

  private replyForPaymentExplanation(
    result: PaymentStatusExplanationResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result)) {
      return "Mình chưa kiểm tra được trạng thái thanh toán ngay lúc này.";
    }
    if (!result.found) {
      return result.explanation;
    }
    return `Giao dịch hiện ở trạng thái ${result.status}. ${result.explanation}`;
  }

  private replyForTicket(
    result: TicketLookupResult | ToolFailureResult
  ): string {
    if (this.isToolFailure(result) || !result.found || !result.ticket) {
      return "Mình chưa tìm thấy vé tương ứng. Bạn gửi mã vé hoặc mã booking giúp mình nhé.";
    }
    const ticket = result.ticket;
    return `Vé ${ticket.ticketCode} đang ở trạng thái ${ticket.status}${
      ticket.event ? ` cho sự kiện ${ticket.event.title}` : ""
    }${ticket.checkedInAt ? `, đã check-in lúc ${this.formatDate(ticket.checkedInAt)}` : ""}.`;
  }

  private replyForKnowledge(
    result: KnowledgeSearchResult | ToolFailureResult
  ): string {
    if (
      this.isToolFailure(result) ||
      result.belowThreshold ||
      result.documents.length === 0
    ) {
      return "Mình chưa có thông tin chắc chắn trong kho kiến thức hiện tại. Mình sẽ chuyển yêu cầu này cho nhân viên để kiểm tra chính xác hơn.";
    }

    const [document] = result.documents;
    return `Theo tài liệu "${document.title}" v${document.version}: ${document.contentSnippet}`;
  }

  private defaultReply(intent: AiccIntent): string {
    if (intent === AiccIntent.HUMAN_REQUEST) {
      return "Mình đã ghi nhận nhu cầu gặp nhân viên. Ở phase handoff tiếp theo, hệ thống sẽ chuyển kèm tóm tắt cuộc trò chuyện.";
    }
    if (
      intent === AiccIntent.COMPLAINT ||
      intent === AiccIntent.REFUND_POLICY
    ) {
      return "Vấn đề này cần nhân viên kiểm tra chính sách và dữ liệu giao dịch cụ thể. Mình sẽ chuẩn bị chuyển yêu cầu cho admin ở bước handoff.";
    }
    return "Mình là trợ lý hỗ trợ vé sự kiện. Bạn có thể hỏi về sự kiện, booking, thanh toán, vé QR hoặc check-in.";
  }

  private ticketHandoffRequest(
    userMessage: string,
    result: TicketLookupResult | ToolFailureResult,
    entities: ExtractedEntities,
    intent: AiccIntent
  ): AiccHandoffRequest | undefined {
    if (intent !== AiccIntent.CHECKIN_SUPPORT) {
      return undefined;
    }

    if (this.isToolFailure(result) || !result.found || !result.ticket) {
      return this.buildHandoffRequest({
        reason: AiccHandoffReason.CHECKIN_ISSUE,
        priority: AiccHandoffPriority.NORMAL,
        userMessage,
        details:
          "Khách cần hỗ trợ check-in nhưng hệ thống chưa tìm thấy vé tương ứng. Cần nhân viên kiểm tra lại mã vé/booking.",
        metadata: { ...entities },
      });
    }

    if (["used", "cancelled", "expired"].includes(result.ticket.status)) {
      return this.buildHandoffRequest({
        reason: AiccHandoffReason.CHECKIN_ISSUE,
        priority: AiccHandoffPriority.HIGH,
        userMessage,
        details: `Tool lookup_ticket trả ticket=${result.ticket.ticketCode}, status=${result.ticket.status}. Cần nhân viên kiểm tra tình huống check-in.`,
        metadata: { ...entities, ticketStatus: result.ticket.status },
      });
    }

    return undefined;
  }

  private shouldSearchPaymentKnowledge(entities: ExtractedEntities): boolean {
    return (
      !entities.bookingCode &&
      !entities.paymentIntentId &&
      !entities.paypalOrderId
    );
  }

  private actionForCheckoutContext(
    result: CheckoutContextResult | ToolFailureResult
  ): CheckoutAction | undefined {
    if (this.isToolFailure(result) || !result.canCheckout) {
      return undefined;
    }

    return {
      type: "open_checkout",
      label: "Tiếp tục thanh toán",
      payload: {
        ...result.selection,
        estimatedTotal: result.estimatedTotal,
        checkoutDeepLink: result.checkoutDeepLink,
      },
    };
  }

  private actionForBookingExplanation(
    result: BookingStatusExplanationResult | ToolFailureResult
  ): CheckoutAction | undefined {
    if (this.isToolFailure(result) || !result.found || !result.bookingCode) {
      return undefined;
    }
    if (result.nextAction === "pay_now") {
      return {
        type: "open_checkout",
        label: "Thanh toán booking",
        payload: { bookingUrl: `/booking/${result.bookingCode}` },
      };
    }
    if (result.nextAction === "view_ticket") {
      return {
        type: "open_tickets",
        label: "Xem vé",
        payload: { bookingUrl: `/booking/${result.bookingCode}` },
      };
    }
    if (result.nextAction === "wait_payment") {
      return {
        type: "open_booking",
        label: "Xem booking",
        payload: { bookingUrl: `/booking/${result.bookingCode}` },
      };
    }
    return undefined;
  }

  private paymentExplanationHandoffRequest(
    userMessage: string,
    result: PaymentStatusExplanationResult | ToolFailureResult,
    entities: ExtractedEntities
  ): AiccHandoffRequest | undefined {
    if (this.isToolFailure(result) || !result.shouldHandoff) {
      return undefined;
    }

    return this.buildHandoffRequest({
      reason:
        result.handoffReason === "refund"
          ? AiccHandoffReason.REFUND
          : AiccHandoffReason.PAYMENT_ISSUE,
      priority: AiccHandoffPriority.HIGH,
      userMessage,
      details: `Tool explain_payment_status trả status=${
        result.status ?? "unknown"
      }. Cần nhân viên kiểm tra giao dịch.`,
      metadata: { ...entities, paymentStatus: result.status },
    });
  }

  private buildHandoffRequest(input: {
    reason: AiccHandoffReason;
    priority: AiccHandoffPriority;
    userMessage: string;
    details: string;
    metadata: Record<string, unknown>;
  }): AiccHandoffRequest {
    return {
      reason: input.reason,
      priority: input.priority,
      summary: `Khách nhắn: "${input.userMessage.trim()}". ${input.details}`,
      metadata: input.metadata,
    };
  }

  private toErrorCode(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message.slice(0, 80);
    }
    return "TOOL_ERROR";
  }

  private formatDate(value: string): string {
    return new Date(value).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    });
  }

  private includesAny(value: string, keywords: string[]): boolean {
    return keywords.some((keyword) => value.includes(keyword));
  }
}

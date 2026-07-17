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
  CheckoutAction,
  AiccSensitiveLookupAccess,
  ExtractedEntities,
  KnowledgeSearchResult,
  ToolFailureResult,
} from "../tools/aicc-tool.types";
import { AiccIntent } from "./aicc-intents";
import { outcomeForIntent, phaseForIntent } from "./aicc-state-machine";
import { AiccEntityInterpreterService } from "./aicc-entity-interpreter.service";
import { AiccResponseComposerService } from "./aicc-response-composer.service";

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
    private readonly knowledgeTool: AiccKnowledgeTool,
    private readonly entityInterpreter: AiccEntityInterpreterService,
    private readonly responseComposer: AiccResponseComposerService
  ) {}

  async handleMessage(
    input: AiccOrchestratorInput
  ): Promise<AiccOrchestratorResult> {
    const { entities, intent } = this.entityInterpreter.interpret(
      input.message
    );
    const toolCalls: AiccExecutedToolCall[] = [];
    const actions: CheckoutAction[] = [];
    let reply = this.responseComposer.defaultReply(intent);
    let handoffRequest: AiccHandoffRequest | undefined;

    if (intent === AiccIntent.EVENT_SEARCH) {
      const result = await this.runTool(
        input,
        AiccToolName.SEARCH_EVENTS,
        {
          dateMode: this.entityInterpreter.detectDateMode(input.message),
          search: entities.search,
        },
        () =>
          this.eventTool.searchEvents({
            dateMode: this.entityInterpreter.detectDateMode(input.message),
            search: entities.search,
            limit: 5,
          })
      );
      toolCalls.push(result.call);
      reply = this.responseComposer.replyForEventSearch(result.result);
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
        reply = this.responseComposer.replyForEventDetail(result.result);
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
        reply = this.responseComposer.replyForCheckoutContext(result.result);
        const action = this.responseComposer.actionForCheckoutContext(
          result.result
        );
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
        reply = this.responseComposer.replyForAvailability(result.result);
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
        reply = this.responseComposer.replyForBookingExplanation(result.result);
        const action = this.responseComposer.actionForBookingExplanation(
          result.result
        );
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
        reply = this.responseComposer.replyForBooking(result.result);
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
      reply = this.responseComposer.replyForPaymentExplanation(result.result);
      handoffRequest = this.responseComposer.paymentExplanationHandoffRequest(
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
        if (
          !this.responseComposer.isKnowledgeBelowThreshold(knowledge.result)
        ) {
          reply = this.responseComposer.replyForKnowledge(knowledge.result);
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
        reply = this.responseComposer.replyForKnowledge(knowledge.result);
        if (this.responseComposer.isKnowledgeBelowThreshold(knowledge.result)) {
          handoffRequest = this.responseComposer.buildHandoffRequest({
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
        reply = this.responseComposer.replyForTicket(result.result);
        handoffRequest = this.responseComposer.ticketHandoffRequest(
          input.message,
          result.result,
          entities,
          intent
        );
      }
    } else if (intent === AiccIntent.HUMAN_REQUEST) {
      handoffRequest = this.responseComposer.buildHandoffRequest({
        reason: AiccHandoffReason.HUMAN_REQUEST,
        priority: AiccHandoffPriority.NORMAL,
        userMessage: input.message,
        details:
          "Khách yêu cầu gặp nhân viên thật. Cần nhân viên tiếp nhận và hỗ trợ tiếp.",
        metadata: { ...entities },
      });
    } else if (intent === AiccIntent.COMPLAINT) {
      handoffRequest = this.responseComposer.buildHandoffRequest({
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
      reply = this.responseComposer.replyForKnowledge(knowledge.result);
      if (this.responseComposer.isKnowledgeBelowThreshold(knowledge.result)) {
        handoffRequest = this.responseComposer.buildHandoffRequest({
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
      if (!this.responseComposer.isKnowledgeBelowThreshold(knowledge.result)) {
        reply = this.responseComposer.replyForKnowledge(knowledge.result);
      } else if ((input.previousUnknownCount ?? 0) >= 1) {
        handoffRequest = this.responseComposer.buildHandoffRequest({
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

  private shouldSearchPaymentKnowledge(entities: ExtractedEntities): boolean {
    return (
      !entities.bookingCode &&
      !entities.paymentIntentId &&
      !entities.paypalOrderId
    );
  }

  private toErrorCode(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message.slice(0, 80);
    }
    return "TOOL_ERROR";
  }
}

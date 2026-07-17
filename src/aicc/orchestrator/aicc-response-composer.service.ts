import { Injectable } from "@nestjs/common";
import { AiccOutcome } from "../schemas/aicc-session.schema";
import {
  AiccHandoffPriority,
  AiccHandoffReason,
} from "../schemas/aicc-handoff.schema";
import {
  AvailabilityResult,
  BookingLookupResult,
  BookingStatusExplanationResult,
  CheckoutAction,
  CheckoutContextResult,
  ExtractedEntities,
  GetEventDetailResult,
  KnowledgeSearchResult,
  PaymentStatusExplanationResult,
  SearchEventsResult,
  TicketLookupResult,
  ToolFailureResult,
} from "../tools/aicc-tool.types";
import { AiccIntent } from "./aicc-intents";
import { AiccHandoffRequest } from "./aicc-orchestrator.service";

@Injectable()
export class AiccResponseComposerService {
  defaultReply(intent: AiccIntent): string {
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

  replyForEventSearch(result: SearchEventsResult | ToolFailureResult): string {
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

  replyForEventDetail(
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

  replyForAvailability(result: AvailabilityResult | ToolFailureResult): string {
    if (this.isToolFailure(result)) {
      return "Mình chưa kiểm tra được tình trạng vé ngay lúc này.";
    }
    return result.message;
  }

  replyForCheckoutContext(
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

  replyForBooking(result: BookingLookupResult | ToolFailureResult): string {
    if (this.isToolFailure(result) || !result.found || !result.booking) {
      return "Mình chưa tìm thấy booking tương ứng. Bạn gửi mã booking, email hoặc số điện thoại đặt vé giúp mình nhé.";
    }
    const booking = result.booking;
    return `Booking ${booking.bookingCode} đang ở trạng thái ${booking.status}, thanh toán ${booking.paymentStatus}, số lượng ${booking.quantity}, tổng ${booking.totalPrice.toLocaleString(
      "vi-VN"
    )} VND${booking.event ? ` cho sự kiện ${booking.event.title}` : ""}.`;
  }

  replyForBookingExplanation(
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

  replyForPaymentExplanation(
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

  replyForTicket(result: TicketLookupResult | ToolFailureResult): string {
    if (this.isToolFailure(result) || !result.found || !result.ticket) {
      return "Mình chưa tìm thấy vé tương ứng. Bạn gửi mã vé hoặc mã booking giúp mình nhé.";
    }
    const ticket = result.ticket;
    return `Vé ${ticket.ticketCode} đang ở trạng thái ${ticket.status}${
      ticket.event ? ` cho sự kiện ${ticket.event.title}` : ""
    }${ticket.checkedInAt ? `, đã check-in lúc ${this.formatDate(ticket.checkedInAt)}` : ""}.`;
  }

  replyForKnowledge(result: KnowledgeSearchResult | ToolFailureResult): string {
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

  actionForCheckoutContext(
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

  actionForBookingExplanation(
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

  ticketHandoffRequest(
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

  paymentExplanationHandoffRequest(
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

  buildHandoffRequest(input: {
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

  isKnowledgeBelowThreshold(
    result: KnowledgeSearchResult | ToolFailureResult
  ): boolean {
    return this.isToolFailure(result) || result.belowThreshold;
  }

  isToolFailure(result: object): result is ToolFailureResult {
    return "errorCode" in result;
  }

  outcomeForHandoff(
    intentOutcome: AiccOutcome,
    handoffRequest?: AiccHandoffRequest
  ): AiccOutcome {
    return handoffRequest ? AiccOutcome.HANDOFF : intentOutcome;
  }

  private formatDate(value: string): string {
    return new Date(value).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    });
  }
}

import { AiccOrchestratorService } from "./aicc-orchestrator.service";
import { AiccIntent } from "./aicc-intents";
import { AiccEventTool } from "../tools/event.tool";
import { AiccBookingTool } from "../tools/booking.tool";
import { AiccPaymentTool } from "../tools/payment.tool";
import { AiccTicketTool } from "../tools/ticket.tool";
import { AiccKnowledgeTool } from "../tools/knowledge.tool";
import { AiccToolName } from "../tools/aicc-tool.types";
import { AiccHandoffReason } from "../schemas/aicc-handoff.schema";
import { AiccKnowledgeCategory } from "../schemas/aicc-knowledge.schema";
import { AiccEntityInterpreterService } from "./aicc-entity-interpreter.service";
import { AiccResponseComposerService } from "./aicc-response-composer.service";

describe("AiccOrchestratorService", () => {
  let eventTool: {
    searchEvents: jest.Mock;
    getEventDetail: jest.Mock;
    checkTicketAvailability: jest.Mock;
  };
  let bookingTool: {
    lookupBooking: jest.Mock;
    explainBookingStatus: jest.Mock;
  };
  let paymentTool: { lookupPayment: jest.Mock };
  let ticketTool: { lookupTicket: jest.Mock };
  let knowledgeTool: { searchKnowledge: jest.Mock };
  let service: AiccOrchestratorService;

  beforeEach(() => {
    eventTool = {
      searchEvents: jest.fn().mockResolvedValue({
        events: [
          {
            id: "507f1f77bcf86cd799439011",
            title: "Concert Test",
            startDate: "2026-08-01T12:00:00.000Z",
            endDate: "2026-08-01T15:00:00.000Z",
            location: "Ha Noi",
            status: "active",
          },
        ],
      }),
      getEventDetail: jest.fn(),
      checkTicketAvailability: jest.fn(),
    };
    bookingTool = {
      lookupBooking: jest.fn().mockResolvedValue({
        found: true,
        booking: {
          id: "507f1f77bcf86cd799439012",
          bookingCode: "BK202607060001",
          status: "pending",
          paymentStatus: "unpaid",
          quantity: 2,
          totalPrice: 500000,
          expiresAt: "2026-07-06T12:00:00.000Z",
        },
      }),
      explainBookingStatus: jest.fn().mockResolvedValue({
        found: true,
        bookingCode: "BK202607060001",
        status: "pending",
        paymentStatus: "unpaid",
        explanation:
          "Booking đang chờ thanh toán. Bạn nên tiếp tục thanh toán trước khi booking hết hạn.",
        nextAction: "pay_now",
      }),
    };
    paymentTool = { lookupPayment: jest.fn() };
    ticketTool = { lookupTicket: jest.fn() };
    knowledgeTool = {
      searchKnowledge: jest.fn().mockResolvedValue({
        documents: [
          {
            id: "507f1f77bcf86cd799439099",
            title: "Chính sách hoàn tiền",
            category: AiccKnowledgeCategory.REFUND_POLICY,
            version: 2,
            contentSnippet:
              "Yêu cầu hoàn tiền cần được kiểm tra theo trạng thái thanh toán và thời điểm diễn ra sự kiện.",
            score: 1.5,
          },
        ],
        belowThreshold: false,
      }),
    };

    service = new AiccOrchestratorService(
      eventTool as unknown as AiccEventTool,
      bookingTool as unknown as AiccBookingTool,
      paymentTool as unknown as AiccPaymentTool,
      ticketTool as unknown as AiccTicketTool,
      knowledgeTool as unknown as AiccKnowledgeTool,
      new AiccEntityInterpreterService(),
      new AiccResponseComposerService()
    );
  });

  it("calls search_events for event discovery", async () => {
    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Co su kien nao sap dien ra khong?",
    });

    expect(result.intent).toBe(AiccIntent.EVENT_SEARCH);
    expect(eventTool.searchEvents).toHaveBeenCalledWith(
      expect.objectContaining({ dateMode: "upcoming", limit: 5 })
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe(AiccToolName.SEARCH_EVENTS);
    expect(result.reply).toContain("Concert Test");
  });

  it("does not call availability tool when event id is missing", async () => {
    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Zone VIP con ve khong?",
    });

    expect(result.intent).toBe(AiccIntent.TICKET_AVAILABILITY);
    expect(eventTool.checkTicketAvailability).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(0);
    expect(result.reply).toContain("mã event");
  });

  it("does not lookup booking data without access context", async () => {
    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Kiem tra booking BK202607060001 giup toi",
    });

    expect(result.intent).toBe(AiccIntent.BOOKING_LOOKUP);
    expect(bookingTool.lookupBooking).not.toHaveBeenCalled();
    expect(bookingTool.explainBookingStatus).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(0);
    expect(result.reply).toContain("đăng nhập");
  });

  it("calls explain_booking_status when booking code is present and access is verified", async () => {
    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Kiem tra booking BK202607060001 giup toi",
      access: { userId: "507f1f77bcf86cd799439012" },
    });

    expect(result.intent).toBe(AiccIntent.BOOKING_LOOKUP);
    expect(bookingTool.explainBookingStatus).toHaveBeenCalledWith({
      bookingCode: "BK202607060001",
      access: { userId: "507f1f77bcf86cd799439012" },
    });
    expect(result.toolCalls[0].toolName).toBe(
      AiccToolName.EXPLAIN_BOOKING_STATUS
    );
    expect(result.reply).toContain("BK202607060001");
    expect(result.actions[0].type).toBe("open_checkout");
  });

  it("keeps human request in handoff path without tool calls", async () => {
    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Toi muon gap nhan vien",
    });

    expect(result.intent).toBe(AiccIntent.HUMAN_REQUEST);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.handoffRequest?.reason).toBe(AiccHandoffReason.HUMAN_REQUEST);
    expect(eventTool.searchEvents).not.toHaveBeenCalled();
    expect(result.reply).toContain("gặp nhân viên");
  });

  it("answers refund policy from active knowledge instead of immediate handoff", async () => {
    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Toi co duoc hoan tien khong?",
    });

    expect(result.intent).toBe(AiccIntent.REFUND_POLICY);
    expect(knowledgeTool.searchKnowledge).toHaveBeenCalledWith({
      query: "Toi co duoc hoan tien khong?",
      category: AiccKnowledgeCategory.REFUND_POLICY,
      topK: 3,
    });
    expect(result.toolCalls[0].toolName).toBe(AiccToolName.SEARCH_KNOWLEDGE);
    expect(result.handoffRequest).toBeUndefined();
    expect(result.reply).toContain("Chính sách hoàn tiền");
  });

  it("creates handoff when refund policy knowledge is missing", async () => {
    knowledgeTool.searchKnowledge.mockResolvedValueOnce({
      documents: [],
      belowThreshold: true,
    });

    const result = await service.handleMessage({
      sessionId: "aicc_test",
      turnNo: 1,
      message: "Refund ve nay giup toi",
    });

    expect(result.intent).toBe(AiccIntent.REFUND_POLICY);
    expect(result.handoffRequest?.reason).toBe(AiccHandoffReason.REFUND);
    expect(result.reply).toContain("chưa có thông tin chắc chắn");
  });
});

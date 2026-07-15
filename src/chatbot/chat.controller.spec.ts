import { Test, TestingModule } from "@nestjs/testing";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { OllamaService } from "./ollama.service";

describe("ChatController", () => {
  let controller: ChatController;

  const mockChatService = {
    createPrompt: jest.fn(),
    handleChatMessage: jest.fn(),
  };

  const mockOllamaService = {
    generateResponse: jest.fn(),
  };

  const mockChatResponse = {
    response: "AI response text",
    eventData: [],
    intent: "general",
    timestamp: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: mockChatService },
        { provide: OllamaService, useValue: mockOllamaService },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("POST /chat/message", () => {
    it("should return success response when all steps complete", async () => {
      mockChatService.createPrompt.mockResolvedValue("generated prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(mockChatResponse);

      const result = await controller.sendMessage({
        message: "What events are upcoming?",
        sessionId: "session-1",
      } as any);

      expect(mockChatService.createPrompt).toHaveBeenCalledWith(
        "What events are upcoming?"
      );
      expect(mockOllamaService.generateResponse).toHaveBeenCalledWith(
        "generated prompt"
      );
      expect(mockChatService.handleChatMessage).toHaveBeenCalledWith(
        "What events are upcoming?",
        "AI response"
      );
      expect(result.success).toBe(true);
      expect(result.data.message).toBe("AI response text");
      expect(result.data.intent).toBe("general");
      expect(result.data.sessionId).toBe("session-1");
    });

    it("should assign a new sessionId when not provided", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(mockChatResponse);

      const result = await controller.sendMessage({
        message: "Hello",
      } as any);

      expect(result.data.sessionId).toMatch(/^chat_\d+_/);
    });

    it("should return error response when chatService.createPrompt throws", async () => {
      mockChatService.createPrompt.mockRejectedValue(new Error("Prompt error"));

      const result = await controller.sendMessage({
        message: "Hello",
        sessionId: "s1",
      } as any);

      expect(result.success).toBe(false);
      expect(result.data.message).toBe(
        "Xin lỗi, tôi gặp sự cố. Vui lòng thử lại."
      );
      expect(result.data.intent).toBe("error");
    });

    it("should generate new sessionId in error path when not provided", async () => {
      mockChatService.createPrompt.mockRejectedValue(new Error("Error"));

      const result = await controller.sendMessage({
        message: "Hello",
      } as any);

      expect(result.data.sessionId).toMatch(/^chat_\d+_/);
    });

    it("should return error response when ollamaService throws", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockRejectedValue(
        new Error("Ollama down")
      );

      const result = await controller.sendMessage({
        message: "Hello",
        sessionId: "s1",
      } as any);

      expect(result.success).toBe(false);
      expect(result.data.intent).toBe("error");
    });

    it("should return error response when handleChatMessage throws", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockRejectedValue(
        new Error("Processing error")
      );

      const result = await controller.sendMessage({
        message: "Hello",
        sessionId: "s1",
      } as any);

      expect(result.success).toBe(false);
      expect(result.data.intent).toBe("error");
    });

    it("should map event data correctly in success path", async () => {
      const startDate = new Date("2026-06-01");
      const endDate = new Date("2026-06-02");
      const chatResponseWithEvents = {
        ...mockChatResponse,
        eventData: [
          {
            id: "507f1f77bcf86cd799439011",
            title: "Concert",
            description: "A great concert",
            startDate,
            endDate,
            location: "Stadium",
            thumbnail: "http://img.url",
            isActiveNow: false,
            status: "active" as const,
          },
        ],
      };
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(
        chatResponseWithEvents
      );

      const result = await controller.sendMessage({
        message: "Events",
        sessionId: "s1",
      } as any);

      expect(result.data.events).toHaveLength(1);
      expect(result.data.events[0]).toEqual({
        id: "507f1f77bcf86cd799439011",
        title: "Concert",
        description: "A great concert",
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        location: "Stadium",
        thumbnail: "http://img.url",
        isActiveNow: false,
        status: "active",
      });
    });
  });

  describe("GET /chat/suggest", () => {
    it("should return suggestions for upcoming events by default", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(mockChatResponse);

      const result = await controller.getSuggestions("upcoming");

      expect(mockChatService.createPrompt).toHaveBeenCalledWith(
        "Sự kiện sắp diễn ra"
      );
      expect(result.success).toBe(true);
      expect(result.data.intent).toBe("suggest");
    });

    it("should return suggestions for active events", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(mockChatResponse);

      const result = await controller.getSuggestions("active");

      expect(mockChatService.createPrompt).toHaveBeenCalledWith(
        "Sự kiện đang diễn ra"
      );
      expect(result.success).toBe(true);
    });

    it("should return general suggestions for unknown type", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(mockChatResponse);

      const result = await controller.getSuggestions("popular");

      expect(mockChatService.createPrompt).toHaveBeenCalledWith(
        "Đề xuất sự kiện cho tôi"
      );
      expect(result.success).toBe(true);
    });

    it("should limit events to 5 in suggestion response", async () => {
      const startDate = new Date("2026-07-01");
      const endDate = new Date("2026-07-02");
      const manyEvents = {
        ...mockChatResponse,
        eventData: Array.from({ length: 10 }, (_, i) => ({
          id: `507f1f77bcf86cd79943901${i}`,
          title: `Event ${i}`,
          description: `Description ${i}`,
          startDate,
          endDate,
          location: "Venue",
          thumbnail: null,
          isActiveNow: false,
          status: "active" as const,
        })),
      };
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(manyEvents);

      const result = await controller.getSuggestions("upcoming");

      expect(result.data.events.length).toBeLessThanOrEqual(5);
    });

    it("should return error response when service throws", async () => {
      mockChatService.createPrompt.mockRejectedValue(new Error("Error"));

      const result = await controller.getSuggestions("upcoming");

      expect(result.success).toBe(false);
      expect(result.data.message).toBe("Không thể tải đề xuất.");
      expect(result.data.intent).toBe("error");
    });

    it("should generate sessionId on error", async () => {
      mockChatService.createPrompt.mockRejectedValue(new Error("Error"));

      const result = await controller.getSuggestions("upcoming");

      expect(result.data.sessionId).toMatch(/^chat_\d+_/);
    });
  });

  describe("GET /chat/event", () => {
    it("should return event details when eventId is provided", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(mockChatResponse);

      const result = await controller.getEventDetails(
        "507f1f77bcf86cd799439011"
      );

      expect(mockChatService.createPrompt).toHaveBeenCalledWith(
        "Xem chi tiết sự kiện ID: 507f1f77bcf86cd799439011"
      );
      expect(result.success).toBe(true);
      expect(result.data.intent).toBe("event_detail");
    });

    it("should map event data in getEventDetails success path", async () => {
      const startDate = new Date("2026-06-01");
      const endDate = new Date("2026-06-02");
      const eventDetailsResponse = {
        ...mockChatResponse,
        intent: "event_detail",
        eventData: [
          {
            id: "507f1f77bcf86cd799439011",
            title: "Chi tiết sự kiện",
            description: "Mô tả chi tiết",
            startDate,
            endDate,
            location: "Hồ Chí Minh",
            thumbnail: "https://example.com/thumb.jpg",
            isActiveNow: true,
            status: "active" as const,
          },
        ],
      };
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockResolvedValue(eventDetailsResponse);

      const result = await controller.getEventDetails(
        "507f1f77bcf86cd799439011"
      );

      expect(result.data.events).toHaveLength(1);
      expect(result.data.events[0].title).toBe("Chi tiết sự kiện");
      expect(result.data.events[0].location).toBe("Hồ Chí Minh");
    });

    it("should return error when eventId is empty", async () => {
      const result = await controller.getEventDetails("");

      expect(result.success).toBe(false);
      expect(result.data.message).toBe("Không tìm thấy sự kiện.");
      expect(result.data.intent).toBe("error");
    });

    it("should return error when eventId is undefined", async () => {
      const result = await controller.getEventDetails(undefined as any);

      expect(result.success).toBe(false);
      expect(result.data.message).toBe("Không tìm thấy sự kiện.");
    });

    it("should return error when service throws", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockRejectedValue(
        new Error("Ollama error")
      );

      const result = await controller.getEventDetails(
        "507f1f77bcf86cd799439011"
      );

      expect(result.success).toBe(false);
      expect(result.data.intent).toBe("error");
    });

    it("should return error when handleChatMessage throws", async () => {
      mockChatService.createPrompt.mockResolvedValue("prompt");
      mockOllamaService.generateResponse.mockResolvedValue("AI response");
      mockChatService.handleChatMessage.mockRejectedValue(
        new Error("Processing error")
      );

      const result = await controller.getEventDetails(
        "507f1f77bcf86cd799439011"
      );

      expect(result.success).toBe(false);
      expect(result.data.intent).toBe("error");
    });
  });
});

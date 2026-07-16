import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Body,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ChatService } from "./chat.service";
import { OllamaService } from "./ollama.service";
import { ChatRequestDto, ChatResponseDto } from "./chat.dto";

@Controller("chat")
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly ollamaService: OllamaService
  ) {}

  private buildChatResponse(data: ChatResponseDto): ChatResponseDto {
    return data;
  }

  @Throttle({ short: { limit: 15, ttl: 60000 } })
  @Post("message")
  async sendMessage(@Body() body: ChatRequestDto): Promise<ChatResponseDto> {
    try {
      const { message, sessionId } = body;

      // 1. Tạo prompt từ câu hỏi
      const prompt = await this.chatService.createPrompt(message);

      // 2. Gửi cho AI
      const aiResponse = await this.ollamaService.generateResponse(prompt);

      // 3. Xử lý kết quả
      const result = await this.chatService.handleChatMessage(
        message,
        aiResponse
      );

      return this.buildChatResponse({
        message: result.response,
        events: result.eventData.map((event) => ({
          id: event.id.toString(),
          title: event.title,
          description: event.description,
          startDate: event.startDate.toISOString(),
          endDate: event.endDate.toISOString(),
          location: event.location,
          thumbnail: event.thumbnail,
          isActiveNow: event.isActiveNow,
          status: event.status,
        })),
        intent: result.intent,
        sessionId: sessionId || this.createSessionId(),
        timestamp: result.timestamp,
      });
    } catch (error) {
      this.logger.error("Lỗi xử lý tin nhắn:", error);
      throw new ServiceUnavailableException({
        code: "CHAT_MESSAGE_UNAVAILABLE",
        message: "Xin lỗi, tôi gặp sự cố. Vui lòng thử lại.",
      });
    }
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("suggest")
  async getSuggestions(
    @Query("type") type: string = "upcoming"
  ): Promise<ChatResponseDto> {
    try {
      let query = "";
      if (type === "active") query = "Sự kiện đang diễn ra";
      else if (type === "upcoming") query = "Sự kiện sắp diễn ra";
      else query = "Đề xuất sự kiện cho tôi";

      const prompt = await this.chatService.createPrompt(query);
      const aiResponse = await this.ollamaService.generateResponse(prompt);
      const result = await this.chatService.handleChatMessage(
        query,
        aiResponse
      );

      return this.buildChatResponse({
        message: result.response,
        events: result.eventData.slice(0, 5).map((event) => ({
          id: event.id.toString(),
          title: event.title,
          description: event.description,
          startDate: event.startDate.toISOString(),
          endDate: event.endDate.toISOString(),
          location: event.location,
          thumbnail: event.thumbnail,
          isActiveNow: event.isActiveNow,
          status: event.status,
        })),
        intent: "suggest",
        sessionId: this.createSessionId(),
        timestamp: result.timestamp,
      });
    } catch {
      throw new ServiceUnavailableException({
        code: "CHAT_SUGGESTIONS_UNAVAILABLE",
        message: "Không thể tải đề xuất.",
      });
    }
  }

  @Get("event")
  async getEventDetails(
    @Query("id") eventId: string
  ): Promise<ChatResponseDto> {
    if (!eventId) {
      throw new BadRequestException({
        code: "CHAT_EVENT_ID_REQUIRED",
        message: "Thiếu ID sự kiện",
      });
    }

    try {
      const query = `Xem chi tiết sự kiện ID: ${eventId}`;
      const prompt = await this.chatService.createPrompt(query);
      const aiResponse = await this.ollamaService.generateResponse(prompt);
      const result = await this.chatService.handleChatMessage(
        query,
        aiResponse
      );

      return this.buildChatResponse({
        message: result.response,
        events: result.eventData.map((event) => ({
          id: event.id.toString(),
          title: event.title,
          description: event.description,
          startDate: event.startDate.toISOString(),
          endDate: event.endDate.toISOString(),
          location: event.location,
          thumbnail: event.thumbnail,
          isActiveNow: event.isActiveNow,
          status: event.status,
        })),
        intent: "event_detail",
        sessionId: this.createSessionId(),
        timestamp: result.timestamp,
      });
    } catch {
      throw new NotFoundException({
        code: "CHAT_EVENT_NOT_FOUND",
        message: "Không tìm thấy sự kiện.",
      });
    }
  }

  private createSessionId(): string {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

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
import { EventData } from "./chat.interface";
import { getErrorMessage } from "@src/helper/getErrorMessage";

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

  private toResponseEvents(events: EventData[]): ChatResponseDto["events"] {
    return events.map((event) => ({
      id: event.id.toString(),
      title: event.title,
      description: event.description,
      startDate: event.startDate.toISOString(),
      endDate: event.endDate.toISOString(),
      location: event.location,
      thumbnail: event.thumbnail,
      isActiveNow: event.isActiveNow,
      status: event.status,
    }));
  }

  @Throttle({ short: { limit: 15, ttl: 60000 } })
  @Post("message")
  async sendMessage(@Body() body: ChatRequestDto): Promise<ChatResponseDto> {
    try {
      const { message, sessionId } = body;

      const prompt = await this.chatService.createPrompt(message);
      const aiResponse = await this.ollamaService.generateResponse(prompt);
      const result = await this.chatService.handleChatMessage(
        message,
        aiResponse
      );

      return this.buildChatResponse({
        message: result.response,
        events: this.toResponseEvents(result.eventData),
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
        events: this.toResponseEvents(result.eventData.slice(0, 5)),
        intent: "suggest",
        sessionId: this.createSessionId(),
        timestamp: result.timestamp,
      });
    } catch (error) {
      this.logger.error(
        `chat.suggestions_unavailable type=${type}: ${getErrorMessage(error)}`
      );
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
        events: this.toResponseEvents(result.eventData),
        intent: "event_detail",
        sessionId: this.createSessionId(),
        timestamp: result.timestamp,
      });
    } catch (error) {
      this.logger.error(
        `chat.event_detail_unavailable eventId=${eventId}: ${getErrorMessage(error)}`
      );
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

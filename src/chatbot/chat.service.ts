import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { ChatResponse, EventData } from "./chat.interface";
import { Event } from "@src/schemas/event.schema";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { getErrorMessage } from "@src/helper/getErrorMessage";

interface ChatEventSource {
  _id: Types.ObjectId | string;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  location: string;
  thumbnail?: string;
  status: EventData["status"];
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  private sanitizeUserInput(input: string): string {
    return input
      .substring(0, 500)
      .replace(/["\\]/g, "\\$&")
      .replace(/\n/g, " ");
  }

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>
  ) {}

  private detectIntent(query: string): string {
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes("xem vé") || lowerQuery.includes("danh sách")) {
      return "view_events";
    }

    if (
      lowerQuery.includes("chi tiết") ||
      lowerQuery.match(/[0-9a-fA-F]{24}/)
    ) {
      return "event_details";
    }

    if (lowerQuery.includes("đề xuất") || lowerQuery.includes("gợi ý")) {
      return "recommend_events";
    }

    if (
      lowerQuery.includes("đang diễn ra") ||
      lowerQuery.includes("hiện tại")
    ) {
      return "active_events";
    }

    if (lowerQuery.includes("sắp diễn ra") || lowerQuery.includes("sắp tới")) {
      return "upcoming_events";
    }

    if (lowerQuery.includes("giá") || lowerQuery.includes("mua vé")) {
      return "booking_info";
    }

    return "general";
  }

  private async getEventsByIntent(
    query: string,
    intent: string
  ): Promise<ChatEventSource[]> {
    const now = new Date();
    const filter: FilterQuery<Event> = {
      isDeleted: false,
      status: "active",
    };

    switch (intent) {
      case "view_events":
        return this.eventModel
          .find(filter)
          .sort({ startDate: 1 })
          .limit(10)
          .exec();

      case "active_events":
        filter.startDate = { $lte: now };
        filter.endDate = { $gte: now };
        return this.eventModel
          .find(filter)
          .sort({ startDate: 1 })
          .limit(5)
          .exec();

      case "upcoming_events":
        filter.startDate = { $gt: now };
        return this.eventModel
          .find(filter)
          .sort({ startDate: 1 })
          .limit(5)
          .exec();

      case "recommend_events":
        filter.startDate = { $gt: now };
        return this.eventModel
          .find(filter)
          .sort({ startDate: 1 })
          .limit(5)
          .exec();

      case "event_details": {
        const eventId = this.getEventIdFromQuery(query);
        if (eventId) {
          const event = await this.eventModel
            .findOne({
              _id: new Types.ObjectId(eventId),
              isDeleted: false,
            })
            .exec();
          return event ? [event] : [];
        }
        const keywords = this.getKeywords(query);
        if (keywords.length > 0) {
          const regexKeywords = keywords.map(
            (keyword) => new RegExp(escapeRegex(keyword), "i")
          );
          filter.$or = [
            { title: { $in: regexKeywords } },
            { description: { $in: regexKeywords } },
            { location: { $in: regexKeywords } },
          ];
          return this.eventModel.find(filter).limit(3).exec();
        }
        return [];
      }

      default:
        return [];
    }
  }

  async createPrompt(query: string): Promise<string> {
    try {
      const intent = this.detectIntent(query);
      const events = await this.getEventsByIntent(query, intent);
      const today = new Date().toLocaleDateString("vi-VN");
      let prompt = `Bạn là trợ lý bán vé sự kiện. Hôm nay là ${today}.\n\n`;
      if (events.length > 0) {
        prompt += `Có ${events.length} sự kiện phù hợp:\n`;
        events.forEach((event, index) => {
          const startDate = new Date(event.startDate).toLocaleDateString(
            "vi-VN"
          );
          const endDate = new Date(event.endDate).toLocaleDateString("vi-VN");
          const isActive = this.checkEventActive(event);

          prompt += `${index + 1}. ${event.title}\n`;
          prompt += `   - Thời gian: ${startDate} đến ${endDate}\n`;
          prompt += `   - Địa điểm: ${event.location}\n`;
          prompt += `   - Trạng thái: ${isActive ? "Đang diễn ra" : "Sắp diễn ra"}\n`;
          if (event.description) {
            prompt += `   - Mô tả: ${event.description.substring(0, 100)}...\n`;
          }
          prompt += `\n`;
        });
      } else {
        prompt += `Hiện không có sự kiện phù hợp.\n`;
      }
      prompt += `\nHãy trả lời câu hỏi sau bằng tiếng Việt, thân thiện:\n`;
      prompt += `Câu hỏi: "${this.sanitizeUserInput(query)}"\n\n`;
      if (intent === "view_events") {
        prompt += `Gợi ý: Liệt kê các sự kiện, nêu thông tin cơ bản.`;
      } else if (intent === "event_details") {
        prompt += `Gợi ý: Mô tả chi tiết sự kiện nếu có.`;
      } else if (intent === "recommend_events") {
        prompt += `Gợi ý: Đề xuất sự kiện phù hợp, giải thích tại sao.`;
      } else if (intent === "booking_info") {
        prompt += `Gợi ý: Hướng dẫn cách mua vé, không tự bịa giá.`;
      } else {
        prompt += `Gợi ý: Trả lời tự nhiên, liên hệ đến sự kiện nếu phù hợp.`;
      }
      prompt += `\nKết thúc bằng câu hỏi mở để hỗ trợ thêm.`;

      return prompt;
    } catch (error) {
      this.logger.error(`chat.prompt_failed: ${getErrorMessage(error)}`);
      return this.getSimplePrompt(query);
    }
  }

  async processAIResponse(
    userQuery: string,
    aiResponse: string
  ): Promise<ChatResponse> {
    const intent = this.detectIntent(userQuery);
    const events = await this.getEventsByIntent(userQuery, intent);

    const eventData: EventData[] = events.map((event) => ({
      id: event._id,
      title: event.title,
      description: event.description || undefined,
      startDate: event.startDate,
      endDate: event.endDate,
      location: event.location,
      thumbnail: event.thumbnail || undefined,
      isActiveNow: this.checkEventActive(event),
      status: event.status,
    }));

    return this.chatResponse(aiResponse, eventData, intent);
  }

  private chatResponse(
    response: string,
    eventData: EventData[],
    intent: string
  ): ChatResponse {
    return {
      response,
      eventData,
      intent,
      timestamp: new Date(),
    };
  }

  private checkEventActive(event: ChatEventSource): boolean {
    const now = new Date();
    return (
      event.status === "active" &&
      now >= event.startDate &&
      now <= event.endDate
    );
  }

  private getEventIdFromQuery(query: string): string | null {
    const match = query.match(/[0-9a-fA-F]{24}/);
    return match ? match[0] : null;
  }

  private getKeywords(query: string): string[] {
    const stopWords = [
      "của",
      "và",
      "hoặc",
      "nào",
      "cho",
      "tôi",
      "bạn",
      "có",
      "không",
    ];
    const words = query
      .toLowerCase()
      .split(/[\s,.!?]+/)
      .filter((word) => word.length > 2 && !stopWords.includes(word));

    return [...new Set(words)];
  }

  private getSimplePrompt(query: string): string {
    return `Bạn là trợ lý bán vé sự kiện. 
    
Khách hỏi: "${query}"

Hãy trả lời bằng tiếng Việt, thân thiện. 
Nếu hỏi về sự kiện, hãy đề nghị họ cung cấp thêm thông tin.
Kết thúc bằng: "Bạn cần hỗ trợ gì thêm không?"`;
  }

  async handleChatMessage(
    userQuery: string,
    aiResponse: string
  ): Promise<ChatResponse> {
    return this.processAIResponse(userQuery, aiResponse);
  }

  async getEventsForIds(eventIds: string[]): Promise<EventData[]> {
    const validIds = eventIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    if (validIds.length === 0) return [];

    const events = await this.eventModel
      .find({
        _id: { $in: validIds },
        isDeleted: false,
      })
      .exec();
    return events.map((event) => ({
      id: event._id,
      title: event.title,
      description: event.description || undefined,
      startDate: event.startDate,
      endDate: event.endDate,
      location: event.location,
      thumbnail: event.thumbnail || undefined,
      isActiveNow: this.checkEventActive(event),
      status: event.status,
    }));
  }
}

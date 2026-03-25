import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { OllamaService } from "./ollama.service";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { ChatGateway } from "./chat.gateway";
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
  ],
  controllers: [ChatController],
  providers: [ChatService, OllamaService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}

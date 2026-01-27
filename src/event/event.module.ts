import { Module } from "@nestjs/common";
import { EventService } from "./event.service";
import { EventController } from "./event.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { EventSchema } from "@src/schemas/event.schema";
import { UserSchema } from "@src/schemas/user.schema";
import { ZoneSchema } from "@src/schemas/zone.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Event", schema: EventSchema },
      { name: "User", schema: UserSchema },
      {name: "Zone", schema: ZoneSchema}
    ]),
  ],
  controllers: [EventController],
  providers: [EventService],
})
export class EventModule {}

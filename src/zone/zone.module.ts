import { Module } from "@nestjs/common";
import { ZoneService } from "./zone.service";
import { ZoneController } from "./zone.controller";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { MongooseModule } from "@nestjs/mongoose/dist/mongoose.module";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { ZoneGateway } from "./zone.gateway";
import { Area, AreaSchema } from "@src/schemas/area.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Zone.name, schema: ZoneSchema },
      { name: Event.name, schema: EventSchema },
      { name: Area.name, schema: AreaSchema },
    ]),
  ],
  controllers: [ZoneController],
  providers: [ZoneService, ZoneGateway],
  exports: [ZoneService, ZoneGateway],
})
export class ZoneModule {}

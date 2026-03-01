import { Module } from "@nestjs/common";
import { AreaService } from "./area.service";
import { AreaController } from "./area.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Area.name, schema: AreaSchema },{ name: Zone.name, schema: ZoneSchema }]),
  ],
  controllers: [AreaController],
  providers: [AreaService],
})
export class AreaModule {}

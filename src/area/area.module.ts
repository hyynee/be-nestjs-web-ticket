import { Module } from "@nestjs/common";
import { AreaService } from "./area.service";
import { AreaManagementController } from "./controllers/area-management.controller";
import { AreaQueryController } from "./controllers/area-query.controller";
import { AreaCommandService } from "./application/area-command.service";
import { AreaQueryService } from "./application/area-query.service";
import { AreaMutationPolicy } from "./domain/policies/area-mutation.policy";
import { AreaCacheService } from "./infrastructure/cache/area-cache.service";
import { AreaRepository } from "./infrastructure/persistence/area.repository";
import { AreaPresenter } from "./presenters/area.presenter";
import { MongooseModule } from "@nestjs/mongoose";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Area.name, schema: AreaSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [AreaManagementController, AreaQueryController],
  providers: [
    AreaService,
    AreaCommandService,
    AreaQueryService,
    AreaRepository,
    AreaPresenter,
    AreaCacheService,
    AreaMutationPolicy,
    EventOwnershipService,
  ],
})
export class AreaModule {}

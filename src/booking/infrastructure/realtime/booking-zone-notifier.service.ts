import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Zone } from "@src/schemas/zone.schema";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { Model, Types } from "mongoose";

@Injectable()
export class BookingZoneNotifierService {
  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly zoneGateway: ZoneGateway
  ) {}

  async emitZoneTicketUpdate(zoneId: Types.ObjectId | string): Promise<void> {
    const zone = await this.zoneModel
      .findById(zoneId)
      .select("_id eventId capacity soldCount confirmedSoldCount")
      .lean();

    if (!zone) {
      return;
    }

    this.zoneGateway.emitZoneTicketUpdate({
      zoneId: zone._id,
      eventId: zone.eventId,
      capacity: zone.capacity,
      soldCount: zone.soldCount,
      confirmedSoldCount: zone.confirmedSoldCount || 0,
      availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
    });
  }
}

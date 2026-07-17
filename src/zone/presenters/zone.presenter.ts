import { BadRequestException, Injectable } from "@nestjs/common";
import {
  ZoneAreaView,
  ZoneAreaViewSource,
  ZoneView,
  ZoneViewSource,
  ZoneWithAreasView,
} from "../domain/types/zone.types";

@Injectable()
export class ZonePresenter {
  toZoneAreaView(area: ZoneAreaViewSource): ZoneAreaView {
    const id = area._id?.toString() ?? area.id;
    if (!id) {
      throw new BadRequestException("Area ID is missing");
    }

    return {
      id,
      name: area.name,
      description: area.description,
      rowLabel: area.rowLabel,
      seatCount: area.seats?.length ?? area.seatCount ?? 0,
      seats: area.seats ?? [],
    };
  }

  toZoneView(zone: ZoneViewSource): ZoneView {
    const id = zone._id?.toString() ?? zone.id;
    if (!id) {
      throw new BadRequestException("Zone ID is missing");
    }

    return {
      id,
      eventId: zone.eventId.toString(),
      name: zone.name,
      description: zone.description,
      price: zone.price,
      capacity: zone.capacity,
      currentTotalSeats: zone.currentTotalSeats ?? 0,
      soldCount: zone.soldCount ?? 0,
      confirmedSoldCount: zone.confirmedSoldCount ?? 0,
      hasSeating: zone.hasSeating,
      saleStartDate: zone.saleStartDate,
      saleEndDate: zone.saleEndDate,
      createdAt: zone.createdAt,
      updatedAt: zone.updatedAt,
    };
  }

  toZoneWithAreasView(zone: ZoneViewSource): ZoneWithAreasView {
    return {
      ...this.toZoneView(zone),
      areas: (zone.areas ?? []).map((area) => this.toZoneAreaView(area)),
    };
  }
}

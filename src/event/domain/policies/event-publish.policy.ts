import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Area } from "@src/schemas/area.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Model, Types } from "mongoose";

@Injectable()
export class EventPublishPolicy {
  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>
  ) {}

  assertEventFieldsPublishable(
    title: string,
    location: string,
    startDate: Date,
    endDate: Date
  ): void {
    if (!title || !title.trim()) {
      throw new BadRequestException("Event thiếu tiêu đề, không thể publish");
    }
    if (!location || !location.trim()) {
      throw new BadRequestException("Event thiếu địa điểm, không thể publish");
    }
    if (!(new Date(startDate) < new Date(endDate))) {
      throw new BadRequestException(
        "Ngày bắt đầu phải trước ngày kết thúc để publish"
      );
    }
  }

  async assertInventoryPublishable(
    eventId: Types.ObjectId,
    eventEndDate: Date
  ): Promise<void> {
    const zones = await this.zoneModel
      .find({ eventId, isDeleted: false })
      .lean();

    if (zones.length === 0) {
      throw new BadRequestException(
        "Event chưa có zone nào đang hoạt động, không thể publish"
      );
    }

    const totalCapacity = zones.reduce(
      (sum, zone) => sum + (zone.capacity ?? 0),
      0
    );
    if (totalCapacity <= 0) {
      throw new BadRequestException(
        "Tổng capacity của các zone phải lớn hơn 0 để publish"
      );
    }

    for (const zone of zones) {
      if (typeof zone.price !== "number" || zone.price < 0) {
        throw new BadRequestException(
          `Zone "${zone.name}" có giá vé không hợp lệ`
        );
      }
      if (
        zone.saleStartDate &&
        zone.saleEndDate &&
        zone.saleStartDate > zone.saleEndDate
      ) {
        throw new BadRequestException(
          `Zone "${zone.name}" có thời gian mở bán không hợp lệ (bắt đầu sau kết thúc)`
        );
      }
      if (zone.saleEndDate && zone.saleEndDate > new Date(eventEndDate)) {
        throw new BadRequestException(
          `Zone "${zone.name}" có ngày kết thúc mở bán sau ngày kết thúc sự kiện`
        );
      }
    }

    const seatingZoneIds = zones
      .filter((zone) => zone.hasSeating)
      .map((zone) => zone._id);

    if (seatingZoneIds.length === 0) {
      return;
    }

    const areas = await this.areaModel
      .find({ zoneId: { $in: seatingZoneIds }, isDeleted: false })
      .lean();

    const areasByZoneId = new Map<string, typeof areas>();
    for (const area of areas) {
      const key = area.zoneId.toString();
      const bucket = areasByZoneId.get(key);
      if (bucket) {
        bucket.push(area);
      } else {
        areasByZoneId.set(key, [area]);
      }
    }

    for (const zone of zones) {
      if (!zone.hasSeating) {
        continue;
      }
      const zoneAreas = areasByZoneId.get(zone._id.toString()) ?? [];
      if (zoneAreas.length === 0) {
        throw new BadRequestException(
          `Zone "${zone.name}" bật bán theo ghế nhưng chưa có khu vực (area) nào`
        );
      }
      for (const area of zoneAreas) {
        if (!area.seats || area.seats.length === 0) {
          throw new BadRequestException(
            `Khu vực "${area.name}" (zone "${zone.name}") chưa có ghế nào`
          );
        }
        if (new Set(area.seats).size !== area.seats.length) {
          throw new BadRequestException(
            `Khu vực "${area.name}" (zone "${zone.name}") có ghế bị trùng lặp`
          );
        }
      }
    }
  }
}

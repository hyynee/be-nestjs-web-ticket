import { BadRequestException, Injectable } from "@nestjs/common";
import { CreateEventDTO } from "../../dto/create-event.dto";

@Injectable()
export class EventTimeSlotPolicy {
  validateTimeSlots(
    timeSlots: CreateEventDTO["timeSlots"],
    startDate: Date,
    endDate: Date
  ): void {
    if (!timeSlots || timeSlots.length === 0) {
      return;
    }

    for (const slot of timeSlots) {
      if (slot.startTime >= slot.endTime) {
        throw new BadRequestException(
          `Slot "${slot.label}": startTime phải trước endTime`
        );
      }
      if (slot.startTime < startDate) {
        throw new BadRequestException(
          `Slot "${slot.label}": startTime không được trước startDate của sự kiện`
        );
      }
      if (slot.endTime > endDate) {
        throw new BadRequestException(
          `Slot "${slot.label}": endTime không được sau endDate của sự kiện`
        );
      }
    }
  }
}

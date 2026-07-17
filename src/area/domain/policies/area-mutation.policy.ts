import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventStatus } from "@src/schemas/event.schema";
import { ClientSession, Types } from "mongoose";
import { CreateAreaDTO } from "../../dto/create.dto";
import { UpdateAreaDTO } from "../../dto/update.dto";
import { AreaRepository } from "../../infrastructure/persistence/area.repository";

const AREA_MODIFIABLE_EVENT_STATUSES = new Set<EventStatus>([
  EventStatus.DRAFT,
  EventStatus.INACTIVE,
]);

@Injectable()
export class AreaMutationPolicy {
  constructor(private readonly areaRepository: AreaRepository) {}

  assertValidSeatCount(seatCount?: number): void {
    if (typeof seatCount === "number" && seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }
  }

  assertCreateSeatInput(dto: CreateAreaDTO): void {
    this.assertValidSeatCount(dto.seatCount);
    if (
      typeof dto.seatCount === "number" &&
      dto.seatCount > 0 &&
      !dto.rowLabel &&
      (!dto.seats || dto.seats.length === 0)
    ) {
      throw new BadRequestException(
        "rowLabel is required when seatCount is provided"
      );
    }
  }

  buildCreateSeats(dto: CreateAreaDTO): string[] {
    let finalSeats: string[] = dto.seats ?? [];
    if (
      finalSeats.length === 0 &&
      typeof dto.seatCount === "number" &&
      dto.seatCount > 0 &&
      dto.rowLabel
    ) {
      finalSeats = this.generateSeats(dto.rowLabel, dto.seatCount);
    }
    return finalSeats;
  }

  buildUpdateSeats(input: {
    dto: UpdateAreaDTO;
    currentRowLabel?: string;
    currentSeatCount?: number;
    currentSeats?: string[];
  }): {
    rowLabel?: string;
    seats: string[];
    seatCount: number;
  } {
    this.assertValidSeatCount(input.dto.seatCount);

    const nextRowLabel = input.dto.rowLabel ?? input.currentRowLabel;
    let nextSeats = input.dto.seats ?? input.currentSeats ?? [];

    if (
      typeof input.dto.seatCount === "number" &&
      input.dto.seatCount > 0 &&
      (!nextRowLabel || nextRowLabel.trim().length === 0) &&
      nextSeats.length === 0
    ) {
      throw new BadRequestException(
        "rowLabel is required when seatCount is provided"
      );
    }

    if (
      typeof input.dto.seatCount === "number" &&
      input.dto.seatCount > 0 &&
      nextSeats.length === 0 &&
      nextRowLabel
    ) {
      nextSeats = this.generateSeats(nextRowLabel, input.dto.seatCount);
    }

    return {
      rowLabel: nextRowLabel,
      seats: nextSeats,
      seatCount: this.getAreaSeatCount({
        seatCount: input.dto.seatCount ?? input.currentSeatCount,
        seats: nextSeats,
      }),
    };
  }

  async assertEventModifiable(
    eventId: Types.ObjectId,
    session?: ClientSession
  ): Promise<void> {
    const event = await this.areaRepository.findEventStatus(eventId, session);
    if (!event) {
      throw new NotFoundException("Event not found or has been deleted");
    }

    if (!AREA_MODIFIABLE_EVENT_STATUSES.has(event.status)) {
      throw new ConflictException({
        code: "EVENT_NOT_MODIFIABLE",
        message: `Areas cannot be modified while the event is "${event.status}"`,
      });
    }
  }

  areSeatsEqual(a: string[] = [], b: string[] = []): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((seat, index) => seat === b[index]);
  }

  getAreaSeatCount(area: { seatCount?: number; seats?: string[] }): number {
    if (area.seats && area.seats.length > 0) {
      return area.seats.length;
    }
    return area.seatCount ?? 0;
  }

  private generateSeats(rowLabel: string, seatCount: number): string[] {
    return Array.from(
      { length: seatCount },
      (_, index) => `${rowLabel.toUpperCase()}${index + 1}`
    );
  }
}

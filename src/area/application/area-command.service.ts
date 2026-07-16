import { BadRequestException, Injectable } from "@nestjs/common";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Types } from "mongoose";
import { AreaMutationPolicy } from "../domain/policies/area-mutation.policy";
import type { AreaView } from "../domain/types/area.types";
import { CreateAreaDTO } from "../dto/create.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "../dto/update.dto";
import { AreaCacheService } from "../infrastructure/cache/area-cache.service";
import { AreaRepository } from "../infrastructure/persistence/area.repository";
import { AreaPresenter } from "../presenters/area.presenter";

@Injectable()
export class AreaCommandService {
  constructor(
    private readonly areaRepository: AreaRepository,
    private readonly areaMutationPolicy: AreaMutationPolicy,
    private readonly areaCacheService: AreaCacheService,
    private readonly areaPresenter: AreaPresenter,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  async createArea(
    currentUser: JwtPayload,
    createAreaDto: CreateAreaDTO
  ): Promise<AreaView> {
    const { zoneId, name, description, rowLabel } = createAreaDto;

    if (!Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    this.areaMutationPolicy.assertCreateSeatInput(createAreaDto);

    const zoneObjectId = new Types.ObjectId(zoneId);
    const session = await this.areaRepository.startSession();

    try {
      let savedArea!: AreaView;

      await session.withTransaction(async () => {
        const zone = await this.areaRepository.findZoneForMutation(
          zoneObjectId,
          session
        );

        if (!zone) {
          throw new BadRequestException("Zone not found");
        }
        if (!zone.hasSeating) {
          throw new BadRequestException(
            "This zone does not support seats/areas"
          );
        }

        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          zone.eventId.toString()
        );

        await this.areaMutationPolicy.assertEventModifiable(
          zone.eventId,
          session
        );

        const finalSeats =
          this.areaMutationPolicy.buildCreateSeats(createAreaDto);
        const normalizedSeatCount = this.areaMutationPolicy.getAreaSeatCount({
          seatCount: createAreaDto.seatCount,
          seats: finalSeats,
        });

        await this.areaRepository.incrementZoneCapacity(
          zoneObjectId,
          normalizedSeatCount,
          session
        );

        const area = await this.areaRepository.createArea(
          {
            eventId: zone.eventId,
            zoneId: zoneObjectId,
            name: name.trim().toUpperCase(),
            description,
            rowLabel,
            seatCount: normalizedSeatCount,
            seats: finalSeats,
            createdBy: currentUser.userId,
          },
          session
        );

        savedArea = this.areaPresenter.toAreaView(area);
      });

      await this.areaCacheService.invalidateAreaCache(savedArea.id);
      return savedArea;
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        throw new BadRequestException("Area name already exists in this zone");
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async softDeleteArea(
    currentUser: JwtPayload,
    id: string,
    dto: SoftDeleteAreaDTO
  ): Promise<AreaView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const session = await this.areaRepository.startSession();

    try {
      let area!: AreaView;

      await session.withTransaction(async () => {
        const existing = await this.areaRepository.findAreaByDeletionState(
          id,
          !dto.isDeleted,
          session
        );

        if (!existing) {
          throw new BadRequestException("Area not found");
        }

        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          existing.eventId.toString()
        );

        if (dto.isDeleted) {
          const activeCount =
            await this.areaRepository.countActiveBookingsByArea(
              existing._id!,
              session
            );

          if (activeCount > 0) {
            throw new BadRequestException(
              `Cannot delete area: ${activeCount} active booking(s) exist`
            );
          }
        }

        const found = await this.areaRepository.updateAreaDeletionState(
          id,
          dto.isDeleted,
          currentUser.userId,
          session
        );

        if (!found) {
          throw new BadRequestException("Area not found");
        }

        const seatCount = found.seatCount ?? 0;
        await this.areaRepository.incrementZoneCapacity(
          new Types.ObjectId(found.zoneId),
          dto.isDeleted ? -seatCount : seatCount,
          session
        );

        area = this.areaPresenter.toAreaView(found);
      });

      await this.areaCacheService.invalidateAreaCache(id);
      return area;
    } finally {
      await session.endSession();
    }
  }

  async updateArea(
    currentUser: JwtPayload,
    id: string,
    dto: UpdateAreaDTO
  ): Promise<AreaView> {
    const { zoneId, name, description } = dto;

    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }
    this.areaMutationPolicy.assertValidSeatCount(dto.seatCount);

    const areaId = new Types.ObjectId(id);
    const session = await this.areaRepository.startSession();

    try {
      let updatedArea!: AreaView;

      await session.withTransaction(async () => {
        const currentArea = await this.areaRepository.findAreaForUpdate(
          areaId,
          session
        );

        if (!currentArea) {
          throw new BadRequestException("Area not found or has been deleted");
        }

        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          currentArea.eventId.toString()
        );

        const targetZoneId = zoneId
          ? new Types.ObjectId(zoneId)
          : currentArea.zoneId;
        const isMovingZone =
          zoneId && targetZoneId.toString() !== currentArea.zoneId.toString();

        const targetZone = await this.areaRepository.findZoneForMutation(
          targetZoneId,
          session
        );

        if (!targetZone) {
          throw new BadRequestException("Zone not found or has been deleted");
        }
        if (!targetZone.hasSeating) {
          throw new BadRequestException(
            "Cannot move/update area in a zone without seating"
          );
        }

        if (targetZone.eventId.toString() !== currentArea.eventId.toString()) {
          await this.eventOwnershipService.assertCanManageEvent(
            currentUser,
            targetZone.eventId.toString()
          );
        }

        await this.areaMutationPolicy.assertEventModifiable(
          targetZone.eventId,
          session
        );

        const nextSeatState = this.areaMutationPolicy.buildUpdateSeats({
          dto,
          currentRowLabel: currentArea.rowLabel,
          currentSeatCount: currentArea.seatCount,
          currentSeats: currentArea.seats,
        });

        if (isMovingZone) {
          await this.areaRepository.incrementZoneCapacity(
            currentArea.zoneId,
            -(currentArea.seatCount ?? 0),
            session
          );
          await this.areaRepository.incrementZoneCapacity(
            targetZoneId,
            nextSeatState.seatCount,
            session
          );
        } else {
          const seatDelta =
            nextSeatState.seatCount - (currentArea.seatCount ?? 0);
          await this.areaRepository.incrementZoneCapacity(
            targetZoneId,
            seatDelta,
            session
          );
        }

        const updatePayload: Record<string, unknown> = {
          eventId: targetZone.eventId,
          rowLabel: nextSeatState.rowLabel,
          seatCount: nextSeatState.seatCount,
          seats: nextSeatState.seats,
          updatedBy: currentUser.userId,
        };

        if (name !== undefined) {
          updatePayload.name = name.trim().toUpperCase();
        }
        if (description !== undefined) {
          updatePayload.description = description;
        }
        if (zoneId) {
          updatePayload.zoneId = new Types.ObjectId(zoneId);
        }

        const found = await this.areaRepository.updateArea(
          areaId,
          updatePayload,
          session
        );

        if (!found) {
          throw new BadRequestException("Area not found or has been deleted");
        }
        updatedArea = this.areaPresenter.toAreaView(found);
      });

      await this.areaCacheService.invalidateAreaCache(id);
      return updatedArea;
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        const label = name
          ? `"${name.trim().toUpperCase()}"`
          : "with this name";
        throw new BadRequestException(
          `Area ${label} already exists in this zone`
        );
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    );
  }
}

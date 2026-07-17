import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ZoneService } from "@src/zone/zone.service";
import { Types } from "mongoose";
import { AreaMutationPolicy } from "../domain/policies/area-mutation.policy";
import type { AreaView } from "../domain/types/area.types";
import { CreateAreaDTO } from "../dto/create.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "../dto/update.dto";
import { AreaCacheService } from "../infrastructure/cache/area-cache.service";
import {
  AreaRepository,
  AreaUpdateInput,
} from "../infrastructure/persistence/area.repository";
import { AreaPresenter } from "../presenters/area.presenter";

interface DuplicateKeyError {
  code: number;
  keyPattern?: Record<string, number>;
}

@Injectable()
export class AreaCommandService {
  private readonly logger = new Logger(AreaCommandService.name);

  constructor(
    private readonly areaRepository: AreaRepository,
    private readonly areaMutationPolicy: AreaMutationPolicy,
    private readonly areaCacheService: AreaCacheService,
    private readonly areaPresenter: AreaPresenter,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly zoneService: ZoneService
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
      const savedArea = await session.withTransaction(async () => {
        const zone = await this.areaRepository.findZoneForMutation(
          zoneObjectId,
          session
        );

        if (!zone) {
          throw new NotFoundException("Zone not found");
        }
        if (!zone.hasSeating) {
          throw new ConflictException("This zone does not support seats/areas");
        }

        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          zone.eventId.toString(),
          session
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

        return this.areaPresenter.toAreaView(area);
      });

      await Promise.all([
        this.areaCacheService.invalidateAreaCache(savedArea.id),
        this.zoneService.invalidateZoneAvailabilityCache(zoneId),
      ]);

      this.logger.log(
        `Area created: actor=${currentUser.userId} area=${savedArea.id} zone=${zoneId}`
      );
      return savedArea;
    } catch (err: unknown) {
      if (this.isDuplicateAreaNameError(err)) {
        throw new ConflictException("Area name already exists in this zone");
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
      const area = await session.withTransaction(async () => {
        const existing = await this.areaRepository.findAreaByDeletionState(
          id,
          !dto.isDeleted,
          session
        );

        if (!existing) {
          throw new NotFoundException("Area not found");
        }

        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          existing.eventId.toString(),
          session
        );

        await this.areaMutationPolicy.assertEventModifiable(
          new Types.ObjectId(existing.eventId),
          session
        );

        if (dto.isDeleted) {
          const activeCount =
            await this.areaRepository.countActiveBookingsByArea(
              existing._id!,
              session
            );

          if (activeCount > 0) {
            throw new ConflictException(
              `Cannot delete area: ${activeCount} active booking(s) exist`
            );
          }
        } else {
          const zone = await this.areaRepository.findZoneForMutation(
            new Types.ObjectId(existing.zoneId),
            session
          );

          if (!zone) {
            throw new NotFoundException(
              "Cannot restore area because its zone no longer exists"
            );
          }
          if (!zone.hasSeating) {
            throw new ConflictException(
              "Cannot restore area into a zone that no longer supports seating"
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
          throw new ConflictException(
            "Area deletion state changed concurrently, please retry"
          );
        }

        const seatCount = found.seatCount ?? 0;
        await this.areaRepository.incrementZoneCapacity(
          new Types.ObjectId(found.zoneId),
          dto.isDeleted ? -seatCount : seatCount,
          session
        );

        return this.areaPresenter.toAreaView(found);
      });

      await Promise.all([
        this.areaCacheService.invalidateAreaCache(id),
        this.zoneService.invalidateZoneAvailabilityCache(area.zoneId),
      ]);

      this.logger.log(
        `Area ${dto.isDeleted ? "deleted" : "restored"}: actor=${currentUser.userId} area=${id}`
      );
      return area;
    } catch (err: unknown) {
      if (this.isDuplicateAreaNameError(err)) {
        throw new ConflictException(
          "Cannot restore area because an active area with the same name already exists in this zone"
        );
      }
      throw err;
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
      const { area: updatedArea, affectedZoneIds } =
        await session.withTransaction(async () => {
          const currentArea = await this.areaRepository.findAreaForUpdate(
            areaId,
            session
          );

          if (!currentArea) {
            throw new NotFoundException("Area not found or has been deleted");
          }

          await this.eventOwnershipService.assertCanManageEvent(
            currentUser,
            currentArea.eventId.toString(),
            session
          );

          const targetZoneId = zoneId
            ? new Types.ObjectId(zoneId)
            : currentArea.zoneId;
          const isMovingZone =
            zoneId !== undefined &&
            targetZoneId.toString() !== currentArea.zoneId.toString();

          const targetZone = await this.areaRepository.findZoneForMutation(
            targetZoneId,
            session
          );

          if (!targetZone) {
            throw new NotFoundException("Zone not found or has been deleted");
          }
          if (!targetZone.hasSeating) {
            throw new ConflictException(
              "Cannot move/update area in a zone without seating"
            );
          }
          if (
            targetZone.eventId.toString() !== currentArea.eventId.toString()
          ) {
            throw new ConflictException({
              code: "AREA_CROSS_EVENT_MOVE_FORBIDDEN",
              message:
                "Area cannot be moved to a zone belonging to a different event",
            });
          }

          await this.areaMutationPolicy.assertEventModifiable(
            currentArea.eventId,
            session
          );

          const nextSeatState = this.areaMutationPolicy.buildUpdateSeats({
            dto,
            currentRowLabel: currentArea.rowLabel,
            currentSeatCount: currentArea.seatCount,
            currentSeats: currentArea.seats,
          });

          const hasStructuralChange =
            isMovingZone ||
            nextSeatState.seatCount !== (currentArea.seatCount ?? 0) ||
            !this.areaMutationPolicy.areSeatsEqual(
              nextSeatState.seats,
              currentArea.seats ?? []
            );

          if (hasStructuralChange) {
            const activeBookings =
              await this.areaRepository.countActiveBookingsByArea(
                areaId,
                session
              );

            if (activeBookings > 0) {
              throw new ConflictException(
                `Cannot change area structure or move it while ${activeBookings} active booking(s) exist`
              );
            }
          }

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

          const updatePayload: AreaUpdateInput = {
            eventId: targetZone.eventId,
            rowLabel: nextSeatState.rowLabel,
            seatCount: nextSeatState.seatCount,
            seats: nextSeatState.seats,
            updatedBy: currentUser.userId,
            ...(name !== undefined ? { name: name.trim().toUpperCase() } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(zoneId ? { zoneId: new Types.ObjectId(zoneId) } : {}),
          };

          const found = await this.areaRepository.updateArea(
            areaId,
            updatePayload,
            session
          );

          if (!found) {
            throw new ConflictException(
              "Area changed concurrently, please retry"
            );
          }

          const zoneIds = isMovingZone
            ? [currentArea.zoneId.toString(), targetZoneId.toString()]
            : [targetZoneId.toString()];

          return {
            area: this.areaPresenter.toAreaView(found),
            affectedZoneIds: zoneIds,
          };
        });

      await Promise.all([
        this.areaCacheService.invalidateAreaCache(id),
        ...affectedZoneIds.map((zid) =>
          this.zoneService.invalidateZoneAvailabilityCache(zid)
        ),
      ]);

      this.logger.log(`Area updated: actor=${currentUser.userId} area=${id}`);
      return updatedArea;
    } catch (err: unknown) {
      if (this.isDuplicateAreaNameError(err)) {
        const label = name
          ? `"${name.trim().toUpperCase()}"`
          : "with this name";
        throw new ConflictException(
          `Area ${label} already exists in this zone`
        );
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  private isDuplicateAreaNameError(error: unknown): error is DuplicateKeyError {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== 11000
    ) {
      return false;
    }

    const keyPattern = (error as DuplicateKeyError).keyPattern;
    return Boolean(keyPattern?.zoneId) && Boolean(keyPattern?.name);
  }
}

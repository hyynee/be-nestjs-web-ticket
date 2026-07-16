import { BadRequestException, Injectable } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { Area } from "@src/schemas/area.schema";
import { FilterQuery, Types } from "mongoose";
import { ALLOWED_AREA_SORT_FIELDS, AreaSortField } from "../area.constants";
import type { AreaView } from "../domain/types/area.types";
import { QueryAreaDto } from "../dto/query.dto";
import { AreaCacheService } from "../infrastructure/cache/area-cache.service";
import { AreaRepository } from "../infrastructure/persistence/area.repository";
import { AreaPresenter } from "../presenters/area.presenter";

@Injectable()
export class AreaQueryService {
  constructor(
    private readonly areaRepository: AreaRepository,
    private readonly areaCacheService: AreaCacheService,
    private readonly areaPresenter: AreaPresenter
  ) {}

  async getAllAreas(query: QueryAreaDto): Promise<PaginatedResponse<AreaView>> {
    const sortBy = this.resolveSortBy(query.sortBy);

    if (query.zoneId && !Types.ObjectId.isValid(query.zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }

    return this.areaCacheService.getAreaList(query, sortBy, async () =>
      this.loadAreas(query, sortBy)
    );
  }

  async getAreaById(id: string): Promise<AreaView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    return this.areaCacheService.getAreaDetail(id, async () => {
      const area = await this.areaRepository.findActiveAreaById(
        new Types.ObjectId(id)
      );
      if (!area) {
        throw new BadRequestException("Area not found or has been deleted");
      }
      return this.areaPresenter.toAreaView(area);
    });
  }

  private async loadAreas(
    query: QueryAreaDto,
    sortBy: AreaSortField
  ): Promise<PaginatedResponse<AreaView>> {
    const {
      zoneId,
      name,
      search,
      hasSeating,
      isDeleted = false,
      page = 1,
      limit = 10,
      sortOrder = "desc",
    } = query;

    const skip = (page - 1) * limit;
    const match: FilterQuery<Area> = { isDeleted };
    const sort: Partial<Record<AreaSortField, 1 | -1>> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    if (zoneId) {
      match.zoneId = new Types.ObjectId(zoneId);
    }
    if (name) {
      match.name = {
        $regex: `^${escapeRegex(name.trim().toUpperCase())}`,
        $options: "i",
      };
    }
    if (search) {
      const escapedSearch = escapeRegex(search);
      match.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { description: { $regex: escapedSearch, $options: "i" } },
      ];
    }
    if (hasSeating === true) {
      match.seatCount = { $gt: 0 };
    }
    if (hasSeating === false) {
      match.seatCount = 0;
    }

    const { areas, total } = await this.areaRepository.findAreasPage({
      match,
      sort,
      skip,
      limit,
    });
    return this.areaPresenter.toAreaPage(areas, page, limit, total);
  }

  private resolveSortBy(sortBy?: string): AreaSortField {
    return ALLOWED_AREA_SORT_FIELDS.includes(sortBy as AreaSortField)
      ? (sortBy as AreaSortField)
      : "createdAt";
  }
}

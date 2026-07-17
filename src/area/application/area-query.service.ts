import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { Area } from "@src/schemas/area.schema";
import { FilterQuery, Types } from "mongoose";
import { AreaSortField } from "../area.constants";
import type { AreaView } from "../domain/types/area.types";
import { QueryAreaDto } from "../dto/query.dto";
import { AreaCacheService } from "../infrastructure/cache/area-cache.service";
import { AreaRepository } from "../infrastructure/persistence/area.repository";
import { AreaPresenter } from "../presenters/area.presenter";

interface NormalizedAreaQuery {
  zoneId?: string;
  name?: string;
  search?: string;
  hasSeating?: boolean;
  isDeleted: boolean;
  page: number;
  limit: number;
  sortBy: AreaSortField;
  sortOrder: "asc" | "desc";
}

@Injectable()
export class AreaQueryService {
  constructor(
    private readonly areaRepository: AreaRepository,
    private readonly areaCacheService: AreaCacheService,
    private readonly areaPresenter: AreaPresenter
  ) {}

  async getAllAreas(query: QueryAreaDto): Promise<PaginatedResponse<AreaView>> {
    if (query.zoneId && !Types.ObjectId.isValid(query.zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }

    const normalizedQuery = this.normalizeQuery(query);

    return this.areaCacheService.getAreaList(
      normalizedQuery,
      normalizedQuery.sortBy,
      () => this.loadAreas(normalizedQuery)
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
        throw new NotFoundException("Area not found or has been deleted");
      }
      return this.areaPresenter.toAreaView(area);
    });
  }

  private async loadAreas(
    query: NormalizedAreaQuery
  ): Promise<PaginatedResponse<AreaView>> {
    const match = this.buildMatch(query);
    const direction: 1 | -1 = query.sortOrder === "asc" ? 1 : -1;
    const sort: Partial<Record<AreaSortField | "_id", 1 | -1>> = {
      [query.sortBy]: direction,
      _id: direction,
    };

    const { areas, total } = await this.areaRepository.findAreasPage({
      match,
      sort,
      skip: (query.page - 1) * query.limit,
      limit: query.limit,
    });
    return this.areaPresenter.toAreaPage(areas, query.page, query.limit, total);
  }

  private buildMatch(query: NormalizedAreaQuery): FilterQuery<Area> {
    const match: FilterQuery<Area> = { isDeleted: query.isDeleted };

    if (query.zoneId) {
      match.zoneId = new Types.ObjectId(query.zoneId);
    }
    if (query.name) {
      match.name = {
        $regex: `^${escapeRegex(query.name)}`,
        $options: "i",
      };
    }
    if (query.search) {
      const escapedSearch = escapeRegex(query.search);
      match.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { description: { $regex: escapedSearch, $options: "i" } },
      ];
    }
    if (query.hasSeating === true) {
      match.seatCount = { $gt: 0 };
    }
    if (query.hasSeating === false) {
      match.seatCount = 0;
    }

    return match;
  }

  private normalizeQuery(query: QueryAreaDto): NormalizedAreaQuery {
    const name = query.name?.trim().toUpperCase() || undefined;
    const search = query.search?.trim() || undefined;

    return {
      zoneId: query.zoneId,
      name,
      search,
      hasSeating: query.hasSeating,
      isDeleted: false,
      page: query.page ?? 1,
      limit: query.limit ?? 10,
      sortBy: query.sortBy ?? "createdAt",
      sortOrder: query.sortOrder ?? "desc",
    };
  }
}

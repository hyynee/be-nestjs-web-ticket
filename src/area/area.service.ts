import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { AreaCommandService } from "./application/area-command.service";
import { AreaQueryService } from "./application/area-query.service";
import type { AreaView } from "./domain/types/area.types";
import { CreateAreaDTO } from "./dto/create.dto";
import { QueryAreaDto } from "./dto/query.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "./dto/update.dto";

export type { AreaView } from "./domain/types/area.types";

@Injectable()
export class AreaService {
  constructor(
    private readonly areaCommandService: AreaCommandService,
    private readonly areaQueryService: AreaQueryService
  ) {}

  createArea(
    currentUser: JwtPayload,
    createAreaDto: CreateAreaDTO
  ): Promise<AreaView> {
    return this.areaCommandService.createArea(currentUser, createAreaDto);
  }

  getAllAreas(query: QueryAreaDto): Promise<PaginatedResponse<AreaView>> {
    return this.areaQueryService.getAllAreas(query);
  }

  softDeleteArea(
    currentUser: JwtPayload,
    id: string,
    dto: SoftDeleteAreaDTO
  ): Promise<AreaView> {
    return this.areaCommandService.softDeleteArea(currentUser, id, dto);
  }

  updateArea(
    currentUser: JwtPayload,
    id: string,
    dto: UpdateAreaDTO
  ): Promise<AreaView> {
    return this.areaCommandService.updateArea(currentUser, id, dto);
  }

  getAreaById(id: string): Promise<AreaView> {
    return this.areaQueryService.getAreaById(id);
  }
}

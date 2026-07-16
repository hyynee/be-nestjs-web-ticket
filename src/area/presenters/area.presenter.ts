import { BadRequestException, Injectable } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import type { AreaView, AreaViewSource } from "../domain/types/area.types";

@Injectable()
export class AreaPresenter {
  getAreaSeatCount(area: { seatCount?: number; seats?: string[] }): number {
    if (area.seats && area.seats.length > 0) {
      return area.seats.length;
    }
    return area.seatCount ?? 0;
  }

  toAreaView(area: AreaViewSource): AreaView {
    const id = area._id?.toString() ?? area.id;
    if (!id) {
      throw new BadRequestException("Area ID is missing");
    }

    return {
      id,
      eventId: area.eventId.toString(),
      zoneId: area.zoneId.toString(),
      name: area.name,
      description: area.description,
      rowLabel: area.rowLabel,
      seatCount: this.getAreaSeatCount(area),
      seats: area.seats ?? [],
      createdAt: area.createdAt,
      updatedAt: area.updatedAt,
    };
  }

  toAreaPage(
    areas: AreaViewSource[],
    page: number,
    limit: number,
    total: number
  ): PaginatedResponse<AreaView> {
    const totalPages = Math.ceil(total / limit);
    return {
      items: areas.map((area) => this.toAreaView(area)),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }
}

import {
  PaginatedResponse,
  PaginationMetaFormatter,
} from "@src/common/interfaces/pagination-response";

export function buildPaginationMeta(
  page: number,
  limit: number,
  totalItems: number
): PaginationMetaFormatter {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  return {
    currentPage: page,
    itemsPerPage: limit,
    totalItems,
    totalPages,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages,
  };
}

export function toPaginatedResponse<T>(
  items: T[],
  page: number,
  limit: number,
  totalItems: number
): PaginatedResponse<T> {
  return { items, meta: buildPaginationMeta(page, limit, totalItems) };
}

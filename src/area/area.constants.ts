export const AREA_RESPONSE_SCHEMA_VERSION = "v1";
export const AREA_CACHE_TTL_SEC = 30;

export const ALLOWED_AREA_SORT_FIELDS = [
  "createdAt",
  "name",
  "seatCount",
  "updatedAt",
] as const;

export type AreaSortField = (typeof ALLOWED_AREA_SORT_FIELDS)[number];

interface PasswordSelectableQuery {
  select(fields: string): unknown;
}

interface ObjectSerializableDocument {
  toObject(): Record<string, unknown>;
}

export function hasSelect(value: unknown): value is PasswordSelectableQuery {
  if (!value || typeof value !== "object" || !("select" in value)) {
    return false;
  }

  return typeof value.select === "function";
}

export function withPassword<TQuery>(query: TQuery): TQuery {
  return hasSelect(query) ? (query.select("+password") as TQuery) : query;
}

export function hasToObject(
  value: unknown
): value is ObjectSerializableDocument {
  if (!value || typeof value !== "object" || !("toObject" in value)) {
    return false;
  }

  return typeof value.toObject === "function";
}

export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  return code === 11000 || code === 11001;
}

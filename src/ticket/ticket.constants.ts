export const TICKET_RESPONSE_SCHEMA_VERSION = "v1";
export const TICKET_CACHE_TTL_SEC = 30;
export const TICKET_LIST_INDEX = `tickets:list:index:${TICKET_RESPONSE_SCHEMA_VERSION}`;

export const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

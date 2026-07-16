export const HOT_EVENTS_CACHE_KEY = "stat:v1:hot-events";

export const WEBHOOK_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export const CHECKOUT_DEDUP_SCRIPT = `
  local existing = redis.call('GET', KEYS[1])
  if existing then return {'existing', existing} end
  local acquired = redis.call('SET', KEYS[2], '1', 'NX', 'EX', 60)
  if acquired then return {'locked', ''} end
  existing = redis.call('GET', KEYS[1])
  if existing then return {'existing', existing} end
  return {'conflict', ''}
`;

export const STRIPE_MIN_EXPIRES_IN_MS = 31 * 60 * 1000;
export const PAYPAL_TIMEOUT_MS = 15_000;
export const PAYMENT_PROCESSING_TTL_SEC = 120;
export const PAYMENT_SUCCEEDED_TTL_SEC = 24 * 60 * 60;

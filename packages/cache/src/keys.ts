// Key grammar and TTL validation shared by the strategies and the @Cache decorator.
// See docs/REDIS-SCHEMA.md: `<service>::<tenant>::<category>::<entityId>::<params>`.

/** Index key prefix. Distinct from any `service` so `parse` can never confuse the two. */
export const INDEX_PREFIX = "entityIndex";

export const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
export const KEY_DELIMITER = "::";
export const MIN_TTL_SECONDS = 1;
export const MAX_TTL_SECONDS = 2_592_000; // 30 days

export function assertSegment(name: string, value: string): void {
  if (typeof value !== "string" || !SEGMENT_RE.test(value)) {
    throw new Error(`invalid ${name} segment: ${JSON.stringify(value)}`);
  }
}

export function assertValidTtl(ttlSeconds: number): void {
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new RangeError(
      `ttlSeconds must be a whole number in ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}, got ${String(ttlSeconds)}`,
    );
  }
}

/** Split `items` into consecutive slices of at most `size`. Empty input yields nothing. */
export function* chunk<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

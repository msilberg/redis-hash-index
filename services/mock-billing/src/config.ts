export interface Config {
  port: number;
  /** Must match benchmark's — its seeder checks `GET /health` before any lazy fill. */
  seedValue: number;
  originLatencyMs: number;
  originFailUser: string | undefined;
}

function intFromEnv(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (want integer in ${min}..${max})`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // 0 = any free port (tests spawn this service and read the port from its log line).
    port: intFromEnv(env.PORT, 3003, "PORT", 0, 65535),
    seedValue: intFromEnv(env.SEED_VALUE, 1, "SEED_VALUE", 0, 0xffff_ffff),
    originLatencyMs: intFromEnv(env.ORIGIN_LATENCY_MS, 0, "ORIGIN_LATENCY_MS", 0, 60_000),
    originFailUser: env.ORIGIN_FAIL_USER === undefined || env.ORIGIN_FAIL_USER === "" ? undefined : env.ORIGIN_FAIL_USER,
  };
}

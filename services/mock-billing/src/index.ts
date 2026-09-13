import type { AddressInfo } from "node:net";

import { createApp } from "./app";
import { loadConfig } from "./config";
import { BillingProvider } from "./provider";

const config = loadConfig();

const provider = new BillingProvider({
  seedValue: config.seedValue,
  latencyMs: config.originLatencyMs,
  failUser: config.originFailUser,
});

const server = createApp(provider).listen(config.port, () => {
  // test-api's chain test parses the port from this line when it spawns the service with PORT=0.
  const { port } = server.address() as AddressInfo;
  console.log(`[mock-billing] listening on :${port} (seedValue=${config.seedValue})`);
});

function shutdown(signal: string): void {
  console.log(`[mock-billing] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

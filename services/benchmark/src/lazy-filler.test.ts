// TestApiFiller against local HTTP stand-ins for test-api and mock-billing. Pure: no database.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { OriginFailedError, TestApiFiller } from "./lazy-filler";

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end();
let server: Server;
let filler: TestApiFiller;

before(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // One stand-in serves both roles: `/subscription` is test-api, `/health` is mock-billing.
  filler = new TestApiFiller({ testApiBaseUrl: base, mockBillingBaseUrl: base, timeoutMs: 2000 });
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const json = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

test("fill requests GET /subscription/:userId?v=n from test-api", async () => {
  let requested = "";
  handler = (req, res) => {
    requested = req.url ?? "";
    json(200, { userId: "u_0000004", source: "origin", subscription: { userId: "u_0000004" } })(req, res);
  };
  await filler.fill("u_0000004", 3);
  assert.equal(requested, "/subscription/u_0000004?v=3");
});

test("a 502 is an OriginFailedError (skippable); any other failure is a plain Error (fatal)", async () => {
  handler = json(502, { error: "billing GET /subscription/u_0000002 -> 503" });
  await assert.rejects(filler.fill("u_0000002", 1), (err: unknown) => {
    assert.ok(err instanceof OriginFailedError);
    assert.match(err.message, /-> 503/);
    return true;
  });

  handler = json(500, { error: "boom" });
  await assert.rejects(filler.fill("u_0000002", 1), (err: unknown) => !(err instanceof OriginFailedError) && /500: boom/.test(String(err)));

  // A null subscription for a record the generator says exists: the origin disagrees — fatal.
  handler = json(200, { subscription: null });
  await assert.rejects(filler.fill("u_0000002", 1), (err: unknown) => !(err instanceof OriginFailedError) && /no subscription/.test(String(err)));
});

test("originSeedValue reads mock-billing's /health", async () => {
  handler = json(200, { ok: true, seedValue: 42 });
  assert.equal(await filler.originSeedValue(), 42);
  handler = json(200, { ok: true });
  await assert.rejects(filler.originSeedValue(), /no integer seedValue/);
  handler = json(503, {});
  await assert.rejects(filler.originSeedValue(), /-> 503/);
});

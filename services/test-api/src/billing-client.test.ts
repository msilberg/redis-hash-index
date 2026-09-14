// The S2S client against a local HTTP stand-in for mock-billing. Pure: no database. Every failure mode
// of a remote origin must come out as an OriginError, and only a 404 as `null`.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { BillingClient, OriginError, toSubscription } from "./billing-client";

const USER = "u_0000004";
const ENVELOPE = {
  subscription: {
    id: `sub_${USER}_2`,
    customer_id: `cus_${USER}`,
    plan_id: "team-monthly",
    status: "active",
    current_term_end: Date.parse("2026-11-07T00:00:00Z") / 1000,
    seats: 4,
    object: "subscription",
  },
  customer: { id: `cus_${USER}`, object: "customer" },
};

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end();
let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = (timeoutMs = 2000): BillingClient => new BillingClient({ baseUrl, timeoutMs });
const json = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

test("maps the envelope to the internal Subscription, in the shared serializer's key order", async () => {
  let requested = "";
  handler = (req, res) => {
    requested = req.url ?? "";
    json(200, ENVELOPE)(req, res);
  };
  const subscription = await client().getActiveSubscription(USER, { v: 2 });
  assert.equal(requested, `/subscription/${USER}?v=2`);
  assert.equal(
    JSON.stringify(subscription),
    `{"userId":"${USER}","planId":"team-monthly","status":"active","renewsAt":"2026-11-07","seats":4}`,
  );
});

test("a 404 is an authoritative 'no such subscription': null, not an error", async () => {
  handler = json(404, { error: "no subscription" });
  assert.equal(await client().getActiveSubscription(USER, { v: 3 }), null);
});

test("every other non-2xx is an OriginError", async () => {
  for (const status of [400, 500, 502, 503]) {
    handler = json(status, { error: `status ${status}` });
    await assert.rejects(client().getActiveSubscription(USER), (err: unknown) => {
      assert.ok(err instanceof OriginError, `status ${status}`);
      assert.match(err.message, new RegExp(`-> ${status}`));
      return true;
    });
  }
});

test("a timeout — headers or body — is an OriginError", async () => {
  handler = () => {
    /* never answer */
  };
  await assert.rejects(client(100).getActiveSubscription(USER), /timed out after 100 ms/);

  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"subscription":'); // ...and stall mid-body
  };
  await assert.rejects(client(100).getActiveSubscription(USER), OriginError);
});

test("an unparseable body or an unexpected envelope is an OriginError", async () => {
  handler = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("<html>");
  await assert.rejects(client().getActiveSubscription(USER), OriginError);

  handler = json(200, { subscription: { ...ENVELOPE.subscription, customer_id: "cus_u_0000009" } });
  await assert.rejects(client().getActiveSubscription(USER), /unexpected envelope/);

  assert.throws(() => toSubscription({ subscription: { ...ENVELOPE.subscription, current_term_end: "soon" } }, USER), OriginError);
  assert.throws(() => toSubscription(null, USER), OriginError);
});

test("a refused connection is an OriginError", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));

  const refused = new BillingClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
  await assert.rejects(refused.getActiveSubscription(USER), (err: unknown) => {
    assert.ok(err instanceof OriginError);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

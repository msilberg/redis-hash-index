// The WebSocket hub. For US-005 it carries `{t:'seed-progress'}` frames; the run driver (US-006)
// and UI (US-007) add `sample` / `history` / lifecycle frames through the same broadcast path.

import type { Server } from "node:http";

import { WebSocketServer, WebSocket } from "ws";

import type { Seeder } from "./seeder";

export interface Hub {
  wss: WebSocketServer;
  /** Send a JSON frame to every open client. */
  broadcast(frame: unknown): void;
  close(): Promise<void>;
}

export function attachWebSocket(server: Server, seeder: Seeder): Hub {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  const broadcast = (frame: unknown): void => {
    const data = JSON.stringify(frame);
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  };

  wss.on("connection", (socket: WebSocket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    // Paint the current seed state immediately so a freshly opened page is not blank.
    socket.send(JSON.stringify(seeder.progressFrame()));
  });

  const onProgress = (frame: unknown): void => broadcast(frame);
  seeder.on("progress", onProgress);

  return {
    wss,
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        seeder.off("progress", onProgress);
        for (const socket of clients) socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

// Webhook server for receiving UniswapX order notifications
// Lower latency than polling — Uniswap pushes orders directly
// Register at Uniswap's filler onboarding to receive webhooks from 3.14.56.90

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { UniswapXApiOrder } from "./types";

export type OrderHandler = (orders: UniswapXApiOrder[]) => Promise<void>;

/**
 * Start an HTTP server that receives order notifications from UniswapX.
 * Runs alongside the polling loop as a complementary order source.
 */
export function startWebhookServer(
  port: number,
  handler: OrderHandler,
  allowedIps: string[] = ["3.14.56.90"],
): void {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Only accept POST
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      // IP allowlist (skip if empty)
      if (allowedIps.length > 0) {
        const remoteIp = req.socket.remoteAddress ?? "";
        const allowed = allowedIps.some((ip) => remoteIp.includes(ip));
        if (!allowed) {
          res.writeHead(403);
          res.end();
          return;
        }
      }

      // Parse body (cap at 1MB to prevent memory abuse)
      const MAX_BODY = 1024 * 1024;
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) {
          res.writeHead(413);
          res.end("payload too large");
          return;
        }
      }

      try {
        const payload = JSON.parse(body);
        const orders: UniswapXApiOrder[] = Array.isArray(payload)
          ? payload
          : [payload];

        // Fire-and-forget to handler (don't block HTTP response)
        handler(orders).catch((err) =>
          console.error("[webhook] handler error:", err),
        );

        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad request");
      }
    },
  );

  server.listen(port, () => {
    console.log(`Webhook server listening on port ${port}`);
  });
}

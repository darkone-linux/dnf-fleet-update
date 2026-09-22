// Real `ToolServer`: the MCP endpoint of one run.
//
// Loopback, ephemeral port, bearer token — all three new at every start. The
// body is passed through untouched: meaning belongs to `ai/rpc.ts`.

import { randomBytes } from "node:crypto";
import type { ToolEndpoint, ToolServer } from "../engine/ports.ts";

/** Path both executables are pointed at. */
const PATH = "/mcp";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export class LoopbackToolServer implements ToolServer {
  private server?: ReturnType<typeof Bun.serve>;

  async start(handle: (message: unknown) => Promise<unknown | undefined>): Promise<ToolEndpoint> {
    await this.stop();
    const token = randomBytes(24).toString("hex");
    const expected = `Bearer ${token}`;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== PATH) return new Response("not found", { status: 404 });

        // Loopback is not a permission: a local process of another user would
        // reach the port all the same.
        if (request.headers.get("authorization") !== expected) {
          return new Response("unauthorized", { status: 401 });
        }

        // No server-sent stream: one request, one reply (spec § Transport).
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

        let message: unknown;
        try {
          message = await request.json();
        } catch {
          return json(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } },
            400,
          );
        }
        const reply = await handle(message);

        // A notification is answered by an acknowledgement without a body.
        return reply === undefined ? new Response(null, { status: 202 }) : json(reply);
      },
    });
    this.server = server;
    return { url: `http://127.0.0.1:${server.port}${PATH}`, token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }
}

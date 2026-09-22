// The endpoint on the real loopback: the token gates it, the body passes through.

import { afterEach, describe, expect, test } from "bun:test";
import { LoopbackToolServer } from "./mcp.ts";

const server = new LoopbackToolServer();

afterEach(() => server.stop());

/** Echoes what it received, except a message without an `id`: a notification. */
const echo = (message: unknown) =>
  Promise.resolve(
    typeof message === "object" && message !== null && "id" in message
      ? { seen: message }
      : undefined,
  );

const post = (url: string, token: string | undefined, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

describe("LoopbackToolServer", () => {
  test("listens on the loopback and carries a message both ways", async () => {
    const { url, token } = await server.start(echo);
    expect(url).toStartWith("http://127.0.0.1:");
    expect(token).toHaveLength(48);

    const response = await post(url, token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seen: { jsonrpc: "2.0", id: 1, method: "ping" } });
  });

  test("a notification is acknowledged without a body", async () => {
    const { url, token } = await server.start(echo);
    const response = await post(url, token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("no token, or the wrong one, gets nothing", async () => {
    const { url, token } = await server.start(echo);

    expect((await post(url, undefined, { id: 1 })).status).toBe(401);
    expect((await post(url, `${token}x`, { id: 1 })).status).toBe(401);
  });

  test("only POST on the endpoint path", async () => {
    const { url, token } = await server.start(echo);
    const headers = { authorization: `Bearer ${token}` };

    expect((await fetch(url, { headers })).status).toBe(405);
    expect((await fetch(url.replace("/mcp", "/other"), { headers })).status).toBe(404);
  });

  test("a body that is not JSON is a parse error, not a crash", async () => {
    const { url, token } = await server.start(echo);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  test("a new start replaces the token: nothing of a past run still opens it", async () => {
    const first = await server.start(echo);
    const second = await server.start(echo);

    expect(second.token).not.toBe(first.token);
    expect((await post(second.url, first.token, { id: 1 })).status).toBe(401);
  });
});

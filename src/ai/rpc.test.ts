// The MCP dispatch, without a socket: every method, and every way to get it wrong.

import { describe, expect, test } from "bun:test";
import type { EventInput } from "../engine/context.ts";
import { initialPersisted, type PersistedState, persist } from "../model/persist.ts";
import { fakeRunContext } from "../testing/fakes.ts";
import { toolContext } from "./context.ts";
import { dispatch, type RpcServer } from "./rpc.ts";
import { toolsFor } from "./tools/registry.ts";
import type { ToolLevel } from "./tools/types.ts";

const EVENTS: EventInput[] = [
  { kind: "host.add", host: "gfx", profile: "laptop", zone: "ag" },
  { kind: "host.state", host: "gfx", state: "failed", note: "activation failed" },
];

function server(level: ToolLevel = "active"): RpcServer {
  const context = fakeRunContext({ sources: { "/ws/flake.nix": ["{ }"] } });
  const folded = EVENTS.reduce<PersistedState>(
    (state, event, index) => persist(state, { ...event, t: index }),
    initialPersisted(),
  );
  return {
    tools: toolsFor(level),
    context: toolContext(context, () => folded),
    version: "0.7.0",
  };
}

const call = (method: string, params?: unknown, id: number | string = 1) =>
  dispatch({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, server());

/** `result` of a successful response; throws when the response carries an error. */
function resultOf(response: Awaited<ReturnType<typeof dispatch>>): Record<string, unknown> {
  if (response === undefined || !("result" in response)) {
    throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  }
  return response.result as Record<string, unknown>;
}

/** Text of a `tools/call` result, and whether the tool refused. */
function textOf(response: Awaited<ReturnType<typeof dispatch>>) {
  const result = resultOf(response) as {
    content: { text: string }[];
    isError: boolean;
  };
  return { text: result.content[0]?.text ?? "", isError: result.isError };
}

describe("initialize", () => {
  test("echoes a protocol version it knows, and names itself", async () => {
    const result = resultOf(await call("initialize", { protocolVersion: "2024-11-05" }));

    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo).toEqual({ name: "fleet-update", version: "0.7.0" });
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  test("falls back to its own version for one it does not know", async () => {
    const result = resultOf(await call("initialize", { protocolVersion: "1999-01-01" }));
    expect(result.protocolVersion).toBe("2025-06-18");
  });
});

describe("tools/list", () => {
  test("publishes the tools of the level, with their schema", async () => {
    const result = resultOf(await call("tools/list")) as {
      tools: { name: string; description: string; inputSchema: { type: string } }[];
    };

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "deployment_state",
      "host_diagnosis",
      "host_log",
      "run_log",
      "read_code",
      "search_code",
      "list_code",
      "host_units",
      "host_journal",
    ]);
    expect(result.tools[0]?.inputSchema.type).toBe("object");
  });

  test("a passive level hides the active tools", async () => {
    const response = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      server("passive"),
    );
    const result = resultOf(response) as { tools: { name: string }[] };

    expect(result.tools.map((tool) => tool.name)).not.toContain("read_code");
  });
});

describe("tools/call", () => {
  test("runs the tool and returns its text", async () => {
    const { text, isError } = textOf(
      await call("tools/call", { name: "deployment_state", arguments: {} }),
    );

    expect(isError).toBe(false);
    expect(text).toContain("gfx | laptop | ag | failed");
  });

  test("a refusal comes back as a result the model can read, not a protocol error", async () => {
    const { text, isError } = textOf(
      await call("tools/call", { name: "host_diagnosis", arguments: { host: "nope" } }),
    );

    expect(isError).toBe(true);
    expect(text).toBe("unknown host: nope");
  });

  test("invalid arguments are refused by the schema, named in the text", async () => {
    const { text, isError } = textOf(
      await call("tools/call", { name: "host_log", arguments: { host: "gfx", phase: "shell" } }),
    );

    expect(isError).toBe(true);
    expect(text).toContain("host_log");
  });

  test("a tool outside the level is a protocol error, not a result", async () => {
    const response = await dispatch(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_code" } },
      server("passive"),
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "no tool named read_code at this level" },
    });
  });

  test("the count of cut lines heads the text", async () => {
    const running = server();
    const context = fakeRunContext();
    for (let line = 1; line <= 5; line += 1) {
      context.run.appendLog({ phase: "update" }, `line ${line}`);
    }
    const { text } = textOf(
      await dispatch(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "run_log", arguments: { phase: "update", lines: 2 } },
        },
        { ...running, context: toolContext(context, () => initialPersisted()) },
      ),
    );

    expect(text).toBe("[3 earlier lines cut]\nline 4\nline 5");
  });
});

describe("protocol", () => {
  test("a notification gets no answer", async () => {
    const response = await dispatch(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      server(),
    );
    expect(response).toBeUndefined();
  });

  test("ping answers empty", async () => {
    expect(resultOf(await call("ping"))).toEqual({});
  });

  test("an unknown method is refused, an unknown notification dropped", async () => {
    expect(await call("resources/list")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "unknown method: resources/list" },
    });
    expect(await dispatch({ jsonrpc: "2.0", method: "resources/list" }, server())).toBeUndefined();
  });

  test("anything that is not a JSON-RPC request is refused", async () => {
    expect(await dispatch({ hello: true }, server())).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "not a JSON-RPC 2.0 request" },
    });
    expect(await dispatch([{ jsonrpc: "2.0", id: 1, method: "ping" }], server())).toMatchObject({
      error: { code: -32600 },
    });
  });
});

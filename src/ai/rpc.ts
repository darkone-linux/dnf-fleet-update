// MCP over JSON-RPC 2.0: the four methods the two executables use.
//
// Pure — a request in, a response out — so every case is tested without a
// socket; `adapters/mcp.ts` is only the shell that carries it.

import { z } from "zod";
import { MCP_SERVER } from "./tools/registry.ts";
import { type RegisteredTool, type ToolContext, ToolError } from "./tools/types.ts";

/** Newest first: the client's version is echoed when we know it. */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** JSON-RPC codes, as the specification names them. */
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type RpcId = string | number | null;

export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string } };

const request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const callParams = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

const initializeParams = z.object({ protocolVersion: z.string().optional() }).loose();

export interface RpcServer {
  /** Tools published to this run, already filtered by level. */
  tools: readonly RegisteredTool[];
  context: ToolContext;

  /** `package.json` version, reported as the server's. */
  version: string;
}

const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

const error = (id: RpcId, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** One text block: a tool answers in lines, the model reads a document. */
function content(lines: readonly string[], dropped: number | undefined, isError = false) {
  const header = dropped === undefined || dropped === 0 ? [] : [`[${dropped} earlier lines cut]`];
  return { content: [{ type: "text", text: [...header, ...lines].join("\n") }], isError };
}

async function callTool(id: RpcId, params: unknown, server: RpcServer): Promise<RpcResponse> {
  const parsed = callParams.safeParse(params);
  if (!parsed.success) return error(id, INVALID_PARAMS, "tools/call needs a tool name");

  const tool = server.tools.find((candidate) => candidate.name === parsed.data.name);
  if (tool === undefined) {
    return error(id, INVALID_PARAMS, `no tool named ${parsed.data.name} at this level`);
  }
  try {
    const result = await tool.call(server.context, parsed.data.arguments);
    return ok(id, content(result.lines, result.dropped));
  } catch (thrown) {
    // A refusal is the tool's answer, not a protocol failure: the model reads
    // it and may correct itself. Anything else is ours, and says so.
    const refusal = thrown instanceof ToolError;
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return ok(id, content([refusal ? message : `tool failed: ${message}`], undefined, true));
  }
}

/**
 * Applies one message. `undefined` for a notification: JSON-RPC forbids a
 * response to one, and `notifications/initialized` is the only one we get.
 */
export async function dispatch(raw: unknown, server: RpcServer): Promise<RpcResponse | undefined> {
  const parsed = request.safeParse(raw);
  if (!parsed.success) return error(null, INVALID_REQUEST, "not a JSON-RPC 2.0 request");

  const { method, params } = parsed.data;
  const id = parsed.data.id ?? null;
  const notification = parsed.data.id === undefined;

  switch (method) {
    case "initialize": {
      const asked = initializeParams.safeParse(params ?? {});
      const wanted = asked.success ? asked.data.protocolVersion : undefined;
      const version =
        wanted !== undefined && PROTOCOLS.includes(wanted as (typeof PROTOCOLS)[number])
          ? wanted
          : PROTOCOLS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER, version: server.version },
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: server.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.schema,
        })),
      });

    case "tools/call":
      return callTool(id, params, server);

    default:
      // A notification we do not know is dropped: answering one is a protocol error.
      return notification ? undefined : error(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

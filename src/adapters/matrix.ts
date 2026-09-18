// Matrix client API (spec § Rapport): one message, one idempotent PUT.

import type { MatrixMessage, MatrixSender } from "../engine/ports.ts";
import { fail, ok, type Result } from "../model/result.ts";

// The public Matrix vhost runs Caddy's bad-bots filter, which 403s a curl-like
// or empty agent, as `just configure-alert-bot` already works around.
const USER_AGENT = "DNF-FleetUpdate";

export class MatrixClient implements MatrixSender {
  async send(message: MatrixMessage, signal?: AbortSignal): Promise<Result<void>> {
    const { homeserver, room, token, text, timeoutMs } = message;
    const path = `_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message`;

    // Transaction id: a retried PUT would not post the message twice.
    const url = `${homeserver}/${path}/${crypto.randomUUID()}`;
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(url, {
        method: "PUT",
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ msgtype: "m.text", body: text }),
      });
      if (!response.ok) return fail(`${response.status} ${response.statusText}`);
      return ok(undefined);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}

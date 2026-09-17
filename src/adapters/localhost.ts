// Real `LocalHost`: `node:os`.

import { hostname, networkInterfaces } from "node:os";
import type { LocalHost } from "../engine/ports.ts";

export class SystemHost implements LocalHost {
  hostname(): string {
    return hostname().split(".")[0] ?? "";
  }

  addresses(): string[] {
    return Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => address.address);
  }
}

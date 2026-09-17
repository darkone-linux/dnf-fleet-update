// Local host read from this machine: shape only, values differ everywhere.

import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { SystemHost } from "./localhost.ts";

describe("SystemHost", () => {
  const local = new SystemHost();

  test("short host name", () => {
    expect(local.hostname()).not.toContain(".");
    expect(hostname().startsWith(local.hostname())).toBe(true);
  });

  test("IPv4 addresses only, loopback excluded", () => {
    for (const address of local.addresses()) {
      expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(address.startsWith("127.")).toBe(false);
    }
  });
});

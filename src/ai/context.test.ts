// Pure parts of the tool facade: the form a repair commit must take.

import { describe, expect, test } from "bun:test";
import { commitMessage } from "./context.ts";

describe("commitMessage", () => {
  test("the host is the scope: an AI repair is obvious in git log", () => {
    expect(commitMessage("gw-cp", "bind nginx after the acme unit")).toBe(
      "fix(gw-cp): bind nginx after the acme unit",
    );
  });

  test("one line, whatever the model wrote", () => {
    expect(commitMessage("gfx", "  restart\n  outline  ")).toBe("fix(gfx): restart outline");
  });

  test("cut at the 80 the commit gate allows", () => {
    const message = commitMessage("gfx", "x".repeat(200));
    expect(message).toHaveLength(80);
    expect(message).toStartWith("fix(gfx): xxx");
  });

  test("an empty subject is refused, not padded", () => {
    expect(() => commitMessage("gfx", "   ")).toThrow("an empty subject");
  });
});

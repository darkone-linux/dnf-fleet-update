// Pure parts of the tool facade: the form a repair commit must take.

import { describe, expect, test } from "bun:test";
import { commitMessage, namedHost } from "./context.ts";

describe("commitMessage", () => {
  test("the scope names what the fix touches, as a human writes it", () => {
    expect(commitMessage("music", "drop mpdris2, clashes with mpd-mpris")).toBe(
      "fix(music): drop mpdris2, clashes with mpd-mpris",
    );
  });

  test("one line, whatever the model wrote", () => {
    expect(commitMessage("outline", "  restart\n  after  postgresql ")).toBe(
      "fix(outline): restart after postgresql",
    );
  });

  test("cut at the 80 the commit gate allows", () => {
    const message = commitMessage("music", "x".repeat(200));
    expect(message).toHaveLength(80);
    expect(message).toStartWith("fix(music): xxx");
  });

  test("an empty subject is refused, not padded", () => {
    expect(() => commitMessage("music", "   ")).toThrow("an empty subject");
  });
});

describe("namedHost", () => {
  const hosts = ["gfx", "gw-ag", "alt"];

  test("a host named as a whole word, in the scope or the subject", () => {
    expect(namedHost("fix(gfx): drop mpdris2", hosts)).toBe("gfx");
    expect(namedHost("fix(music): drop mpdris2 on GW-AG", hosts)).toBe("gw-ag");
  });

  test("a host name inside another word is not a mention", () => {
    expect(namedHost("fix(music): alternate bridge, gw-agent", hosts)).toBeUndefined();
  });
});

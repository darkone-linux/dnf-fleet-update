import { describe, expect, test } from "bun:test";
import type { Event } from "../model/events.ts";
import { LiveChannel } from "./channel.ts";

describe("LiveChannel", () => {
  test("events reach the subscriber in order", () => {
    const channel = new LiveChannel();
    const seen: Event[] = [];
    channel.subscribe((event) => seen.push(event));

    channel.emit({ t: 1, kind: "log", level: "info", message: "a" });
    channel.emit({ t: 2, kind: "log", level: "info", message: "b" });

    expect(seen.map((event) => event.t)).toEqual([1, 2]);
  });

  test("respond answers the pending question, then nothing is pending", async () => {
    const channel = new LiveChannel();
    const answer = channel.answer("build");

    channel.respond("yes");
    channel.respond("no");

    expect(await answer).toBe("yes");
    const next = channel.answer("switch");
    channel.respond("no");
    expect(await next).toBe("no");
  });

  test("an abort rejects the pending question and frees the channel", async () => {
    const channel = new LiveChannel();
    const controller = new AbortController();
    const answer = channel.answer("build", controller.signal);

    controller.abort(new Error("run aborted"));

    await expect(answer).rejects.toThrow("run aborted");
    await expect(channel.answer("switch", AbortSignal.abort(new Error("gone")))).rejects.toThrow(
      "gone",
    );
  });

  test("a second question while one is pending is a bug", async () => {
    const channel = new LiveChannel();
    void channel.answer("build");

    await expect(channel.answer("switch")).rejects.toThrow("switch asked while build is pending");
  });
});

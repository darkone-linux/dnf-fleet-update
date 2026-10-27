// One repair session at a time: the turn a commit needs.

import { expect, test } from "bun:test";
import { serial } from "./pool.ts";

test("serial: one task at a time, in call order, a rejection blocking nothing", async () => {
  const turn = serial();
  const seen: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = turn(async () => {
    seen.push("first starts");
    await held;
    seen.push("first ends");
    throw new Error("first fails");
  });
  const second = turn(async () => {
    seen.push("second starts");
    return 2;
  });

  await Promise.resolve();
  expect(seen).toEqual(["first starts"]);

  release();
  await expect(first).rejects.toThrow("first fails");
  expect(await second).toBe(2);
  expect(seen).toEqual(["first starts", "first ends", "second starts"]);
});

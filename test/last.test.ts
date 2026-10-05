import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Blocks } from "../src/blocks.ts";
import { race, type Plan } from "../src/last.ts";

/**
 * Past polls of one-second blocks, each sealed at its timestamp and built in eight sub-blocks, the last 200 ms before
 * the seal: a vote is sent 500 ms before a block's timestamp. No poll sees the block being built now.
 */
function chain() {
  const blocks = new Blocks();
  const now = Math.ceil(Date.now() / 1000) * 1000;
  for (let k = 10; k >= 1; k--) {
    const time = now - k * 1000;
    for (let i = 0; i <= 8; i++) {
      blocks.observe({ number: BigInt(100 - k), timestamp: BigInt(time / 1000), txs: i }, time - 1000 + i * 100);
    }
  }
  return { blocks, flip: now + 3000 };
}

type Sent = { time: number; at: number; plan: Plan | undefined };

/** Runs a race whose `n`th plan does as `behave` says. */
async function run(behave: (n: number) => "ok" | "hang" | "fail", first?: Plan) {
  const { blocks, flip } = chain();
  const sent: Sent[] = [];
  let n = 0;
  const plan = async (): Promise<Plan> => {
    const readAt = Date.now();
    const behaviour = behave(++n);
    if (behaviour === "hang") await new Promise(() => {});
    await sleep(20);
    if (behaviour === "fail") throw new Error("RPC timeout");
    return { readAt, time: 0, vote: null, note: `plan ${n}`, summary: {} };
  };
  const send = (plan: Plan | undefined, time: number) => void sent.push({ time, at: Date.now(), plan });
  const sends = await race(flip, { blocks, plan, send }, first);
  assert.equal(sends, 2);
  assert.deepEqual(
    sent.map((s) => s.time - flip),
    [-2000, -1000],
    "the last two blocks",
  );
  for (const s of sent) assert.ok(s.at >= s.time - 500 && s.at < s.time, `sent ${s.at - s.time} ms from the seal`);
  return sent;
}

test("each of the last two blocks gets the freshest plan at its deadline, whatever hangs or fails", async () => {
  const warmUp: Plan = { readAt: 0, time: 0, vote: null, note: "warm-up", summary: {} };
  const [healthy, oneHangs, allHangLater, allFail] = await Promise.all([
    run(() => "ok"),
    run((n) => (n === 3 ? "hang" : "ok")),
    run((n) => (n >= 5 ? "hang" : "ok"), warmUp),
    run(() => "fail", warmUp),
  ]);
  for (const s of [...healthy, ...oneHangs]) assert.ok(s.at - s.plan!.readAt < 250, "a fresh plan");
  assert.equal(allHangLater[0]!.plan!.note, "plan 4", "the last plan that came back");
  assert.equal(allHangLater[1]!.plan!.note, "plan 4");
  assert.deepEqual(
    allFail.map((s) => s.plan?.note),
    ["warm-up", "warm-up"],
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { WatchLeases, type WatchEvent } from "../src/adapters/bb/review-watch.ts";

function setup(fails = false) {
  let now = 0;
  const listeners = new Map<string, (event: WatchEvent) => void>();
  const disposed: string[] = [];
  let started = 0;
  const changed: string[] = [];
  const leases = new WatchLeases(async (root, listener) => {
    started++;
    if (fails) throw new Error("HOST_UNAVAILABLE");
    listeners.set(root, listener);
    return {dispose: async () => { disposed.push(root); }};
  }, root => changed.push(root), () => now, 1_000);
  return {leases, listeners, disposed, changed, started: () => started, tick: (ms: number) => { now += ms; }};
}

test("one watch per root, renewed by each call; its changes are reported, its errors are not", async () => {
  const {leases, listeners, changed, started} = setup();
  await leases.renew("/w/a");
  await leases.renew("/w/a");
  assert.equal(started(), 1);
  listeners.get("/w/a")!({kind: "changed"});
  listeners.get("/w/a")!({kind: "rescan-required"});
  listeners.get("/w/a")!({kind: "watch-error", message: "x"});
  assert.deepEqual(changed, ["/w/a", "/w/a"]);
});

test("a lease not renewed in time ends its watch", async () => {
  const {leases, disposed, tick} = setup();
  await leases.renew("/w/a");
  tick(600);
  await leases.renew("/w/b");
  tick(600);
  assert.deepEqual(leases.sweep(), ["/w/a"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([disposed, leases.watching()], [["/w/a"], ["/w/b"]]);
});

test("a watch that fails to start is tried again on the next renewal", async () => {
  const {leases, started} = setup(true);
  await assert.rejects(leases.renew("/w/a"), /HOST_UNAVAILABLE/);
  await assert.rejects(leases.renew("/w/a"), /HOST_UNAVAILABLE/);
  assert.equal(started(), 2);
});

test("stopping all ends every watch, leased or not", async () => {
  const {leases, disposed} = setup();
  await leases.renew("/w/a");
  await leases.renew("/w/b");
  assert.deepEqual(leases.stopAll().sort(), ["/w/a", "/w/b"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(disposed.sort(), ["/w/a", "/w/b"]);
});

import { describe, expect, it } from "vitest";
import { createAccountQueue } from "./account-queue.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createAccountQueue", () => {
  it("runs one account's tasks one at a time, in order", async () => {
    const queue = createAccountQueue();
    const order: string[] = [];
    const first = deferred();
    const a = queue.run("acc_1", async () => {
      order.push("a start");
      await first.promise;
      order.push("a end");
      return 1;
    });
    const b = queue.run("acc_1", async () => {
      order.push("b");
      return 2;
    });
    await tick();
    expect(order).toEqual(["a start"]);
    expect(queue.idle("acc_1")).toBe(false);
    first.resolve();
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe(2);
    expect(order).toEqual(["a start", "a end", "b"]);
    await tick();
    expect(queue.idle("acc_1")).toBe(true);
  });

  it("runs different accounts in parallel", async () => {
    const queue = createAccountQueue();
    const hold = deferred();
    const order: string[] = [];
    const a = queue.run("acc_1", async () => {
      await hold.promise;
      order.push("acc_1");
    });
    await queue.run("acc_2", async () => {
      order.push("acc_2");
    });
    expect(order).toEqual(["acc_2"]);
    hold.resolve();
    await a;
    expect(order).toEqual(["acc_2", "acc_1"]);
  });

  it("a rejection reaches its caller only and does not poison the chain", async () => {
    const queue = createAccountQueue();
    const failed = queue.run("acc_1", async () => {
      throw new Error("boom");
    });
    const next = queue.run("acc_1", async () => "still runs");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("still runs");
  });

  it("a synchronous throw inside the task is a rejection too", async () => {
    const queue = createAccountQueue();
    const failed = queue.run("acc_1", () => {
      throw new Error("sync");
    });
    await expect(failed).rejects.toThrow("sync");
    await expect(queue.run("acc_1", async () => 3)).resolves.toBe(3);
  });
});

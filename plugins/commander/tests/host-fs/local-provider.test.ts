import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createLocalProvider } from "../../src/adapters/bb/local-provider.ts";
import { createHostFs } from "../../src/adapters/bb/host-fs/index.ts";
import { CommanderError } from "../../src/core/errors.ts";
import { type Endpoint } from "../../src/core/model.ts";
import { parsePosix } from "../../src/core/path.ts";
import { HostFsContract } from "../../src/core/wire/host-fs.ts";

const endpoint: Endpoint = {
  id: "host:test", provider: "local", label: "Test host", machine: "Test",
  hostId: "test", readOnly: false, caseSensitive: true,
};
const signal = new AbortController().signal;

it("serializes bigint offsets without truncating and decodes a read chunk", async () => {
  const call = vi.fn().mockResolvedValue({ b64: "/w==" });
  const provider = createLocalProvider(endpoint, { call });
  const path = parsePosix("/fixture");
  expect(await provider.read(path, 5368709120n, 1, null, signal)).toEqual(Uint8Array.of(255));
  expect(call).toHaveBeenCalledWith("read", {
    path, offset: "5368709120", length: 1, expect: null,
  }, { hostId: "test", signal });
});

it("translates a structured host refusal to CommanderError", async () => {
  const provider = createLocalProvider(endpoint, {
    call: vi.fn().mockRejectedValue(new Error(
      '{"code":"changed_since_plan","message":"Target changed","retryable":false}',
    )),
  });
  const failure = provider.stat(parsePosix("/fixture"), signal);
  await expect(failure).rejects.toBeInstanceOf(CommanderError);
  await expect(failure).rejects.toMatchObject({ code: "changed_since_plan", retryable: false });
});

it("publishes the actual staging path and rejects commit after a target update", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "commander-provider-"));
  const host = createHostFs();
  const harness = experimental_createHostEntryHarness(experimental_defineHostEntry({
    contract: HostFsContract,
    handlers: host.rpcHandlers,
    dispose: host.dispose,
  }));
  const provider = createLocalProvider(endpoint, {
    call: (method, input, options) => harness.experimental_call(method, input, { signal: options.signal }),
  });
  const file = join(root, "target");
  const target = parsePosix(file);
  try {
    await writeFile(file, "old");
    const old = await provider.stat(target, signal);
    const session = await provider.openWrite(target, signal);
    await session.write(0n, Uint8Array.of(255), signal);
    const tempName = session.tempPath.segments.at(-1);
    expect(tempName).toEqual({ t: expect.stringMatching(/^\.target\.commander-.*\.part$/) });
    if (!tempName || !("t" in tempName)) throw new Error("Expected a text staging name");
    const temp = join(root, tempName.t);
    expect(session.tempPath).toEqual(parsePosix(temp));
    expect(await readFile(temp)).toEqual(Buffer.from([255]));
    await writeFile(file, "newer");
    await expect(session.commit({
      replace: true, expectTarget: { size: old!.size, mtimeNs: old!.mtimeNs },
    }, signal)).rejects.toMatchObject({ code: "changed_since_plan" });
    expect(await readFile(file, "utf8")).toBe("newer");
    await session.abort();
    await expect(readFile(temp)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await harness.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the SDK's 30-minute limit for copy, hash and commit only", async () => {
  const call = vi.fn().mockResolvedValue({
    session: "04782287-b8ae-4cb3-9d1a-fb6e9e501870", tempName: { t: ".stage" }, size: "0", mtimeNs: "0",
  });
  const provider = createLocalProvider(endpoint, { call });
  const path = parsePosix("/fixture");
  await provider.stat(path, signal);
  await provider.copyWithin(path, path, { replace: false }, signal);
  await provider.sha256(path, signal);
  const written = await provider.openWrite(path, signal);
  await written.commit({ replace: false, expectTarget: null }, signal);

  expect(call.mock.calls.map(([method, , opts]) => [method, opts.timeoutMs])).toEqual([
    ["stat", undefined], ["copyWithin", 1_800_000], ["sha256", 1_800_000],
    ["writeOpen", undefined], ["writeCommit", 1_800_000],
  ]);
});

it("classifies an unconfirmed mutation separately from a failed read and cancellation", async () => {
  const call = vi.fn(async (method: string) => {
    if (method === "writeOpen") return { session: "04782287-b8ae-4cb3-9d1a-fb6e9e501870", tempName: { t: ".stage" } };
    throw new Error("Host RPC timed out");
  });
  const provider = createLocalProvider(endpoint, { call: call as unknown as Parameters<typeof createLocalProvider>[1]["call"] });
  const path = parsePosix("/fixture");
  const stage = await provider.openWrite(path, signal);
  for (const mutate of [
    () => stage.commit({ replace: true, expectTarget: null }, signal),
    () => provider.rename(path, path, { replace: false }, signal),
    () => provider.remove(path, { kind: "file" }, signal),
    () => provider.copyWithin(path, path, { replace: false }, signal),
    () => provider.mkdir(path, signal),
  ]) {
    await expect(mutate()).rejects.toMatchObject({ code: "outcome_unknown", retryable: false });
  }
  await expect(provider.stat(path, signal)).rejects.toMatchObject({ code: "connection_failed" });

  const cancelled = new AbortController();
  call.mockImplementationOnce(async () => {
    cancelled.abort();
    throw new Error("Transport closed");
  });
  await expect(provider.remove(path, { kind: "file" }, cancelled.signal))
    .rejects.toMatchObject({ code: "cancelled" });
});

it("reports a non-atomic publication to the caller while returning a strict fingerprint", async () => {
  const onResult = vi.fn();
  const provider = createLocalProvider(endpoint, {
    call: vi.fn().mockResolvedValue({ size: "3", mtimeNs: "1", atomicNoReplace: false }),
  }, { onResult });
  const path = parsePosix("/fixture");
  expect(await provider.copyWithin(path, path, { replace: false }, signal)).toEqual({ size: "3", mtimeNs: "1" });
  expect(onResult).toHaveBeenCalledWith({ method: "copyWithin", target: path, atomicNoReplace: false });
});

it("validates and forwards conditional mutations through host RPC", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "commander-conditional-"));
  const host = createHostFs();
  const harness = experimental_createHostEntryHarness(experimental_defineHostEntry({
    contract: HostFsContract, handlers: host.rpcHandlers, dispose: host.dispose,
  }));
  const provider = createLocalProvider(endpoint, {
    call: (method, input, options) => harness.experimental_call(method, input, { signal: options.signal }),
  });
  const from = parsePosix(join(root, "source"));
  const to = parsePosix(join(root, "target"));
  const expectVersion = { size: "3", mtimeNs: "0" };
  try {
    await writeFile(join(root, "source"), "keep");
    await writeFile(join(root, "target"), "untouched");
    await expect(provider.rename(from, to, { replace: false, expectTarget: "absent" }, signal))
      .rejects.toMatchObject({ code: "changed_since_plan" });
    await expect(provider.remove(from, { kind: "file", expect: expectVersion }, signal))
      .rejects.toMatchObject({ code: "changed_since_plan" });
    expect(await readFile(join(root, "source"), "utf8")).toBe("keep");
    expect(await readFile(join(root, "target"), "utf8")).toBe("untouched");
  } finally {
    await harness.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});

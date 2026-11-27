import { expect, test, vi } from "vitest";
import { nameSpelling, tempNameFor, TransferHash, type Location } from "./reconcile.ts";
import { parsePosix } from "./path.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import type { Entry } from "./model.ts";

test.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
])("hashes the SHA-256 test vector %j with split input", (input, expected) => {
  const hash = new TransferHash();
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i += 7) hash.update(bytes.subarray(i, i + 7));
  expect(hash.finish()).toBe(expected);
});

test("derives an exclusive temporary name from the job and item", () => {
  expect(tempNameFor("223e4567-e89b-42d3-a456-426614174000", 12)).toEqual({
    t: ".commander-223e4567-e89b-42d3-a456-426614174000-12.part",
  });
});

function listing(provider: FakeProvider, pages: { names: string[]; cursor: string | null }[], repeat = false) {
  const entry = (name: string): Entry => ({
    name: { t: name }, kind: "file", size: "1", mtimeNs: "1", mtimePrecision: "ns", mode: null, linkTarget: null, hidden: false,
  });
  let call = 0;
  return vi.spyOn(provider, "list").mockImplementation(async () => {
    const page = pages[repeat ? Math.min(call, pages.length - 1) : call] ?? { names: [], cursor: null };
    call++;
    return { entries: page.names.map(entry), cursor: page.cursor };
  });
}

function pair(provider: FakeProvider, from: string, to: string): [Location, Location] {
  return [{ provider, path: parsePosix("/d/" + from) }, { provider, path: parsePosix("/d/" + to) }];
}

const context = (signal = new AbortController().signal) => ({ signal, chunkBytes: 1, call: <T>(call: () => Promise<T>) => call() });

test("stops after a repeated listing cursor and reports no spelling", async () => {
  const provider = new FakeProvider("host:ci", false);
  const list = listing(provider, [{ names: ["x"], cursor: "same" }], true);
  const [source, target] = pair(provider, "A", "a");
  expect(await nameSpelling(source, target, context())).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});

test("stops on an empty page that still has a cursor", async () => {
  const provider = new FakeProvider("host:ci", false);
  const list = listing(provider, [{ names: [], cursor: "next" }]);
  const [source, target] = pair(provider, "A", "a");
  expect(await nameSpelling(source, target, context())).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
});

test("stops at the page budget when every cursor is new", async () => {
  const provider = new FakeProvider("host:ci", false);
  let page = 0;
  const list = vi.spyOn(provider, "list").mockImplementation(async () => ({
    entries: [{ name: { t: "x" + page }, kind: "file", size: "1", mtimeNs: "1", mtimePrecision: "ns", mode: null, linkTarget: null, hidden: false }],
    cursor: "c" + ++page,
  }));
  const [source, target] = pair(provider, "A", "a");
  expect(await nameSpelling(source, target, context())).toBeNull();
  expect(list).toHaveBeenCalledTimes(1000);
});

test("honours the abort signal between pages", async () => {
  const provider = new FakeProvider("host:ci", false);
  const controller = new AbortController();
  const list = vi.spyOn(provider, "list").mockImplementation(async () => {
    controller.abort(new Error("stop"));
    return { entries: [{ name: { t: "x" }, kind: "file", size: "1", mtimeNs: "1", mtimePrecision: "ns", mode: null, linkTarget: null, hidden: false }], cursor: "more" };
  });
  const [source, target] = pair(provider, "A", "a");
  await expect(nameSpelling(source, target, context(controller.signal))).rejects.toThrow("stop");
  expect(list).toHaveBeenCalledTimes(1);
});

test.each([
  ["ä", "Ä", "ä", "target"],
  ["Ä", "Ä", "ä", "source"],
  ["ä".toUpperCase().normalize("NFD"), "Ä", "ä", "source"],
] as const)("compares names after NFC normalisation, case stays exact: listed %j", async (listed, from, to, expected) => {
  const provider = new FakeProvider("host:ci", false);
  listing(provider, [{ names: [listed], cursor: null }]);
  const [source, target] = pair(provider, from, to);
  expect(await nameSpelling(source, target, context())).toBe(expected);
});

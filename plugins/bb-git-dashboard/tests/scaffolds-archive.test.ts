import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveLimits, readTarball } from "../src/core/scaffolds/archive.ts";

type Entry = {name: string; body?: string | Uint8Array; type?: string; mode?: number; link?: string; pax?: Record<string, string>};

/** A tar archive as GitHub serves one: a pax global header with the commit, then the entries under one top folder. */
function tar(entries: Entry[], {global = true}: {global?: boolean} = {}) {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string, mode: number, link = "") => {
    const block = new Uint8Array(512);
    const put = (text: string, at: number, length: number) => block.set(new TextEncoder().encode(text).subarray(0, length), at);
    put(name, 0, 100);
    put(mode.toString(8).padStart(7, "0"), 100, 8);
    put("0000000", 108, 8); put("0000000", 116, 8);
    put(size.toString(8).padStart(11, "0"), 124, 12);
    put("00000000000", 136, 12);
    put("        ", 148, 8);
    put(type, 156, 1);
    put(link, 157, 100);
    put("ustar", 257, 6); put("00", 263, 2);
    const sum = block.reduce((total, byte) => total + byte, 0);
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    return block;
  };
  const data = (bytes: Uint8Array) => {
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes);
    return padded;
  };
  const record = (values: Record<string, string>) => new TextEncoder().encode(Object.entries(values).map(([key, value]) => {
    const line = " " + key + "=" + value + "\n";
    let length = line.length + 1;
    while (String(length).length + line.length !== length) length = String(length).length + line.length;
    return length + line;
  }).join(""));
  if (global) {
    const comment = record({comment: "0123456789abcdef0123456789abcdef01234567"});
    blocks.push(header("pax_global_header", comment.length, "g", 0o666), data(comment));
  }
  for (const entry of entries) {
    if (entry.pax) { const body = record(entry.pax); blocks.push(header("PaxHeader", body.length, "x", 0o644), data(body)); }
    const bytes = typeof entry.body === "string" ? new TextEncoder().encode(entry.body) : entry.body ?? new Uint8Array();
    const type = entry.type ?? "0";
    blocks.push(header(entry.name, type === "0" ? bytes.length : 0, type, entry.mode ?? 0o644, entry.link), ...(type === "0" ? [data(bytes)] : []));
  }
  blocks.push(new Uint8Array(1024));
  const all = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) { all.set(block, offset); offset += block.length; }
  return all;
}
const top = "owner-repo-0123456/";

test("an archive gives the files under common/ and templates/ as repository paths, text or bytes, with the executable bit", () => {
  const files = readTarball(tar([
    {name: top, type: "5", mode: 0o755},
    {name: top + "README.md", body: "# templates\n"},
    {name: top + "common/template.json", body: "{\"format\": 1}\n"},
    {name: top + "templates/demo/files/run.sh", body: "#!/bin/sh\n", mode: 0o755},
    {name: top + "templates/demo/files/icon.png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])},
    {name: top + ".github/workflows/ci.yml", body: "name: CI\n"},
  ]));
  assert.deepEqual(files, [
    {path: "common/template.json", text: "{\"format\": 1}\n", executable: false},
    {path: "templates/demo/files/run.sh", text: "#!/bin/sh\n", executable: true},
    {path: "templates/demo/files/icon.png", text: "iVBORwAB", base64: true, executable: false},
  ]);
});

test("a long path comes from its pax header", () => {
  const long = "templates/demo/files/" + "a".repeat(90) + "/" + "b".repeat(30) + ".txt";
  const files = readTarball(tar([{name: top + "templates/demo/files/short.txt", body: "x", pax: {path: top + long}}]));
  assert.deepEqual(files.map(file => file.path), [long]);
});

test("links, devices, absolute paths, .. and paths outside one top folder refuse the archive before any content is taken", () => {
  const refused = (entries: Entry[], detail: string) =>
    assert.throws(() => readTarball(tar(entries)), {message: "SCAFFOLDS_INVALID", detail});
  refused([{name: top + "templates/demo/files/link", type: "2", link: "/etc/passwd"}], "templates/demo/files/link is a link");
  refused([{name: top + "templates/demo/files/hard", type: "1", link: top + "README.md"}], "templates/demo/files/hard is a link");
  refused([{name: top + "templates/demo/files/dev", type: "3"}], "templates/demo/files/dev is not a file or a folder");
  refused([{name: "/etc/passwd", body: "x"}], "/etc/passwd is not inside the archive's folder");
  refused([{name: top + "templates/../../outside", body: "x"}], "templates/../../outside is not inside the archive's folder");
  refused([{name: top + "common/a", body: "x"}, {name: "other-top/common/b", body: "x"}], "other-top/common/b is not inside the archive's folder");
});

test("the limits refuse an archive: a file over 256 KB, too many entries, too deep, too much in all", () => {
  assert.throws(() => readTarball(tar([{name: top + "templates/a/files/big.txt", body: "x".repeat(archiveLimits.file + 1)}])),
    {message: "SCAFFOLDS_INVALID", detail: "templates/a/files/big.txt is over 256 KB"});
  const many = Array.from({length: archiveLimits.entries + 1}, (_, index) => ({name: top + "templates/a/files/f" + index, body: ""}));
  assert.throws(() => readTarball(tar(many)), {message: "SCAFFOLDS_INVALID", detail: "more than 2000 entries"});
  const deep = top + "templates/" + Array.from({length: archiveLimits.depth}, (_, index) => "d" + index).join("/") + "/f";
  assert.throws(() => readTarball(tar([{name: deep, body: "x"}])), {message: "SCAFFOLDS_INVALID", detail: deep.slice(top.length) + " is deeper than 12"});
  const chunk = "x".repeat(200 * 1024);
  const heavy = Array.from({length: 110}, (_, index) => ({name: top + "README" + index + ".md", body: chunk}));
  assert.throws(() => readTarball(tar(heavy)), {message: "SCAFFOLDS_INVALID", detail: "over 20 MB unpacked"});
});

test("a truncated or garbled archive is refused, not read in part", () => {
  const whole = tar([{name: top + "common/template.json", body: "{}"}]);
  assert.throws(() => readTarball(whole.subarray(0, 700)), {message: "SCAFFOLDS_INVALID", detail: "the archive ends inside an entry"});
  const garbled = whole.slice();
  garbled[148] = garbled[148] === 0x37 ? 0x36 : 0x37;
  assert.throws(() => readTarball(garbled), {message: "SCAFFOLDS_INVALID", detail: "the archive is not a tar archive"});
});

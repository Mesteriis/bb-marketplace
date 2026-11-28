// A BB stub for the scaffold RPC: settings, a database holding a revision of the fixture templates repository, and
// background services that are recorded, not started.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { ScaffoldCache } from "../src/adapters/bb/scaffold-cache.ts";
import { memoryDb } from "./review-db.ts";

export const fixture = new URL("./fixtures/scaffold-repo", import.meta.url).pathname;
export const fixtureSha = "c".repeat(40);
export const fixtureRepository = {repository: "owner/templates", branch: "main"};

/** A tar of entries (path, bytes, mode) under one top folder, as GitHub's tarball has them. */
export function tarOf(entries: {path: string; bytes: Uint8Array; mode: number}[], top = "owner-templates-ccccccc") {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const put = (value: string, at: number) => header.set(new TextEncoder().encode(value), at);
    put(top + "/" + entry.path, 0); put(entry.mode.toString(8).padStart(7, "0"), 100); put("0000000", 108); put("0000000", 116);
    put(entry.bytes.length.toString(8).padStart(11, "0"), 124); put("00000000000", 136); put("        ", 148); put("0", 156);
    put("ustar", 257); put("00", 263);
    put(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    const data = new Uint8Array(Math.ceil(entry.bytes.length / 512) * 512);
    data.set(entry.bytes);
    blocks.push(header, data);
  }
  blocks.push(new Uint8Array(1024));
  const all = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) { all.set(block, offset); offset += block.length; }
  return all;
}

/** The fixture templates repository as GitHub's gzip tarball of one commit. */
export function fixtureArchive() {
  const entries: {path: string; bytes: Uint8Array; mode: number}[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else entries.push({path: relative(fixture, path), bytes: readFileSync(path), mode: statSync(path).mode & 0o777});
  } };
  walk(fixture);
  return gzipSync(tarOf(entries));
}

/** The stub; `call` answers the host's calls. The fixture revision is held already, as after a check. */
export function scaffoldBb({call, settings = {}}: {call: (name: string, input: unknown) => Promise<unknown>; settings?: Record<string, string>}) {
  const db = memoryDb();
  new ScaffoldCache(db).put({...fixtureRepository, sha: fixtureSha, committedAt: "2026-11-28T10:00:00.000Z", etag: "W/\"fixture\"",
    checkedAt: "2026-11-28T10:00:00.000Z", archive: fixtureArchive()});
  const services: string[] = [];
  const bb = {
    settings: {define: () => ({get: async () => ({scaffoldsRepository: fixtureRepository.repository, scaffoldsBranch: fixtureRepository.branch, scaffoldsFolder: "", ...settings})})},
    hosts: {experimental_client: () => ({call})},
    storage: {database: () => db, migrate: () => {}},
    background: {service: (name: string) => { services.push(name); }},
    onDispose: () => {},
    realtime: {publish: () => {}},
  };
  return {bb: bb as never, services};
}
/** A fetch that never reaches anything: the tests run on the revision held. */
export const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

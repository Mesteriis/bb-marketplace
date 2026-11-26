// Prepares the release assets of a runtime build: the archives under their
// release asset names and channel.json pointing at them. Signing
// channel.json (channel.json.minisig) is a separate step with the owner's key.
//
//   node scripts/make-channel.ts --version 3.14.0+bb1 --tag v3.14.0 --commit <sha>
//        --min-plugin 0.1.0 --base-url <release download URL> --out <dir> <archive>...
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildChannelManifest, releaseAssetName } from "./lib/channel-manifest.ts";

const OPTIONS = ["--version", "--tag", "--commit", "--min-plugin", "--base-url", "--out"] as const;

function main(argv: string[]): void {
  const values = new Map<string, string>();
  const archives: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((OPTIONS as readonly string[]).includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      values.set(a, v);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option ${a}`);
    } else {
      archives.push(a);
    }
  }
  for (const o of OPTIONS) if (!values.has(o)) throw new Error(`${o} is required`);
  const manifest = buildChannelManifest({
    version: values.get("--version")!,
    gitwandTag: values.get("--tag")!,
    commit: values.get("--commit")!,
    minPluginVersion: values.get("--min-plugin")!,
    baseUrl: values.get("--base-url")!.replace(/\/+$/, ""),
    archives: archives.map((path) => ({
      file: basename(path),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      size: statSync(path).size,
    })),
  });
  const out = values.get("--out")!;
  mkdirSync(out, { recursive: true });
  for (const path of archives) copyFileSync(path, join(out, releaseAssetName(basename(path))));
  writeFileSync(join(out, "channel.json"), manifest);
  console.log(`channel.json: ${values.get("--version")}, ${archives.length} platform(s), in ${out}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`make-channel: ${(error as Error).message}`);
  process.exit(1);
}

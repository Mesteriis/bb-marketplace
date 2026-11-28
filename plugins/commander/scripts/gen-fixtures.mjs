import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MiB = 2 ** 20;
const root = await mkdtemp(join(realpathSync(tmpdir()), "commander-stage-2-"));
const path = (relative) => join(root, relative);

async function* largePayload() {
  for (let index = 0; index < 1024; index++) yield randomBytes(MiB);
}

try {
  for (const directory of ["many", "nfc", "nfd", "special", "empty", "sync/left", "sync/right"]) {
    await mkdir(path(directory), { recursive: true });
  }

  await writeFile(path("large-sparse.bin"), "");
  await truncate(path("large-sparse.bin"), 4 * 2 ** 30);
  await pipeline(Readable.from(largePayload()), createWriteStream(path("large-real.bin")));

  const smallPayload = randomBytes(1024);
  // Keep the number of simultaneously open files bounded.
  for (let first = 0; first < 100_000; first += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 100_000 - first) }, (_, offset) => {
      const name = String(first + offset).padStart(6, "0");
      return writeFile(path(`many/item-${name}.bin`), smallPayload);
    }));
  }

  await writeFile(path("nfc/café.txt"), "NFC\n");
  await writeFile(path("nfd/cafe\u0301.txt"), "NFD\n");
  await writeFile(path("special/имя [с пробелами].txt"), "1");
  await writeFile(path(`special/${"x".repeat(255)}`), "1");
  await writeFile(path("special/no-access"), "1");
  await chmod(path("special/no-access"), 0o000);
  await symlink(".", path("special/loop"));

  // Create each component relative to the preceding directory. Darwin's
  // pathname limit applies to the string supplied with each syscall.
  const longParts = ["long", ...Array(4).fill("d".repeat(200)), "x".repeat(215)];
  const originalCwd = process.cwd();
  try {
    process.chdir(root);
    for (const component of longParts.slice(0, -1)) {
      await mkdir(component);
      process.chdir(component);
    }
    await writeFile(longParts.at(-1), "1");
  } finally {
    process.chdir(originalCwd);
  }

  for (const [name, content] of Object.entries({
    "left/same.txt": "same\n",
    "right/same.txt": "same\n",
    "left/changed.txt": "old\n",
    "right/changed.txt": "new content\n",
    "left/left-only.txt": "left\n",
    "right/right-only.txt": "right\n",
  })) {
    await writeFile(path(`sync/${name}`), content);
  }

  execFileSync("zip", ["-q", "-0", "large.zip", "large-real.bin"], { cwd: root });
  execFileSync("tar", ["--format=ustar", "-cf", "large.tar", "large-real.bin"], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  process.stdout.write(`${root}\n`);
} catch (error) {
  await rm(root, { recursive: true, force: true }).catch((cleanupError) => {
    console.error(`Не удалось удалить ${root}:`, cleanupError);
  });
  throw error;
}

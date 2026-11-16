import { describe, expect, it } from "vitest";
import {
  PATCH_FILES_MAX,
  PATCH_MAX_BYTES,
  isPatchAttachment,
  parsePatch,
  patchFileName,
  patchFromBody,
  patchRef,
  patchSummary,
} from "./patch.ts";

const lines = (...rows: string[]) => rows.join("\n");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const FORMAT_PATCH = lines(
  `From ${SHA} Mon Sep 17 00:00:00 2001`,
  "From: Invented Author <author@example.org>",
  "Date: Mon, 16 Nov 2026 10:00:00 +0000",
  "Subject: [PATCH 1/3] Fix the invented parser",
  "",
  "The parser dropped the last line.",
  "",
  "---",
  " src/parser.ts | 2 +-",
  " 1 file changed, 1 insertion(+), 1 deletion(-)",
  "",
  "diff --git a/src/parser.ts b/src/parser.ts",
  "index 1111111..2222222 100644",
  "--- a/src/parser.ts",
  "+++ b/src/parser.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " export { a, b };",
  "-- ",
  "2.47.0",
);

const fileDiff = (path: string, extra: string[] = []) =>
  lines(`diff --git a/${path} b/${path}`, ...extra, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-x", "+y");

describe("isPatchAttachment", () => {
  it("knows .patch and .diff names and patch types up to 1 MB", () => {
    expect(isPatchAttachment({ filename: "fix.patch", mimeType: "application/octet-stream", size: 10 })).toBe(true);
    expect(isPatchAttachment({ filename: "FIX.DIFF", mimeType: "text/plain", size: 10 })).toBe(true);
    expect(isPatchAttachment({ filename: null, mimeType: "text/x-patch", size: 10 })).toBe(true);
    expect(isPatchAttachment({ filename: "a.txt", mimeType: "text/x-diff", size: 10 })).toBe(true);
    expect(isPatchAttachment({ filename: "fix.patch", mimeType: "text/x-patch", size: PATCH_MAX_BYTES + 1 })).toBe(false);
    expect(isPatchAttachment({ filename: "notes.txt", mimeType: "text/plain", size: 10 })).toBe(false);
  });
});

describe("patchFromBody", () => {
  it("finds a format-patch message and a bare diff, not ordinary text", () => {
    expect(patchFromBody(FORMAT_PATCH)).toBe(FORMAT_PATCH);
    const bare = lines("--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "-a", "+b");
    expect(patchFromBody(`Here you go:\n\n${bare}`)).not.toBeNull();
    expect(patchFromBody("Hello, the diff --git command is nice.")).toBeNull();
    expect(patchFromBody("---\nsignature")).toBeNull();
  });
});

describe("parsePatch", () => {
  it("reads a format-patch: files, counts and the commit message", () => {
    const parsed = parsePatch(FORMAT_PATCH);
    expect(parsed.refused).toBeNull();
    expect(parsed.commitMessage).toBe("Fix the invented parser\n\nThe parser dropped the last line.");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      oldPath: "src/parser.ts",
      newPath: "src/parser.ts",
      added: 1,
      removed: 1,
      status: "modified",
      binary: false,
      symlink: false,
      executable: false,
    });
    expect(parsed.files[0]!.patch.startsWith("diff --git a/src/parser.ts")).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a bare diff with no commit message", () => {
    const parsed = parsePatch(lines("--- a/x.txt", "+++ b/x.txt", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"));
    expect(parsed.refused).toBeNull();
    expect(parsed.commitMessage).toBeNull();
    expect(parsed.files.map((file) => [file.newPath, file.added, file.removed])).toEqual([["x.txt", 1, 1]]);
  });

  it("counts a removed line that starts with dashes as content, not a header", () => {
    const parsed = parsePatch(lines("diff --git a/m.md b/m.md", "--- a/m.md", "+++ b/m.md", "@@ -1,2 +1,1 @@", "---- old rule", " keep"));
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({ removed: 1, added: 0 });
  });

  it("reads several files of a series and new, deleted, renamed and copied ones", () => {
    const text = lines(
      fileDiff("a.txt"),
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/old.txt b/moved.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to moved.txt",
      "diff --git a/base.txt b/copy.txt",
      "similarity index 100%",
      "copy from base.txt",
      "copy to copy.txt",
    );
    const parsed = parsePatch(text);
    expect(parsed.refused).toBeNull();
    expect(parsed.files.map((file) => [file.status, file.oldPath, file.newPath])).toEqual([
      ["modified", "a.txt", "a.txt"],
      ["added", null, "new.txt"],
      ["deleted", "gone.txt", null],
      ["renamed", "old.txt", "moved.txt"],
      ["copied", "base.txt", "copy.txt"],
    ]);
  });

  it("unescapes C-style quoted paths", () => {
    const parsed = parsePatch(lines('diff --git "a/sp ace\\303\\244.txt" "b/sp ace\\303\\244.txt"', '--- "a/sp ace\\303\\244.txt"', '+++ "b/sp ace\\303\\244.txt"', "@@ -1 +1 @@", "-a", "+b"));
    expect(parsed.refused).toBeNull();
    expect(parsed.files[0]!.newPath).toBe("sp ace\u00e4.txt");
  });

  it.each([
    ["an absolute path", fileDiff("/etc/passwd")],
    ["a parent segment", fileDiff("../outside.txt")],
    ["a backslash", lines("--- a/a\\b.txt", "+++ b/a\\b.txt", "@@ -1 +1 @@", "-a", "+b")],
    [".git in another case", fileDiff(".GIT/config")],
    [".git with a trailing dot", fileDiff("sub/.git./hooks/x")],
    ["a quoted escaped .git", lines('diff --git "a/\\.git/x" "b/\\.git/x"', "@@ -1 +1 @@", "-a", "+b")],
    ["an octal-escaped .git", lines('diff --git "a/.gi\\164/config" "b/.gi\\164/config"', "@@ -1 +1 @@", "-a", "+b")],
    ["a rename to a parent", lines("diff --git a/x b/x", "rename from x", "rename to ../x")],
    ["a copy into .git", lines("diff --git a/x b/y", "copy from x", "copy to .git/y")],
    ["a +++ into .git hooks", lines("--- a/ok.txt", "+++ b/.git/hooks/pre-commit", "@@ -1 +1 @@", "-a", "+b")],
    ["an unreadable quoted path", lines('diff --git "a/x\\q" "b/x"', "@@ -1 +1 @@", "-a", "+b")],
    ["no diff at all", "Just some words"],
  ])("refuses %s", (_label, text) => {
    const parsed = parsePatch(text);
    expect(parsed.refused).not.toBeNull();
    expect(parsed.files).toEqual([]);
  });

  it("names the reason", () => {
    expect(parsePatch(fileDiff(".GIT/config")).refused).toBe("The patch writes into .git");
    expect(parsePatch(lines('diff --git "a/.gi\\164/config" "b/.gi\\164/config"', "@@ -1 +1 @@", "-a", "+b")).refused).toBe(
      "The patch writes into .git",
    );
    expect(parsePatch(lines("diff --git a/x b/x", "rename from x", "rename to ../x")).refused).toBe(
      "A path in the patch climbs out of the project",
    );
    expect(parsePatch(lines('diff --git "a/x\\q" "b/x"', "@@ -1 +1 @@", "-a", "+b")).refused).toBe("A path in the patch cannot be read");
  });

  it("refuses more than 200 files and more than 1 MB", () => {
    const many = Array.from({ length: PATCH_FILES_MAX + 1 }, (_, i) => fileDiff(`f${i}.txt`)).join("\n");
    expect(parsePatch(many).refused).toMatch(/200/);
    expect(parsePatch(Array.from({ length: PATCH_FILES_MAX }, (_, i) => fileDiff(`f${i}.txt`)).join("\n")).refused).toBeNull();
    expect(parsePatch(`${fileDiff("a.txt")}\n+${"x".repeat(PATCH_MAX_BYTES)}`).refused).toMatch(/1 MB/);
  });

  it("marks binary, symlink and executable files and warns about them", () => {
    const parsed = parsePatch(
      lines(
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/link b/link",
        "new file mode 120000",
        "--- /dev/null",
        "+++ b/link",
        "@@ -0,0 +1 @@",
        "+target",
        "diff --git a/run b/run",
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(parsed.refused).toBeNull();
    expect(parsed.files.map((file) => [file.binary, file.symlink, file.executable])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(parsed.warnings).toEqual([
      "Binary change: img.png",
      "Symbolic link: link",
      "Executable file: run",
    ]);
  });

  it("warns about build, CI, hook, lock and agent files", () => {
    const paths = [
      ".github/workflows/ci.yml", ".gitlab-ci.yml", "package.json", "Makefile", "scripts/deploy.sh", ".husky/pre-commit",
      "Dockerfile", "package-lock.json", ".claude/settings.json", ".bb/plugins.json", ".mcp.json", ".envrc",
      ".gitattributes", ".gitmodules", ".vscode/tasks.json", ".cursor/rules.mdc", "docs/AGENTS.md", "src/ok.ts",
    ];
    const parsed = parsePatch(paths.map((path) => fileDiff(path)).join("\n"));
    expect(parsed.refused).toBeNull();
    const warned = paths.filter((path) => parsed.warnings.some((warning) => warning.endsWith(`: ${path}`)));
    expect(warned).toEqual(paths.slice(0, -1));
  });
});

describe("hostile subjects and bodies", () => {
  const diff = fileDiff("src/a.ts");
  const hostile = (subject: string) => lines(`From ${SHA} Mon Sep 17 00:00:00 2001`, `Subject: ${subject}`, "", "---", diff);
  const room = PATCH_MAX_BYTES - 200 - diff.length;

  it("reads a 1 MB subject of brackets and PATCH words in linear time", () => {
    for (const subject of ["[" + "PATCH".repeat(Math.floor(room / 5)), " ".repeat(room) + "[x", "[" + "PATCH ".repeat(Math.floor(room / 6))]) {
      const started = performance.now();
      const parsed = parsePatch(hostile(subject));
      expect(performance.now() - started).toBeLessThan(200);
      expect(parsed.refused).toBeNull();
      // The subject is cut to one header line (998 characters).
      expect((parsed.commitMessage ?? "").length).toBeLessThanOrEqual(998);
    }
  });

  it("still drops a [PATCH n/m] prefix and leaves other brackets", () => {
    expect(parsePatch(hostile("[PATCH v2 1/3] Fix it")).commitMessage).toBe("Fix it");
    expect(parsePatch(hostile("[RFC] Fix it")).commitMessage).toBe("[RFC] Fix it");
    expect(parsePatch(hostile(`[${"x".repeat(250)} PATCH] Fix it`)).commitMessage).toBe(`[${"x".repeat(250)} PATCH] Fix it`);
  });

  it("patchSummary counts files and lines without parsing", () => {
    expect(patchSummary(FORMAT_PATCH)).toEqual({ files: 1, added: 1, removed: 1 });
    const started = performance.now();
    patchSummary(hostile("[" + "PATCH".repeat(Math.floor(room / 5))));
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("patchRef and patchFileName", () => {
  it("is a stable SHA-256 of the bytes", async () => {
    const bytes = new TextEncoder().encode(FORMAT_PATCH);
    const ref = await patchRef(bytes);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(await patchRef(new TextEncoder().encode(FORMAT_PATCH))).toBe(ref);
    expect(await patchRef(new TextEncoder().encode(`${FORMAT_PATCH} `))).not.toBe(ref);
  });

  it("names the file by day and subject", () => {
    expect(patchFileName("2026-11-16T10:00:00.000Z", "[PATCH 1/3] Fix the invented parser")).toBe("2026-11-16-fix-the-invented-parser.patch");
    expect(patchFileName(null, "../../etc/passwd")).toBe("etc-passwd.patch");
    expect(patchFileName(null, "")).toBe("mail.patch");
    expect(patchFileName("2026-11-16T10:00:00.000Z", "x".repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

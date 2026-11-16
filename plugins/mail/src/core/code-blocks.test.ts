import { describe, expect, it } from "vitest";
import { CODE_BLOCKS_MAX, codeBlocks, snippetPath } from "./code-blocks.ts";

const lines = (...rows: string[]) => rows.join("\n");

describe("snippetPath", () => {
  it("maps known languages to an extension and the rest to .txt", () => {
    expect(snippetPath("ts")).toBe("snippet.ts");
    expect(snippetPath("TypeScript")).toBe("snippet.ts");
    expect(snippetPath("python")).toBe("snippet.py");
    expect(snippetPath("bash")).toBe("snippet.sh");
    expect(snippetPath("diff")).toBe("snippet.diff");
    expect(snippetPath("dockerfile")).toBe("Dockerfile");
    expect(snippetPath(null)).toBe("snippet.txt");
    expect(snippetPath("../../etc")).toBe("snippet.txt");
  });
});

describe("codeBlocks", () => {
  it("keeps ordinary text as one text part", () => {
    expect(codeBlocks("Hello,\n\nsee you.")).toEqual([{ kind: "text", text: "Hello,\n\nsee you." }]);
  });

  it("finds fenced blocks with and without a language, backticks and tildes", () => {
    const parts = codeBlocks(lines("Before", "```ts", "const a = 1;", "```", "Middle", "~~~", "raw", "~~~", "After"));
    expect(parts).toEqual([
      { kind: "text", text: "Before" },
      { kind: "code", text: "const a = 1;", language: "ts", path: "snippet.ts" },
      { kind: "text", text: "Middle" },
      { kind: "code", text: "raw", language: null, path: "snippet.txt" },
      { kind: "text", text: "After" },
    ]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(codeBlocks(lines("x", "```py", "print(1)", "print(2)"))).toEqual([
      { kind: "text", text: "x" },
      { kind: "code", text: "print(1)\nprint(2)", language: "py", path: "snippet.py" },
    ]);
  });

  it("splits a unified diff per file", () => {
    const diff = lines(
      "Please apply:",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/docs/b.md b/docs/b.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/b.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "Thanks",
    );
    const parts = codeBlocks(diff);
    expect(parts[0]).toEqual({ kind: "text", text: "Please apply:" });
    expect(parts[1]).toMatchObject({ kind: "diff" });
    const files = (parts[1] as { files: { path: string; patch: string }[] }).files;
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "docs/b.md"]);
    expect(files[0]!.patch.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(files[1]!.patch.endsWith("+hello")).toBe(true);
    expect(parts[2]).toEqual({ kind: "text", text: "Thanks" });
  });

  it("finds a bare ---/+++/@@ diff", () => {
    const parts = codeBlocks(lines("--- a/x.txt", "+++ b/x.txt", "@@ -1,2 +1,2 @@", " same", "-a", "+b"));
    expect(parts).toEqual([{ kind: "diff", files: [{ path: "x.txt", patch: lines("--- a/x.txt", "+++ b/x.txt", "@@ -1,2 +1,2 @@", " same", "-a", "+b") }] }]);
  });

  it("finds indented runs of three or more lines after a blank line", () => {
    const parts = codeBlocks(lines("Run this:", "", "    npm ci", "    npm test", "\tnpm run build", "", "Done"));
    expect(parts).toEqual([
      { kind: "text", text: "Run this:\n" },
      { kind: "code", text: "npm ci\nnpm test\nnpm run build", language: null, path: "snippet.txt" },
      { kind: "text", text: "\nDone" },
    ]);
  });

  it("leaves short indents, lists, quotes and signatures as text", () => {
    for (const text of [
      lines("Text", "", "    two lines", "    only"),
      lines("Items:", "", "    - one", "    - two", "    - three"),
      lines("> quoted", ">     code-like", ">     more", ">     lines"),
      lines("Bye", "-- ", "Invented Sender", "Invented Company"),
      lines("A line", "    continues", "    the paragraph", "    here"),
    ]) {
      expect(codeBlocks(text).every((part) => part.kind === "text"), text).toBe(true);
    }
  });

  it("finds log runs of five or more lines", () => {
    const log = lines(
      "2026-11-16T10:00:00Z INFO start",
      "2026-11-16T10:00:01Z WARN slow",
      "ERROR failed to connect",
      "java.lang.IllegalStateException: boom",
      "\tat com.example.Main.run(Main.java:10)",
      "\tat com.example.Main.main(Main.java:5)",
    );
    const parts = codeBlocks(lines("What happened:", log, "Thanks"));
    expect(parts[0]).toEqual({ kind: "text", text: "What happened:" });
    expect(parts[1]).toMatchObject({ kind: "log", path: "snippet.log" });
    expect((parts[1] as { text: string }).text.split("\n")).toHaveLength(6);
    expect(codeBlocks(lines("INFO a", "INFO b", "INFO c", "INFO d")).every((part) => part.kind === "text")).toBe(true);
  });

  it("caps blocks at 50 and their text at 200 000 characters", () => {
    const many = Array.from({ length: 60 }, (_, i) => lines("```", `block ${i}`, "```")).join("\nx\n");
    expect(codeBlocks(many).filter((part) => part.kind !== "text")).toHaveLength(CODE_BLOCKS_MAX);
    const big = lines("```", "y".repeat(150_000), "```", "```", "z".repeat(150_000), "```");
    const code = codeBlocks(big).filter((part) => part.kind === "code") as { text: string }[];
    expect(code.reduce((sum, part) => sum + part.text.length, 0)).toBeLessThanOrEqual(200_000);
  });
});

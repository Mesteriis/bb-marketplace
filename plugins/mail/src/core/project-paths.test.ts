import { describe, expect, it } from "vitest";
import {
  PROJECT_FOLDER_MAX_CHARS,
  agentInstructionName,
  keepBothName,
  projectFolder,
  projectRelativePath,
  savedName,
  sensitiveName,
  underGit,
  withinTree,
} from "./project-paths.ts";

describe("projectFolder", () => {
  it("accepts a relative folder of sanitized segments", () => {
    expect(projectFolder("mail-attachments")).toEqual({ ok: true, segments: ["mail-attachments"] });
    expect(projectFolder("docs/inbox 2026")).toEqual({ ok: true, segments: ["docs", "inbox 2026"] });
  });

  it.each([
    ["", "empty"],
    [".", "dot_segment"],
    ["..", "dot_segment"],
    ["a/../b", "dot_segment"],
    ["a//b", "empty"],
    ["a/", "empty"],
    ["/etc", "absolute"],
    ["~/x", "home"],
    ["~", "home"],
    ["C:/x", "drive"],
    ["c:", "drive"],
    ["a\\b", "backslash"],
    [".git", "git"],
    [".GIT", "git"],
    ["a/.Git/x", "git"],
    ["a/.git.", "git"],
    ["a/.git ", "git"],
    [".github/workflows", "hidden"],
    [".vscode", "hidden"],
    ["a/.husky", "hidden"],
    ["a/b/c/d/e/f/g/h/i", "too_deep"],
    ["a:b", "unsafe_segment"],
    ["a /b", "unsafe_segment"],
    ["a\u202eb", "unsafe_segment"],
  ])("refuses %j (%s)", (folder, reason) => {
    expect(projectFolder(folder)).toEqual({ ok: false, reason });
  });

  it("allows eight segments and 240 characters, not more", () => {
    expect(projectFolder("a/b/c/d/e/f/g/h").ok).toBe(true);
    const at = `${"x".repeat(100)}/${"y".repeat(100)}/${"z".repeat(PROJECT_FOLDER_MAX_CHARS - 202)}`;
    expect(at.length).toBe(240);
    expect(projectFolder(at).ok).toBe(true);
    expect(projectFolder(`${at}z`)).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("savedName", () => {
  it("sanitizes and falls back to attachment", () => {
    expect(savedName("report.pdf")).toBe("report.pdf");
    expect(savedName("../../x.pdf")).toBe("x.pdf");
    expect(savedName(null)).toBe("attachment");
  });

  it("appends .txt to shortcuts and agent-instruction names", () => {
    for (const name of ["open.lnk", "site.URL", "a.webloc", "app.desktop"]) {
      expect(savedName(name)).toBe(`${name}.txt`);
    }
    expect(savedName("AGENTS.md")).toBe("AGENTS.md.txt");
    expect(savedName("claude.md")).toBe("claude.md.txt");
    expect(savedName(".mcp.json")).toBe("mcp.json.txt");
    expect(savedName(".cursorrules")).toBe("cursorrules.txt");
    expect(savedName("x.mdc")).toBe("x.mdc.txt");
    expect(savedName("copilot-instructions.md")).toBe("copilot-instructions.md.txt");
    expect(savedName("notes.md")).toBe("notes.md");
  });

  it("keeps a long shortcut name within 120 characters ending in .txt", () => {
    const name = savedName(`${"n".repeat(118)}.lnk`);
    expect(Array.from(name).length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".txt")).toBe(true);
  });
});

describe("agentInstructionName", () => {
  it("knows the instruction files case-insensitively, by base name", () => {
    for (const name of [
      "agents.md", "CLAUDE.md", "gemini.md", "SKILL.md", "mcp.json", ".mcp.json", "cursorrules", ".cursorrules",
      "windsurfrules", ".windsurfrules", "clinerules", ".clinerules", "copilot-instructions.md", "rules/x.MDC",
      "docs/AGENTS.md",
    ]) {
      expect(agentInstructionName(name), name).toBe(true);
    }
    for (const name of ["notes.md", "agents.md.txt", "my-claude.md", "mdc"]) {
      expect(agentInstructionName(name), name).toBe(false);
    }
  });
});

describe("keepBothName", () => {
  it("numbers before the extension", () => {
    expect(keepBothName("report.pdf", 2)).toBe("report (2).pdf");
    expect(keepBothName("report.pdf", 99)).toBe("report (99).pdf");
    expect(keepBothName("README", 3)).toBe("README (3)");
    expect(keepBothName("archive.tar.gz", 2)).toBe("archive (2).tar.gz");
    expect(keepBothName("a.b.c.txt", 2)).toBe("a.b.c (2).txt");
  });

  it("refuses numbers outside 2 to 99", () => {
    expect(() => keepBothName("a.txt", 1)).toThrow(RangeError);
    expect(() => keepBothName("a.txt", 100)).toThrow(RangeError);
  });

  it("stays within 120 characters", () => {
    const name = keepBothName(`${"n".repeat(116)}.pdf`, 42);
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith(" (42).pdf")).toBe(true);
  });
});

describe("projectRelativePath", () => {
  it("joins a valid folder and a saved name", () => {
    expect(projectRelativePath("mail-attachments", "report.pdf")).toEqual({
      ok: true,
      relativePath: "mail-attachments/report.pdf",
    });
  });

  it("refuses a bad folder or a name that is not its sanitized form", () => {
    expect(projectRelativePath("../x", "a.pdf")).toEqual({ ok: false, reason: "dot_segment" });
    expect(projectRelativePath("x", "../a.pdf")).toEqual({ ok: false, reason: "unsafe_name" });
    expect(projectRelativePath("x", ".env")).toEqual({ ok: false, reason: "unsafe_name" });
    expect(projectRelativePath("x", "")).toEqual({ ok: false, reason: "unsafe_name" });
    expect(projectRelativePath("x", "a/b")).toEqual({ ok: false, reason: "unsafe_name" });
  });
});

describe("withinTree", () => {
  it("accepts a path strictly inside the tree", () => {
    expect(withinTree("/p/api", "/p/api/mail-attachments/a.pdf")).toBe(true);
    expect(withinTree("/p/api/", "/p/api/a.pdf")).toBe(true);
  });

  it("refuses escapes, siblings and the tree itself", () => {
    expect(withinTree("/p/api", "/p/api/../x")).toBe(false);
    expect(withinTree("/p/api", "/p/api/a/../../x")).toBe(false);
    expect(withinTree("/p/api", "/p/api2/a.pdf")).toBe(false);
    expect(withinTree("/p/api", "/p/api")).toBe(false);
    expect(withinTree("/p/api", "/p/api/.")).toBe(false);
    expect(withinTree("/p/api", "relative/a")).toBe(false);
    expect(withinTree("/p/api", "/p/api\\..\\x")).toBe(false);
    expect(withinTree("relative", "relative/a")).toBe(false);
  });

  it("normalizes inner dots and doubled slashes that stay inside", () => {
    expect(withinTree("/p/api", "/p/api/./a//b/../c.txt")).toBe(true);
  });
});

describe("sensitiveName", () => {
  it("flags credential-like names", () => {
    for (const name of [
      ".env", ".env.local", "env.production", "cert.PEM", "server.key", "id_rsa", "id_ed25519.pub",
      "credentials.json", "Secrets.yaml", "store.p12", ".npmrc", ".netrc", "config/.env",
    ]) {
      expect(sensitiveName(name), name).toBe(true);
    }
  });

  it("leaves ordinary names alone", () => {
    for (const name of ["envelope.txt", "keynote.pdf", "report.pdf", "identity.md", "secret-santa.png"]) {
      expect(sensitiveName(name), name).toBe(false);
    }
  });
});

describe("underGit", () => {
  it("finds a .git segment in any case", () => {
    expect(underGit(".git/config")).toBe(true);
    expect(underGit("a/.GIT/hooks/x")).toBe(true);
    expect(underGit("a/.git./x")).toBe(true);
    expect(underGit(".github/workflows/ci.yml")).toBe(false);
    expect(underGit("a/git/x")).toBe(false);
  });
});

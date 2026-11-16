import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applySkills,
  bucketSkills,
  catalogueSkills,
  diffTrees,
  diffSkill,
  listFiles,
  normalise,
  prepare,
  readMarker,
  readFrontmatterDescription,
  splitCosmetic,
  statusFrom,
  unifiedDiff,
  writeMarker,
} from "../sync";
import { fetchedAtPath, readFetchedAt } from "../sync-git";
import { makeGitRepo, makePrepared, makeSource, tmpDir, writeTree } from "./fixtures";

const skill = (body: string) => `---\nname: x\n---\n\n${body}\n`;

describe("normalise", () => {
  it("erases an em-dash pass", () => {
    expect(normalise("do this—then that")).toBe(normalise("do this - then that"));
    expect(normalise("do this—then that")).toBe(normalise("do this, then that"));
  });

  it("erases smart quotes and whitespace reflow", () => {
    expect(normalise("say “hi”\n  there")).toBe(normalise('say "hi" there'));
  });

  it("keeps a real word change", () => {
    expect(normalise("run the tests")).not.toBe(normalise("skip the tests"));
  });
});

describe("splitCosmetic", () => {
  it("separates punctuation churn from a rewrite", () => {
    const before = writeTree(tmpDir("p"), {
      "SKILL.md": skill("Use the flag—always."),
      "notes.md": skill("Read the docs."),
      "same.md": skill("Unchanged."),
    });
    const after = writeTree(tmpDir("h"), {
      "SKILL.md": skill("Use the flag, always."),
      "notes.md": skill("Read the source instead."),
      "same.md": skill("Unchanged."),
    });
    expect(splitCosmetic(before, after)).toEqual({
      cosmeticFiles: ["SKILL.md"],
      substantiveFiles: ["notes.md"],
    });
  });

  it("treats an added file as substantive, never cosmetic", () => {
    const before = writeTree(tmpDir("p"), { "SKILL.md": skill("a") });
    const after = writeTree(tmpDir("h"), {
      "SKILL.md": skill("a"),
      "extra.md": skill("b"),
    });
    expect(splitCosmetic(before, after)).toEqual({
      cosmeticFiles: [],
      substantiveFiles: ["extra.md"],
    });
  });
});

describe("bucketSkills", () => {
  // One scenario producing all five buckets plus a foreign folder.
  const source = makeSource();

  const pinFiles = {
    "skills/core/clean-one/SKILL.md": skill("original"),
    "skills/core/conflicted/SKILL.md": skill("original—dashed"),
    "skills/core/mine-only/SKILL.md": skill("original"),
    "skills/core/retired/SKILL.md": skill("original"),
    "skills/core/untouched/SKILL.md": skill("original"),
  };
  const headFiles = {
    "skills/core/clean-one/SKILL.md": skill("upstream rewrote this"),
    "skills/core/conflicted/SKILL.md": skill("upstream rewrote this too"),
    "skills/core/mine-only/SKILL.md": skill("original"),
    "skills/core/untouched/SKILL.md": skill("original"),
    "skills/core/brand-new/SKILL.md": skill("shiny"),
    "skills/in-progress/half-baked/SKILL.md": skill("wip"),
    // `retired` moved under a deprecated bucket rather than vanishing.
    "skills/deprecated/retired/SKILL.md": skill("original"),
  };
  const localFiles = {
    "clean-one/SKILL.md": skill("original"),
    "conflicted/SKILL.md": skill("my own take"),
    "mine-only/SKILL.md": skill("my own take"),
    "retired/SKILL.md": skill("original"),
    "untouched/SKILL.md": skill("original"),
    "my-own-skill/SKILL.md": skill("written by me"),
  };

  const run = () =>
    bucketSkills(
      source,
      writeTree(tmpDir("head"), headFiles),
      writeTree(tmpDir("pin"), pinFiles),
      writeTree(tmpDir("local"), localFiles),
    );

  const bucketOf = (name: string) => {
    const { skills } = run();
    return skills.find((entry) => entry.name === name)?.bucket;
  };

  it("buckets new", () => expect(bucketOf("brand-new")).toBe("new"));
  it("buckets deprecated", () => expect(bucketOf("retired")).toBe("deprecated"));
  it("buckets clean", () => expect(bucketOf("clean-one")).toBe("clean"));
  it("buckets dirty-conflict", () => expect(bucketOf("conflicted")).toBe("dirty-conflict"));
  it("buckets dirty-only", () => expect(bucketOf("mine-only")).toBe("dirty-only"));

  it("says nothing about a skill that matches on all three sides", () => {
    expect(bucketOf("untouched")).toBeUndefined();
  });

  it("never offers a skipped bucket as new", () => {
    expect(bucketOf("half-baked")).toBeUndefined();
  });

  it("lists a local folder with no upstream match as foreign and in no bucket", () => {
    const { skills, foreign } = run();
    expect(foreign).toEqual(["my-own-skill"]);
    expect(skills.map((entry) => entry.name)).not.toContain("my-own-skill");
  });

  describe("'new' means not-yet-declined, not merely absent from the pin", () => {
    const emptyLocal = () => tmpDir("local");

    const bucketFor = (pinPath: string, headPath: string) => {
      const { skills } = bucketSkills(
        source,
        writeTree(tmpDir("head"), { [headPath]: skill("body") }),
        writeTree(tmpDir("pin"), { [pinPath]: skill("body") }),
        emptyLocal(),
      );
      return skills[0]?.bucket;
    };

    it("offers a skill promoted out of a skipped bucket", () => {
      expect(
        bucketFor("skills/in-progress/retro/SKILL.md", "skills/engineering/retro/SKILL.md"),
      ).toBe("new");
    });

    it("offers a skill revived out of deprecated/", () => {
      expect(
        bucketFor("skills/deprecated/retro/SKILL.md", "skills/engineering/retro/SKILL.md"),
      ).toBe("new");
    });

    it("stays quiet about a skill offered at the pin and declined", () => {
      expect(
        bucketFor("skills/engineering/retro/SKILL.md", "skills/engineering/retro/SKILL.md"),
      ).toBeUndefined();
    });

    it("stays quiet about a skill skipped at both ends", () => {
      expect(
        bucketFor("skills/in-progress/retro/SKILL.md", "skills/in-progress/retro/SKILL.md"),
      ).toBeUndefined();
    });

    it("stays quiet about a skill demoted into a skipped bucket", () => {
      expect(
        bucketFor("skills/engineering/retro/SKILL.md", "skills/in-progress/retro/SKILL.md"),
      ).toBeUndefined();
    });

    it("reports the bucket it now sits in", () => {
      const { skills } = bucketSkills(
        source,
        writeTree(tmpDir("head"), { "skills/engineering/retro/SKILL.md": skill("body") }),
        writeTree(tmpDir("pin"), { "skills/in-progress/retro/SKILL.md": skill("body") }),
        emptyLocal(),
      );
      expect(skills[0]).toMatchObject({ name: "retro", bucket: "new", upstreamBucket: "engineering" });
    });
  });

  describe("a stale pin never manufactures a conflict", () => {
    const head = {
      "skills/core/synced/SKILL.md": skill("upstream now"),
      "skills/core/synced/notes.md": "notes\n",
    };
    const stalePin = {
      "skills/core/synced/SKILL.md": skill("upstream long ago"),
      "skills/core/synced/notes.md": "old notes\n",
    };

    it("reports nothing when the install matches HEAD but the pin is behind", () => {
      const { skills } = bucketSkills(
        source,
        writeTree(tmpDir("head"), head),
        writeTree(tmpDir("pin"), stalePin),
        writeTree(tmpDir("local"), {
          "synced/SKILL.md": skill("upstream now"),
          "synced/notes.md": "notes\n",
        }),
      );
      expect(skills).toEqual([]);
    });

    it("still reports nothing when the pin is already at HEAD", () => {
      const { skills } = bucketSkills(
        source,
        writeTree(tmpDir("head"), head),
        writeTree(tmpDir("pin"), head),
        writeTree(tmpDir("local"), {
          "synced/SKILL.md": skill("upstream now"),
          "synced/notes.md": "notes\n",
        }),
      );
      expect(skills).toEqual([]);
    });

    it("still buckets a skill that matches HEAD in every file but one", () => {
      const { skills } = bucketSkills(
        source,
        writeTree(tmpDir("head"), head),
        writeTree(tmpDir("pin"), stalePin),
        writeTree(tmpDir("local"), {
          "synced/SKILL.md": skill("upstream now"),
          "synced/notes.md": "my own notes\n",
        }),
      );
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        name: "synced",
        bucket: "dirty-conflict",
        localEditedFiles: ["SKILL.md", "notes.md"],
      });
    });

    it("still buckets a skill missing a file HEAD ships", () => {
      const { skills } = bucketSkills(
        source,
        writeTree(tmpDir("head"), head),
        writeTree(tmpDir("pin"), stalePin),
        writeTree(tmpDir("local"), { "synced/SKILL.md": skill("upstream now") }),
      );
      expect(skills[0]).toMatchObject({ name: "synced", bucket: "dirty-conflict" });
    });

    it("does not write the marker while reporting", () => {
      const installRoot = writeTree(tmpDir("local"), {
        "synced/SKILL.md": skill("upstream now"),
        "synced/notes.md": "notes\n",
        ".test-skills-version": "oldpin\n",
      });
      bucketSkills(
        makeSource({ installRoot }),
        writeTree(tmpDir("head"), head),
        writeTree(tmpDir("pin"), stalePin),
        installRoot,
      );
      expect(readMarker(makeSource({ installRoot }))).toBe("oldpin");
    });
  });

  it("reports the cosmetic/substantive split per skill", () => {
    const pin = writeTree(tmpDir("pin"), {
      "skills/core/styled/SKILL.md": skill("a—b"),
      "skills/core/styled/notes.md": skill("keep"),
    });
    const head = writeTree(tmpDir("head"), {
      "skills/core/styled/SKILL.md": skill("a, b"),
      "skills/core/styled/notes.md": skill("replace"),
    });
    const local = writeTree(tmpDir("local"), {
      "styled/SKILL.md": skill("a—b"),
      "styled/notes.md": skill("keep"),
    });
    const entry = bucketSkills(source, head, pin, local).skills[0];
    expect(entry).toMatchObject({
      name: "styled",
      bucket: "clean",
      cosmeticFiles: ["SKILL.md"],
      substantiveFiles: ["notes.md"],
      localEditedFiles: [],
    });
  });
});

describe("catalogue", () => {
  it("lists installable uninstalled skills and derives offered from the new bucket", () => {
    const source = makeSource();
    const head = writeTree(tmpDir("catalogue-head"), {
      "skills/engineering/declined/SKILL.md":
        "---\ndescription: 'Previously declined.'\n---\nbody\n",
      "skills/productivity/new-one/SKILL.md":
        "---\ndescription: >\n  A folded\n  description.\n---\nbody\n",
      "skills/engineering/promoted/SKILL.md":
        "---\ndescription: \"Promoted into engineering.\"\n---\nbody\n",
      "skills/in-progress/hidden/SKILL.md": "---\ndescription: Hidden\n---\nbody\n",
      "skills/engineering/not-a-skill/README.md": "not installable\n",
    });
    const pin = writeTree(tmpDir("catalogue-pin"), {
      "skills/engineering/declined/SKILL.md": "old\n",
      "skills/in-progress/promoted/SKILL.md": "old\n",
    });
    const local = writeTree(tmpDir("catalogue-local"), {
      "installed/SKILL.md": "already here\n",
    });
    const buckets = bucketSkills(source, head, pin, local);

    expect(
      catalogueSkills(source, head, local, buckets.skills),
    ).toEqual([
      {
        name: "declined",
        upstreamBucket: "engineering",
        description: "Previously declined.",
        offered: false,
      },
      {
        name: "new-one",
        upstreamBucket: "productivity",
        description: "A folded description.",
        offered: true,
      },
      {
        name: "promoted",
        upstreamBucket: "engineering",
        description: "Promoted into engineering.",
        offered: true,
      },
    ]);
  });

  it("returns an empty description for missing or unparsable frontmatter", () => {
    const root = tmpDir("frontmatter");
    expect(
      readFrontmatterDescription(
        writeTree(root, { "SKILL.md": "body without frontmatter\n" }),
      ),
    ).toBe("");
    expect(readFrontmatterDescription(path.join(root, "missing"))).toBe("");
    expect(
      readFrontmatterDescription(
        writeTree(tmpDir("frontmatter-no-description"), {
          "SKILL.md": "---\nname: x\n---\nbody\n",
        }),
      ),
    ).toBe("");
    expect(
      readFrontmatterDescription(
        writeTree(tmpDir("frontmatter-unclosed"), {
          "SKILL.md": "---\ndescription: never closes\nbody\n",
        }),
      ),
    ).toBe("");
  });
});

describe("unifiedDiff", () => {
  it("produces a patch with context and a header", () => {
    const patch = unifiedDiff("a/f", "b/f", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(patch).toContain("--- a/f");
    expect(patch).toContain("+++ b/f");
    expect(patch).toContain("-two");
    expect(patch).toContain("+TWO");
    expect(patch).toContain(" three");
  });

  it("is empty for identical text", () => {
    expect(unifiedDiff("a", "b", "same", "same")).toBe("");
  });
});

describe("diffTrees", () => {
  it("adds one standard split header per changed file", () => {
    const from = writeTree(tmpDir("from"), {
      "SKILL.md": "before\n",
      "notes.md": "old notes\n",
    });
    const to = writeTree(tmpDir("to"), {
      "SKILL.md": "after\n",
      "notes.md": "new notes\n",
    });

    const patch = diffTrees(from, to, "a/example", "b/example");
    expect(patch.match(/^diff --git .*$/gm)).toEqual([
      "diff --git a/SKILL.md b/SKILL.md",
      "diff --git a/notes.md b/notes.md",
    ]);
    expect(patch).toContain("diff --git a/SKILL.md b/SKILL.md\n--- a/example/SKILL.md");
    expect(patch).toContain("diff --git a/notes.md b/notes.md\n--- a/example/notes.md");
  });
});

describe("marker IO", () => {
  it("keeps the old marker when the atomic replacement fails", () => {
    const installRoot = writeTree(tmpDir("marker"), {
      ".test-skills-version": "old\n",
    });
    const source = makeSource({ installRoot });
    expect(() =>
      writeMarker(source, "new", {
        writeFileSync: (file, data, options) => fs.writeFileSync(file, data, options),
        renameSync: () => {
          throw new Error("rename failed");
        },
        unlinkSync: (file) => fs.unlinkSync(file),
      }),
    ).toThrow("rename failed");
    expect(readMarker(source)).toBe("old");
  });
});

describe("applySkills", () => {
  const snapshotFolder = (folder: string) =>
    Object.fromEntries(
      listFiles(folder).map((file) => [file, fs.readFileSync(path.join(folder, file), "utf8")]),
    );
  const snapshotFolderBytes = (folder: string) =>
    Object.fromEntries(
      listFiles(folder).map((file) => [file, fs.readFileSync(path.join(folder, file))]),
    );

  function scenario() {
    const headDir = writeTree(tmpDir("head"), {
      "skills/core/wanted/SKILL.md": skill("upstream version"),
      "skills/core/wanted/extra.md": "extra\n",
    });
    const installRoot = writeTree(tmpDir("local"), {
      "wanted/SKILL.md": skill("stale local version"),
      "my-own-skill/SKILL.md": skill("written by me"),
      ".test-skills-version": "aaaaaaaa\n",
    });
    const pinDir = writeTree(tmpDir("pin"), {
      "skills/core/wanted/SKILL.md": skill("stale local version"),
    });
    const source = makeSource({ installRoot });
    return { headDir, installRoot, pinDir, source };
  }

  function dirtyOnlyScenario() {
    const headFiles = {
      "skills/core/wanted/SKILL.md": skill("upstream unchanged"),
    };
    const headDir = writeTree(tmpDir("head-dirty-only"), headFiles);
    const pinDir = writeTree(tmpDir("pin-dirty-only"), headFiles);
    const installRoot = writeTree(tmpDir("local-dirty-only"), {
      "wanted/SKILL.md": skill("my local edit"),
      "wanted/local-notes.md": "keep this local file\n",
    });
    const source = makeSource({ installRoot });
    return { headDir, installRoot, pinDir, source };
  }

  it("installs an explicitly named skill and leaves the marker alone", () => {
    const { headDir, installRoot, pinDir, source } = scenario();
    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa" }),
      ["wanted"],
      false,
    );
    expect(result.applied).toEqual(["wanted"]);
    expect(result.failed).toEqual([]);
    expect(result.backups).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"), "utf8")).toContain(
      "upstream version",
    );
    expect(fs.existsSync(path.join(installRoot, "wanted/extra.md"))).toBe(true);
    expect(readMarker(source)).toBe("aaaaaaaa");
  });

  it("refuses a foreign name and never deletes the folder", () => {
    const { headDir, installRoot, pinDir, source } = scenario();
    const result = applySkills(makePrepared({ source, headDir, pinDir }), ["my-own-skill"], false);
    expect(result.applied).toEqual([]);
    expect(result.failed[0].name).toBe("my-own-skill");
    expect(result.failed[0].error).toMatch(/no folder in test/);
    expect(fs.readFileSync(path.join(installRoot, "my-own-skill/SKILL.md"), "utf8")).toContain(
      "written by me",
    );
  });

  it("refuses a path-shaped name", () => {
    const { headDir, pinDir, source } = scenario();
    for (const name of ["../escape", "core/wanted", ".hidden"]) {
      const result = applySkills(makePrepared({ source, headDir, pinDir }), [name], false);
      expect(result.applied).toEqual([]);
      expect(result.failed).toHaveLength(1);
    }
  });

  it("refuses a dirty conflict without overwriting its folder", () => {
    const { headDir, installRoot, source } = scenario();
    const pinDir = writeTree(tmpDir("conflict-pin"), {
      "skills/core/wanted/SKILL.md": skill("pinned version"),
    });
    const before = fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"), "utf8");
    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa" }),
      ["wanted"],
      false,
    );
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([
      {
        name: "wanted",
        error: expect.stringMatching(/local edits.*hand merge.*explicit override/i),
      },
    ]);
    expect(result.markerRefusal).toBeNull();
    expect(result.backups).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"), "utf8")).toBe(before);
  });

  it("overwrites a dirty conflict when explicitly allowed", () => {
    const { headDir, installRoot, source } = scenario();
    const pinDir = writeTree(tmpDir("conflict-pin-force"), {
      "skills/core/wanted/SKILL.md": skill("pinned version"),
    });
    const cacheRoot = tmpDir("cache-overwrite");
    const before = snapshotFolderBytes(path.join(installRoot, "wanted"));
    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa", cacheRoot }),
      ["wanted"],
      false,
      true,
    );
    expect(result.applied).toEqual(["wanted"]);
    expect(result.failed).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"), "utf8")).toContain(
      "upstream version",
    );
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]).toMatchObject({ name: "wanted" });
    expect(result.backups[0].path).toContain(path.join(cacheRoot, "backups", "wanted"));
    expect(result.backups[0].path).not.toContain(installRoot);
    expect(path.basename(result.backups[0].path)).toMatch(/^\d+-[0-9a-f-]{36}$/);
    expect(snapshotFolderBytes(result.backups[0].path)).toEqual(before);
  });

  it("refuses an explicitly named skill from a skipped upstream bucket", () => {
    const headDir = writeTree(tmpDir("head-skipped-apply"), {
      "skills/in-progress/wip/SKILL.md": skill("not ready"),
    });
    const installRoot = tmpDir("local-skipped-apply");
    const source = makeSource({ installRoot, skipBuckets: ["in-progress"] });
    const result = applySkills(
      makePrepared({ source, headDir, cacheRoot: tmpDir("cache-skipped-apply") }),
      ["wip"],
      false,
    );

    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([
      {
        name: "wip",
        error: expect.stringMatching(/in-progress.*skipBuckets.*refusing to install/i),
      },
    ]);
    expect(fs.existsSync(path.join(installRoot, "wip"))).toBe(false);
  });

  it("keeps the local folder when its backup cannot be saved", () => {
    const { headDir, installRoot, source } = scenario();
    const pinDir = writeTree(tmpDir("conflict-pin-backup-failure"), {
      "skills/core/wanted/SKILL.md": skill("pinned version"),
    });
    const cacheRoot = path.join(tmpDir("cache-backup-failure"), "cache-file");
    fs.writeFileSync(cacheRoot, "not a directory");
    const before = fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"));

    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa", cacheRoot }),
      ["wanted"],
      false,
      true,
    );

    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/backup|not a directory|ENOTDIR/i);
    expect(result.backups).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"))).toEqual(before);
  });

  it("never stores a backup inside the install root", () => {
    const { headDir, installRoot, source } = scenario();
    const pinDir = writeTree(tmpDir("conflict-pin-backup-location"), {
      "skills/core/wanted/SKILL.md": skill("pinned version"),
    });
    const before = fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"));

    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa", cacheRoot: installRoot }),
      ["wanted"],
      false,
      true,
    );

    expect(result.applied).toEqual([]);
    expect(result.failed[0].error).toMatch(/inside installRoot.*refusing/i);
    expect(result.backups).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"))).toEqual(before);
  });

  it("refuses a dirty-only skill without overwriting any local bytes", () => {
    const { headDir, installRoot, pinDir, source } = dirtyOnlyScenario();
    const before = snapshotFolder(path.join(installRoot, "wanted"));
    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa" }),
      ["wanted"],
      false,
    );
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([
      {
        name: "wanted",
        error: expect.stringMatching(/local edits.*hand merge.*explicit override/i),
      },
    ]);
    expect(snapshotFolder(path.join(installRoot, "wanted"))).toEqual(before);
  });

  it("overwrites a dirty-only skill when explicitly allowed", () => {
    const { headDir, installRoot, pinDir, source } = dirtyOnlyScenario();
    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa" }),
      ["wanted"],
      false,
      true,
    );
    expect(result.applied).toEqual(["wanted"]);
    expect(result.failed).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "wanted/SKILL.md"), "utf8")).toContain(
      "upstream unchanged",
    );
    expect(fs.existsSync(path.join(installRoot, "wanted/local-notes.md"))).toBe(false);
  });

  it("still applies clean and new skills without the override", () => {
    const headDir = writeTree(tmpDir("head-clean-new"), {
      "skills/core/clean/SKILL.md": skill("new clean version"),
      "skills/core/new/SKILL.md": skill("brand new"),
    });
    const pinDir = writeTree(tmpDir("pin-clean-new"), {
      "skills/core/clean/SKILL.md": skill("old clean version"),
    });
    const installRoot = writeTree(tmpDir("local-clean-new"), {
      "clean/SKILL.md": skill("old clean version"),
    });
    const source = makeSource({ installRoot });
    const result = applySkills(
      makePrepared({ source, headDir, pinDir, pinned: "aaaaaaaa" }),
      ["clean", "new"],
      false,
    );
    expect(result.applied).toEqual(["clean", "new"]);
    expect(result.failed).toEqual([]);
    expect(fs.readFileSync(path.join(installRoot, "clean/SKILL.md"), "utf8")).toContain(
      "new clean version",
    );
    expect(fs.readFileSync(path.join(installRoot, "new/SKILL.md"), "utf8")).toContain(
      "brand new",
    );
  });

  it("explicitly installs a catalogue-only declined skill", () => {
    const headDir = writeTree(tmpDir("head-catalogue-apply"), {
      "skills/core/declined/SKILL.md": skill("declined upstream"),
    });
    const pinDir = writeTree(tmpDir("pin-catalogue-apply"), {
      "skills/core/declined/SKILL.md": skill("declined upstream"),
    });
    const installRoot = tmpDir("local-catalogue-apply");
    const source = makeSource({ installRoot });
    const head = "c".repeat(40);

    const result = applySkills(
      makePrepared({ source, headDir, pinDir, head, pinned: "a".repeat(40) }),
      ["declined"],
      true,
    );

    expect(result).toMatchObject({ applied: ["declined"], failed: [], marker: head });
    expect(fs.readFileSync(path.join(installRoot, "declined/SKILL.md"), "utf8")).toContain(
      "declined upstream",
    );
    expect(readMarker(source)).toBe(head);
  });

  it("writes the marker only when every name landed", () => {
    const { headDir, pinDir, source } = scenario();
    const head = "b".repeat(40);

    const partial = applySkills(
      makePrepared({ source, headDir, pinDir, head, pinned: "aaaaaaaa" }),
      ["wanted", "my-own-skill"],
      true,
    );
    expect(partial.applied).toEqual(["wanted"]);
    expect(partial.marker).toBe("aaaaaaaa");
    expect(readMarker(source)).toBe("aaaaaaaa");

    const full = applySkills(
      makePrepared({ source, headDir, pinDir, head, pinned: "aaaaaaaa" }),
      ["wanted"],
      true,
    );
    expect(full.marker).toBe(head);
    expect(readMarker(source)).toBe(head);
  });

  it("never sweeps the install folder", () => {
    const { headDir, installRoot, pinDir, source } = scenario();
    const before = fs.readdirSync(installRoot).sort();
    applySkills(makePrepared({ source, headDir, pinDir }), ["wanted"], false);
    expect(fs.readdirSync(installRoot).sort()).toEqual(before);
  });
});

describe("prepare against a real repo", () => {
  it("materialises both trees, lists the commits, and diffs one skill", async () => {
    const { dir, shas } = makeGitRepo([
      {
        "skills/core/alpha/SKILL.md": skill("first—version"),
        "skills/core/beta/SKILL.md": skill("beta"),
      },
      {
        "skills/core/alpha/SKILL.md": skill("first, version"),
        "skills/core/beta/SKILL.md": skill("beta rewritten"),
        "skills/core/gamma/SKILL.md": skill("gamma"),
      },
    ]);
    const installRoot = writeTree(tmpDir("local"), {
      "alpha/SKILL.md": skill("first—version"),
      "beta/SKILL.md": skill("beta"),
      ".test-skills-version": `${shas[0]}\n`,
    });
    const source = makeSource({ url: dir, installRoot, ref: "main" });

    const cacheRoot = tmpDir("cache");
    const prepared = await prepare(source, cacheRoot, false);
    expect(prepared.pinned).toBe(shas[0]);
    expect(prepared.head).toBe(shas[1]);
    expect(prepared.commits).toHaveLength(1);
    expect(prepared.fetchedAt).toEqual(expect.any(Number));
    expect(readFetchedAt(path.join(cacheRoot, source.id, "repo"))).toBe(prepared.fetchedAt);
    expect(fs.existsSync(fetchedAtPath(path.join(cacheRoot, source.id, "repo")))).toBe(true);

    const status = statusFrom(prepared);
    const byName = Object.fromEntries(status.skills.map((entry) => [entry.name, entry]));
    expect(byName.alpha).toMatchObject({
      bucket: "clean",
      cosmeticFiles: ["SKILL.md"],
      substantiveFiles: [],
    });
    expect(byName.beta).toMatchObject({ bucket: "clean", substantiveFiles: ["SKILL.md"] });
    expect(byName.gamma).toMatchObject({ bucket: "new" });
    expect(status.foreign).toEqual([]);
    expect(status.catalogue).toEqual([
      {
        name: "gamma",
        upstreamBucket: "core",
        description: "",
        offered: true,
      },
    ]);
    expect(status.fetchedAt).toEqual(expect.any(Number));

    expect(diffSkill(prepared, "beta", "upstream")).toContain("+beta rewritten");
    expect(diffSkill(prepared, "beta", "local")).toBe("");

    const result = applySkills(prepared, ["gamma", "beta", "alpha"], true);
    expect(result.failed).toEqual([]);
    expect(result.marker).toBe(shas[1]);
    expect(fs.readFileSync(path.join(installRoot, "gamma/SKILL.md"), "utf8")).toContain("gamma");
  });
});

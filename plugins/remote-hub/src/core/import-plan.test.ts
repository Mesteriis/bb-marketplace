import { describe, expect, it } from "vitest";
import { candidateFromConfigEntry, candidateFromHost, planImport, type ImportLink, type ImportedFields } from "./import-plan.ts";
import type { ConfigEntry } from "./ssh-config.ts";

const entry = (over: Partial<ConfigEntry> = {}): ConfigEntry => ({ alias: "Build", hostName: "Build.Example.Test", port: 2222, user: "ci", identityFiles: ["/k/id_build"], flags: [], line: 1, ...over });

describe("candidateFromConfigEntry", () => {
  it("a resolved entry becomes an explicit destination with a lower-case host and its key", () => {
    const c = candidateFromConfigEntry(entry());
    expect(c).toMatchObject({ key: "build", name: "Build", resolved: true, flags: [], skip: null });
    expect(c.imported).toEqual({ host: "build.example.test", port: 2222, username: "ci", authType: "key", identityFile: "/k/id_build" });
  });

  it("without a HostName the alias is the host; without a key the agent is used; a relative key path is not taken", () => {
    expect(candidateFromConfigEntry(entry({ hostName: null, identityFiles: [] })).imported).toMatchObject({ host: "build", authType: "agent", identityFile: null });
    expect(candidateFromConfigEntry(entry({ identityFiles: ["relative/key"] })).imported).toMatchObject({ authType: "agent", identityFile: null });
  });

  it("several identity files import the first and say so", () => {
    const c = candidateFromConfigEntry(entry({ identityFiles: ["/k/a", "/k/b"] }));
    expect(c.imported.identityFile).toBe("/k/a");
    expect(c.flags).toEqual(["multiple-identities"]);
    expect(c.resolved).toBe(true);
  });

  it("an entry that depends on configuration stays an ALIAS with no port, user or key, and is not resolved", () => {
    for (const flag of ["proxy", "match", "tokens", "canonicalize", "host-key-alias"]) {
      const c = candidateFromConfigEntry(entry({ flags: [flag] }));
      expect(c.resolved, flag).toBe(false);
      expect(c.imported, flag).toEqual({ host: "Build", port: null, username: null, authType: "agent", identityFile: null });
    }
  });

  it("an entry that cannot be a profile is skipped with the reason", () => {
    const c = candidateFromConfigEntry(entry({ alias: "bad host", hostName: "x;rm" }));
    expect(c.skip).not.toBeNull();
  });
});

describe("candidateFromHost", () => {
  it("an /etc/hosts name is a plain agent-authenticated profile on that name", () => {
    expect(candidateFromHost({ name: "Web.Example.Test", address: "10.0.0.2", aliases: [] }).imported).toEqual({ host: "web.example.test", port: null, username: null, authType: "agent", identityFile: null });
  });
});

describe("planImport", () => {
  const a: ImportedFields = { host: "a.test", port: null, username: null, authType: "agent", identityFile: null };
  const link = (key: string, imported: ImportedFields, over: Partial<ImportLink> = {}): ImportLink => ({ profileId: "p-" + key, sourceId: "s", key, imported, resolved: true, flags: [], stale: false, ...over });
  const cand = (key: string, imported: ImportedFields, resolved = true) => ({ key, name: key, imported, resolved, flags: [], skip: null });

  it("creates what is new, and a second run over the same source changes nothing", () => {
    const first = planImport([cand("a", a)], [], () => null);
    expect(first.items.map((i) => i.action)).toEqual(["create"]);
    const second = planImport([cand("a", a)], [link("a", a)], () => a);
    expect(second.items.map((i) => i.action)).toEqual(["unchanged"]);
    expect(second.stale).toEqual([]);
  });

  it("updates when only the source changed, reports a conflict when both did, and keeps a local edit when the source did not", () => {
    const changed = { ...a, host: "new.test" };
    expect(planImport([cand("a", changed)], [link("a", a)], () => a).items[0]?.action).toBe("update");
    expect(planImport([cand("a", changed)], [link("a", a)], () => ({ ...a, host: "mine.test" })).items[0]?.action).toBe("conflict");
    expect(planImport([cand("a", a)], [link("a", a)], () => ({ ...a, host: "mine.test" })).items[0]?.action).toBe("unchanged");
  });

  it("a profile deleted here is not resurrected; an entry the source dropped is reported stale once", () => {
    expect(planImport([cand("a", a)], [link("a", a)], () => null).items[0]?.action).toBe("deleted-locally");
    const gone = planImport([], [link("a", a), link("b", a, { stale: true })], () => a);
    expect(gone.stale.map((l) => l.key)).toEqual(["a"]);
  });

  it("a candidate that cannot be a profile is skipped, never created", () => {
    expect(planImport([{ ...cand("a", a), skip: "bad" }], [], () => null).items[0]?.action).toBe("skip");
  });

  it("a change in whether the entry is resolved is an update, so a profile never keeps a stale destination", () => {
    expect(planImport([cand("a", a, false)], [link("a", a, { resolved: true })], () => a).items[0]?.action).toBe("update");
  });
});

import { describe, expect, it } from "vitest";
import type { Profile, ProfileFields } from "./profile.ts";
import { ProfileBook, ProfileError, type ProfileStore } from "./profile-book.ts";

class MemoryStore implements ProfileStore {
  readonly rows = new Map<string, Profile>();
  failWrites = false;
  all(): Profile[] {
    return [...this.rows.values()];
  }
  get(id: string): Profile | null {
    return this.rows.get(id) ?? null;
  }
  put(profile: Profile): void {
    if (this.failWrites) throw Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_READONLY" });
    this.rows.set(profile.id, profile);
  }
  remove(id: string): boolean {
    return this.rows.delete(id);
  }
}

const FIELDS: ProfileFields = {
  name: "build",
  protocol: "ssh",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "build.example.test",
  port: null,
  username: "ci",
  domain: null,
  authType: "agent",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
};

function book(onHistoryError?: (code: string) => void) {
  const store = new MemoryStore();
  let tick = 0;
  let n = 0;
  const instance = new ProfileBook({
    store,
    now: () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    onHistoryError,
  });
  return { store, instance };
}

describe("ProfileBook.save", () => {
  it("creates a profile with an id, the local execution host and equal timestamps", () => {
    const { instance, store } = book();
    const saved = instance.save({ fields: FIELDS });
    expect(saved).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      executionHostId: "local",
      origin: "manual",
      createdAt: "2026-11-18T10:00:00.000Z",
      updatedAt: "2026-11-18T10:00:00.000Z",
      lastOpenedAt: null,
      recentErrors: [],
      name: "build",
    });
    expect(store.all()).toEqual([saved]);
  });

  it("an update changes the fields and updatedAt but keeps id, createdAt and history", () => {
    const { instance } = book();
    const first = instance.save({ fields: FIELDS });
    instance.recordOpen(first.id);
    const updated = instance.save({ id: first.id, fields: { ...FIELDS, name: "renamed", favorite: true } });
    expect(updated).toMatchObject({ id: first.id, name: "renamed", favorite: true, createdAt: first.createdAt });
    expect(updated.updatedAt).toBe("2026-11-18T10:00:02.000Z");
    expect(updated.lastOpenedAt).toBe("2026-11-18T10:00:01.000Z");
  });

  it("updating an id that does not exist is not_found, and invalid fields are refused", () => {
    const { instance } = book();
    expect(() => instance.save({ id: "11111111-2222-4333-8444-555555555555", fields: FIELDS })).toThrow(ProfileError);
    expect(() => instance.save({ fields: { ...FIELDS, host: "-bad" } })).toThrow();
    expect(() => instance.save({ fields: { ...FIELDS, password: "x" } as never })).toThrow();
  });

  it("refuses a credentialRef for another execution host", () => {
    const { instance } = book();
    const ref = "rh-cred:v1:other-mac:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
    expect(() => instance.save({ fields: { ...FIELDS, authType: "password", credentialRef: ref } })).toThrow();
  });
});

describe("ProfileBook.duplicate and remove", () => {
  it("duplicates under a new id with a copy name, no history, no favourite and no credential", () => {
    const { instance } = book();
    const ref = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
    const original = instance.save({ fields: { ...FIELDS, favorite: true, authType: "password", credentialRef: ref } });
    instance.recordOpen(original.id);
    const copy = instance.duplicate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({ name: "build (copy)", favorite: false, credentialRef: null, lastOpenedAt: null, recentErrors: [] });
  });

  it("a duplicate of a 100-character name still fits the limit", () => {
    const { instance } = book();
    const original = instance.save({ fields: { ...FIELDS, name: "n".repeat(100) } });
    expect(instance.duplicate(original.id).name).toHaveLength(100);
    expect(instance.duplicate(original.id).name.endsWith(" (copy)")).toBe(true);
  });

  it("remove reports whether something was deleted", () => {
    const { instance } = book();
    const saved = instance.save({ fields: FIELDS });
    expect(instance.remove(saved.id)).toBe(true);
    expect(instance.remove(saved.id)).toBe(false);
    expect(instance.list()).toEqual([]);
  });
});

describe("ProfileBook.track", () => {
  it("records the open time when the run resolves and returns its value", async () => {
    const { instance } = book();
    const saved = instance.save({ fields: FIELDS });
    await expect(instance.track(saved.id, async () => 42)).resolves.toBe(42);
    expect(instance.list()[0]?.lastOpenedAt).toBe("2026-11-18T10:00:01.000Z");
  });

  it("records only the failure CODE, never the message, keeps the newest five, and rethrows", async () => {
    const { instance } = book();
    const saved = instance.save({ fields: FIELDS });
    for (let i = 0; i < 6; i++) {
      const failure = Object.assign(new Error("secret-looking text hunter2"), { code: "not_found" + i });
      await expect(instance.track(saved.id, async () => Promise.reject(failure))).rejects.toBe(failure);
    }
    const errors = instance.list()[0]?.recentErrors ?? [];
    expect(errors.map((e) => e.code)).toEqual(["not_found1", "not_found2", "not_found3", "not_found4", "not_found5"]);
    expect(JSON.stringify(errors)).not.toContain("hunter2");
  });

  it("a failure without a code is open_failed, and a run without a profile id just runs", async () => {
    const { instance } = book();
    const saved = instance.save({ fields: FIELDS });
    await expect(instance.track(saved.id, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(instance.list()[0]?.recentErrors.map((e) => e.code)).toEqual(["open_failed"]);
    await expect(instance.track(undefined, async () => "ok")).resolves.toBe("ok");
  });

  it("a profile deleted while the open ran does not break the open", async () => {
    const { instance } = book();
    const saved = instance.save({ fields: FIELDS });
    await expect(
      instance.track(saved.id, async () => {
        instance.remove(saved.id);
        return "opened";
      }),
    ).resolves.toBe("opened");
  });
});

describe("ProfileBook.track when the history cannot be written (P2)", () => {
  it("a successful open still returns its value, and the failure is reported by code only", async () => {
    const reported: string[] = [];
    const { instance, store } = book((code) => reported.push(code));
    const saved = instance.save({ fields: FIELDS });
    store.failWrites = true;
    await expect(instance.track(saved.id, async () => "handle")).resolves.toBe("handle");
    expect(reported).toEqual(["SQLITE_READONLY"]);
  });

  it("a failed open rejects with the ORIGINAL error even when recording it fails", async () => {
    const reported: string[] = [];
    const { instance, store } = book((code) => reported.push(code));
    const saved = instance.save({ fields: FIELDS });
    store.failWrites = true;
    const original = Object.assign(new Error("helper_unavailable"), { code: "not_found" });
    await expect(instance.track(saved.id, async () => Promise.reject(original))).rejects.toBe(original);
    expect(reported).toEqual(["SQLITE_READONLY"]);
  });
});

describe("ProfileBook history codes and update (P6, P7)", () => {
  it("only a code-shaped string is kept; anything else becomes unknown", async () => {
    const { instance } = book();
    const saved = instance.save({ fields: FIELDS });
    for (const code of ["Has Space", "x".repeat(65), "UPPER", "pass:hunter2"]) {
      await expect(instance.track(saved.id, async () => Promise.reject(Object.assign(new Error("e"), { code })))).rejects.toThrow();
    }
    await expect(instance.track(saved.id, async () => Promise.reject(Object.assign(new Error("e"), { code: "auth_failed_2" })))).rejects.toThrow();
    expect(instance.list()[0]?.recentErrors.map((e) => e.code)).toEqual(["unknown", "unknown", "unknown", "unknown", "auth_failed_2"].slice(-5));
  });

  it("an update keeps the stored executionHostId", () => {
    const { instance, store } = book();
    const saved = instance.save({ fields: FIELDS });
    store.rows.set(saved.id, { ...saved, executionHostId: "other-mac" });
    expect(instance.save({ id: saved.id, fields: { ...FIELDS, name: "again" } }).executionHostId).toBe("other-mac");
  });
});

import { describe, expect, it } from "vitest";
import { filterActionParts, filterFor, filterMatches, validateFilter, type FilterActions, type MailFilter } from "./mail-filters.ts";

const actions = (overrides: Partial<FilterActions> = {}): FilterActions => ({ move: "none", folder: null, markRead: true, flag: false, ...overrides });

const filter = (overrides: Partial<MailFilter> = {}): MailFilter => ({
  id: "f_1",
  name: "Invented newsletters",
  enabled: true,
  match: { domains: ["news.example.com"] },
  actions: actions(),
  ...overrides,
});

const row = (overrides: Partial<Parameters<typeof filterMatches>[1]> = {}) => ({
  accountId: "acc_1",
  fromAddress: "digest@news.example.com",
  listId: null,
  subject: "Invented weekly digest",
  ...overrides,
});

describe("validateFilter", () => {
  const base = { name: "Invented", match: { from: ["ana@example.com"] }, actions: actions() };

  it("takes a name, something to match and something to do", () => {
    expect(validateFilter(base)).toEqual({ ok: true });
    expect(validateFilter({ ...base, name: " " })).toEqual({ ok: false, reason: "A filter needs a name of up to 80 characters" });
    expect(validateFilter({ ...base, match: {} })).toEqual({
      ok: false,
      reason: "A filter needs a sender, domain, list or subject words to match",
    });
    expect(validateFilter({ ...base, match: { accounts: ["acc_1"] } }).ok).toBe(false);
    expect(validateFilter({ ...base, actions: actions({ markRead: false }) })).toEqual({ ok: false, reason: "A filter needs something to do" });
    expect(validateFilter({ ...base, match: { from: ["not an address"] } })).toEqual({ ok: false, reason: "An address is not valid" });
    expect(validateFilter({ ...base, match: { subjectWords: ["two words"] } }).ok).toBe(false);
  });

  it("moves to a folder only with one account chosen and a path", () => {
    const move = actions({ move: "folder", folder: "Lists/Invented", markRead: false });
    expect(validateFilter({ ...base, actions: move })).toEqual({ ok: false, reason: "Moving to a folder needs one account chosen" });
    expect(validateFilter({ ...base, match: { ...base.match, accounts: ["acc_1", "acc_2"] }, actions: move }).ok).toBe(false);
    expect(validateFilter({ ...base, match: { ...base.match, accounts: ["acc_1"] }, actions: move })).toEqual({ ok: true });
    expect(validateFilter({ ...base, match: { ...base.match, accounts: ["acc_1"] }, actions: { ...move, folder: null } })).toEqual({
      ok: false,
      reason: "Choose a folder to move to",
    });
    expect(validateFilter({ ...base, match: { ...base.match, accounts: ["acc_1"] }, actions: { ...move, folder: "A\r\nB" } }).ok).toBe(false);
    expect(validateFilter({ ...base, actions: actions({ move: "archive", folder: "Lists" }) }).ok).toBe(false);
    expect(validateFilter({ ...base, actions: actions({ move: "trash", markRead: false }) })).toEqual({ ok: true });
  });
});

describe("filterMatches", () => {
  it("matches every given field, a domain with its subdomains, whole subject words in any case", () => {
    expect(filterMatches(filter(), row())).toBe(true);
    expect(filterMatches(filter({ match: { domains: ["example.com"] } }), row())).toBe(true);
    expect(filterMatches(filter({ match: { domains: ["ample.com"] } }), row())).toBe(false);
    expect(filterMatches(filter({ match: { from: ["DIGEST@news.example.com"] } }), row())).toBe(true);
    expect(filterMatches(filter({ match: { subjectWords: ["WEEKLY", "digest"] } }), row())).toBe(true);
    expect(filterMatches(filter({ match: { subjectWords: ["week"] } }), row())).toBe(false);
    expect(filterMatches(filter({ match: { list: "updates.example.com" } }), row({ listId: "updates.example.com" }))).toBe(true);
    expect(filterMatches(filter({ match: { list: "updates.example.com" } }), row())).toBe(false);
    expect(filterMatches(filter({ match: { domains: ["news.example.com"], subjectWords: ["invoice"] } }), row())).toBe(false);
  });

  it("keeps to its accounts, and never sorts when off or when the sender check failed", () => {
    expect(filterMatches(filter({ match: { domains: ["news.example.com"], accounts: ["acc_2"] } }), row())).toBe(false);
    expect(filterMatches(filter({ match: { domains: ["news.example.com"], accounts: ["acc_1"] } }), row())).toBe(true);
    expect(filterMatches(filter({ enabled: false }), row())).toBe(false);
    expect(filterMatches(filter(), row({ senderFailed: true }))).toBe(false);
    expect(filterMatches(filter({ match: {} }), row())).toBe(false);
  });
});

describe("filterFor", () => {
  it("is the first matching filter in the list", () => {
    const filters = [
      filter({ id: "off", enabled: false }),
      filter({ id: "other", match: { from: ["someone@example.org"] } }),
      filter({ id: "first" }),
      filter({ id: "second" }),
    ];
    expect(filterFor(filters, row())?.id).toBe("first");
    expect(filterFor(filters, row({ fromAddress: "nobody@example.net" }))).toBeNull();
  });
});

describe("filterActionParts", () => {
  it("lists the move first, then read and flag", () => {
    expect(filterActionParts(actions({ move: "folder", folder: "Lists", flag: true }))).toEqual(["folder", "read", "flag"]);
    expect(filterActionParts(actions({ markRead: false, flag: true }))).toEqual(["flag"]);
  });
});

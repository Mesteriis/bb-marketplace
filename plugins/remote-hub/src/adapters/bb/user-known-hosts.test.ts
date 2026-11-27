import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { knownHostsTextHolds } from "./user-known-hosts.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA000000000000000000000000000000000000000000";
const hashed = (name: string): string => {
  const salt = Buffer.from("0123456789abcdefghij");
  return `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(name).digest("base64")}`;
};

test("a plain line names the host exactly, with the port in brackets off port 22", () => {
  const text = `# comment\nbox.test,10.0.0.5 ${KEY}\n[alt.test]:2222 ${KEY}\n`;
  expect(knownHostsTextHolds(text, "box.test", 22)).toBe(true);
  expect(knownHostsTextHolds(text, "BOX.test", null)).toBe(true);
  expect(knownHostsTextHolds(text, "10.0.0.5", 22)).toBe(true);
  expect(knownHostsTextHolds(text, "alt.test", 2222)).toBe(true);
  expect(knownHostsTextHolds(text, "alt.test", 22)).toBe(false);
  expect(knownHostsTextHolds(text, "box.test", 2222)).toBe(false);
  expect(knownHostsTextHolds(text, "other.test", 22)).toBe(false);
});

test("a hashed line is matched by its HMAC, and markers and patterns never count", () => {
  const text = `${hashed("box.test")} ${KEY}\n${hashed("[alt.test]:2222")} ${KEY}\n@revoked gone.test ${KEY}\n*.wild.test ${KEY}\n`;
  expect(knownHostsTextHolds(text, "box.test", 22)).toBe(true);
  expect(knownHostsTextHolds(text, "alt.test", 2222)).toBe(true);
  expect(knownHostsTextHolds(text, "alt.test", 22)).toBe(false);
  expect(knownHostsTextHolds(text, "gone.test", 22)).toBe(false);
  expect(knownHostsTextHolds(text, "a.wild.test", 22)).toBe(false);
  expect(knownHostsTextHolds("", "box.test", 22)).toBe(false);
});

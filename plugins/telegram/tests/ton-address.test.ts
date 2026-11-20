import { expect, test } from "vitest";
import { tonAddress, telegramTonWalletLink } from "../src/core/ton-address.ts";

const bounceable = "EQD6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-kOr";
const nonBounceable = "UQD6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-h5u";
const testnet = "kQD6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vgh";
const invalidTag = "AQD6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-vr6-hDS";

test.each([bounceable, nonBounceable, testnet, bounceable.replaceAll("-", "+"), "-1:" + "fa".repeat(32)])(
  "preserves valid TON recipient flags and encodes only the address",
  (address) => {
    expect(tonAddress(" " + address + " ")).toBe(address);
    const url = new URL(telegramTonWalletLink(address)!);
    expect(url.protocol).toBe("tg:");
    expect(url.hostname).toBe("sendgrams");
    expect([...url.searchParams]).toEqual([["to", address]]);
  },
);

test("rejects TON addresses with invalid checksums, tags or injected link fields", () => {
  for (const candidate of [bounceable.slice(0, -1) + "A", invalidTag, bounceable + "?amount=5", "2147483648:" + "fa".repeat(32)]) {
    expect(telegramTonWalletLink(candidate)).toBeUndefined();
  }
});

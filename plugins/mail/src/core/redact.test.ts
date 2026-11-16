import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER,
  agentSearchRefusal,
  hiddenNote,
  maskSnippetTail,
  newRestoreTag,
  redactSecrets,
  restoreSecrets,
} from "./redact.ts";

// Every secret here is made up. Cyrillic is written as \u escapes.
const RU_CODE_WORD = "\u041a\u043e\u0434"; // "Kod" (code), capitalised
const RU_YOUR_CODE = "\u0412\u0430\u0448 \u043a\u043e\u0434 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u044f"; // "your confirmation code"
const RU_PASSWORD = "\u043f\u0430\u0440\u043e\u043b\u044c"; // "password"
const RU_KEY = "\u043a\u043b\u044e\u0447"; // "key"
const RU_CODEX = "\u043a\u043e\u0434\u0435\u043a\u0441"; // "codex" (a law code), not a code word
const RU_CARD = "\u043a\u0430\u0440\u0442\u0430"; // "card"

const FAKE_GHP = "ghp_" + "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiJpbnZlbnRlZCJ9" + "." + "c2lnbmF0dXJlLWludmVudGVk";
// The PEM armour lines are joined at run time, so no key-format literal sits in the source.
const PEM_LABEL = ["PRIVATE", "KEY"].join(" ");
const FAKE_PEM = [
  `-----BEGIN ${PEM_LABEL}-----`,
  "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAinvented",
  "aW52ZW50ZWQga2V5IG1hdGVyaWFsIG9ubHk=",
  `-----END ${PEM_LABEL}-----`,
].join("\n");
const FAKE_UUID = "3f2b8c1e-9a4d-4e7f-b6a0-1c2d3e4f5a6b";
const FAKE_HEX40 = "0123456789abcdef0123456789abcdef01234567";
const FAKE_HEX32 = "fedcba9876543210fedcba9876543210";
const TEST_CARD = "4111 1111 1111 1111";

const hidden = (text: string) => redactSecrets(text).text;
const counts = (text: string) => redactSecrets(text).counts;

describe("redactSecrets: one-time codes", () => {
  it("hides codes near a code word, English and Russian", () => {
    expect(hidden("Your verification code is 482913.")).toBe(`Your verification code is ${PLACEHOLDER.code}.`);
    expect(hidden(`${RU_YOUR_CODE}: 7730`)).toBe(`${RU_YOUR_CODE}: ${PLACEHOLDER.code}`);
    expect(hidden(`${RU_CODE_WORD} 5521`)).toBe(`${RU_CODE_WORD} ${PLACEHOLDER.code}`);
    expect(hidden("Use OTP 90817 to sign in")).toBe(`Use OTP ${PLACEHOLDER.code} to sign in`);
    expect(hidden("Your PIN: 4402")).not.toContain("4402");
    expect(hidden("Security code AB12CD for your login")).toBe(`Security code ${PLACEHOLDER.code} for your login`);
  });

  it("hides a value on the line after the label", () => {
    expect(hidden("Your code:\n482913\nThanks")).toBe(`Your code:\n${PLACEHOLDER.code}\nThanks`);
  });

  it("hides a code under its label across blank lines and CRLF (HTML paragraphs, headings)", () => {
    const html = `Enter this code to finish signing in:\n\n604185\n\nThanks`;
    expect(hidden(html)).toBe(`Enter this code to finish signing in:\n\n${PLACEHOLDER.code}\n\nThanks`);
    expect(hidden("Your code:\n\n518327\n")).toBe(`Your code:\n\n${PLACEHOLDER.code}\n`);
    expect(hidden(`${RU_YOUR_CODE}:\r\n\r\n927460\r\n`)).toBe(`${RU_YOUR_CODE}:\r\n\r\n${PLACEHOLDER.code}\r\n`);
    expect(hidden("Your verification code\n\nUse it within ten minutes.\n\n604185")).toBe(
      `Your verification code\n\nUse it within ten minutes.\n\n${PLACEHOLDER.code}`,
    );
    expect(hidden("Your code:\n\n482 913")).toBe(`Your code:\n\n${PLACEHOLDER.code}`);
    expect(hidden("Your code:\n12 34 56\n")).toBe(`Your code:\n${PLACEHOLDER.code}\n`);
  });

  it("does not reach past two non-empty lines or 200 characters", () => {
    const far = "Your code:\n\nLine one.\n\nLine two.\n\n604185";
    expect(hidden(far)).toBe(far);
    const long = `Your code:\n\n${"\n".repeat(10)}${" ".repeat(220)}\n604185`;
    expect(hidden(long)).toBe(long);
    expect(hidden("Room 12 34 56")).toBe("Room 12 34 56");
  });

  it("hides split and prefixed codes", () => {
    expect(hidden("Your code is 123 456")).toBe(`Your code is ${PLACEHOLDER.code}`);
    expect(hidden("Your code is 123-456")).toBe(`Your code is ${PLACEHOLDER.code}`);
    expect(hidden("G-123456 is your verification code")).toBe(`${PLACEHOLDER.code} is your verification code`);
  });

  it("uses the subject as context for a code alone on its line", () => {
    const body = "Hello,\n\n663201\n\nThe team";
    expect(redactSecrets(body).text).toBe(body);
    expect(redactSecrets(body, { context: "Your sign-in code" }).text).toBe(`Hello,\n\n${PLACEHOLDER.code}\n\nThe team`);
    expect(redactSecrets(body, { context: "Weekly garden notes" }).text).toBe(body);
  });

  it("leaves dates, times, amounts, phones and years near code words", () => {
    for (const text of [
      "Confirm your visit on 2026-11-16.",
      "Confirm your visit on 16.11.2026.",
      "Confirm by 16/11 please",
      "Confirm by 10:30 tomorrow",
      "Confirm the payment of 1,250.00",
      "Confirm by phone +44 20 7946 0958",
      "Verification email\nSee you in 2026",
      "Your code arrives soon. Call 020 7946 0958 or write to code1234@example.com",
    ]) {
      expect(hidden(text), text).toBe(text);
    }
  });

  it("matches code, PIN and the Russian code word as whole words only", () => {
    expect(hidden(`${RU_CODEX} 1234`)).toBe(`${RU_CODEX} 1234`);
    expect(hidden("codec 1234")).toBe("codec 1234");
    expect(hidden("pinned 1234")).toBe("pinned 1234");
    expect(hidden("A number 482913 and nothing else")).toBe("A number 482913 and nothing else");
  });
});

describe("redactSecrets: credentials", () => {
  it("hides the value after a label on the same or the next line", () => {
    expect(hidden("Password: Hunter-22x")).toBe(`Password: ${PLACEHOLDER.credential}`);
    expect(hidden("Your password is s3cr3t-Value.")).toBe(`Your password is ${PLACEHOLDER.credential}.`);
    expect(hidden(`${RU_PASSWORD}: Qwerty-123`)).toBe(`${RU_PASSWORD}: ${PLACEHOLDER.credential}`);
    expect(hidden("passwd = abc123")).not.toContain("abc123");
    expect(hidden("Password:\n  Invented-Value-9\nBye")).toBe(`Password:\n  ${PLACEHOLDER.credential}\nBye`);
  });

  it("hides values after the key, token and secret labels", () => {
    expect(hidden("API key: inventedvalue42")).not.toContain("inventedvalue42");
    expect(hidden("token = invented-token-value")).not.toContain("invented-token-value");
    expect(hidden("Secret: plain-words-here")).not.toContain("plain-words-here");
    expect(hidden(`${RU_KEY}: invented77`)).not.toContain("invented77");
  });

  it("hides grouped app passwords", () => {
    expect(hidden("Your app password: abcd efgh ijkl mnop")).toBe(`Your app password: ${PLACEHOLDER.credential}`);
    expect(hidden("App password\nabcd efgh ijkl mnop\n")).toBe(`App password\n${PLACEHOLDER.credential}\n`);
    expect(hidden("We have more time this week")).toBe("We have more time this week");
  });
});

describe("redactSecrets: tokens", () => {
  it("hides known prefixes, JWTs, PEM blocks, hex and UUIDs", () => {
    expect(hidden(`token ${FAKE_GHP} here`)).not.toContain(FAKE_GHP.slice(4));
    expect(hidden(`Bearer ${FAKE_JWT}`)).toBe(`Bearer ${PLACEHOLDER.token}`);
    expect(hidden(`Key below\n${FAKE_PEM}\nEnd`)).toBe(`Key below\n${PLACEHOLDER.token}\nEnd`);
    expect(hidden(`commit ${FAKE_HEX40}`)).toBe(`commit ${PLACEHOLDER.token}`);
    expect(hidden(`ref ${FAKE_HEX32}`)).toBe(`ref ${PLACEHOLDER.token}`);
    expect(hidden(`id ${FAKE_UUID}`)).toBe(`id ${PLACEHOLDER.token}`);
    expect(hidden("b".repeat(40))).toBe("b".repeat(40));
    expect(hidden("sk-" + "AbCdEfGhIjKlMnOpQrStUv12")).toBe(PLACEHOLDER.token);
    expect(hidden("AKIA" + "ABCDEFGHIJKLMNOP")).toBe(PLACEHOLDER.token);
    expect(hidden("session Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7")).toBe(`session ${PLACEHOLDER.token}`);
  });

  it("needs a boundary and 20 characters after sk-", () => {
    expect(hidden("pip install sk-learn")).toBe("pip install sk-learn");
    expect(hidden("task-AbCdEfGhIjKlMnOpQrStUv12")).toBe("task-AbCdEfGhIjKlMnOpQrStUv12");
    expect(hidden("sk-short123")).toBe("sk-short123");
  });

  it("hides URL secrets and keeps the host and the rest of the URL", () => {
    expect(hidden(`Reset: https://example.com/reset/${FAKE_UUID}?lang=en`)).toBe(
      `Reset: https://example.com/reset/${PLACEHOLDER.token}?lang=en`,
    );
    expect(hidden("https://example.com/auth?mode=reset&oobCode=Invented0123value&lang=en")).toBe(
      `https://example.com/auth?mode=reset&oobCode=${PLACEHOLDER.token}&lang=en`,
    );
    expect(hidden("https://example.org/users/password/edit?reset_password_token=invented42")).toBe(
      `https://example.org/users/password/edit?reset_password_token=${PLACEHOLDER.token}`,
    );
    expect(hidden(`https://example.org/commit/${FAKE_HEX40}/files`)).toBe(
      `https://example.org/commit/${PLACEHOLDER.token}/files`,
    );
    expect(hidden("https://example.org/m?t=AbCdEfGh12345678xy")).toBe(`https://example.org/m?t=${PLACEHOLDER.token}`);
    expect(hidden("https://example.org/m?t=short")).toBe("https://example.org/m?t=short");
    expect(hidden("https://example.org/m#access_token=invented&state=1")).toBe(
      `https://example.org/m#access_token=${PLACEHOLDER.token}&state=1`,
    );
    expect(hidden("https://example.org/m?myApiKey=inv&page=2")).toBe(`https://example.org/m?myApiKey=${PLACEHOLDER.token}&page=2`);
    expect(hidden("See https://example.org/docs/getting-started.")).toBe("See https://example.org/docs/getting-started.");
  });

  it("leaves e-mail addresses alone", () => {
    const address = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7@example.com";
    expect(hidden(`Write to ${address}`)).toBe(`Write to ${address}`);
  });
});

describe("redactSecrets: cards", () => {
  it("hides a Luhn-valid card number in card-like groups or one run", () => {
    expect(hidden(`Card ${TEST_CARD} expires`)).toBe(`Card ${PLACEHOLDER.card} expires`);
    expect(hidden("Paid with 4111-1111-1111-1111")).toBe(`Paid with ${PLACEHOLDER.card}`);
    expect(hidden("Paid with 4111111111111111")).toBe(`Paid with ${PLACEHOLDER.card}`);
    expect(hidden("Amex 3782 822463 10005")).toBe(`Amex ${PLACEHOLDER.card}`);
  });

  it("hides any grouping near a card label, and not without one", () => {
    expect(hidden(`${RU_CARD} 41 1111 1111 1111 11`)).toBe(`${RU_CARD} ${PLACEHOLDER.card}`);
    expect(hidden("Ref 41 1111 1111 1111 11")).toBe("Ref 41 1111 1111 1111 11");
  });

  it("leaves an IMEI, a tracking number and a failed Luhn check", () => {
    expect(hidden("IMEI 490154203237518")).toBe("IMEI 490154203237518");
    expect(hidden("Tracking 1Z9999W99999999999")).toBe("Tracking 1Z9999W99999999999");
    expect(hidden("Card 4111 1111 1111 1112")).toBe("Card 4111 1111 1111 1112");
  });

  it("hides a CVV only near a card or a CVV word", () => {
    expect(hidden(`Card ${TEST_CARD}, CVV 123`)).toBe(`Card ${PLACEHOLDER.card}, CVV ${PLACEHOLDER.card}`);
    expect(hidden("CVC: 4321")).toBe(`CVC: ${PLACEHOLDER.card}`);
    expect(hidden(`Card ${TEST_CARD}. ${"Lorem ipsum ".repeat(10)}room 123`)).toContain("room 123");
    expect(hidden("Table for 123 guests")).toBe("Table for 123 guests");
  });
});

describe("redactSecrets: counts, placeholders and restore", () => {
  it("counts each hidden value by kind", () => {
    expect(counts(`code 482913, card ${TEST_CARD}, ${FAKE_JWT}, password: Inv-1`)).toEqual({
      code: 1,
      credential: 1,
      token: 1,
      card: 1,
    });
    expect(redactSecrets("Nothing here").counts).toEqual({ code: 0, credential: 0, token: 0, card: 0 });
    expect(redactSecrets("Nothing here").restore).toBeNull();
  });

  it("numbers and tags placeholders with restore, and restores only its own tag", () => {
    const source = `Code 482913 and ${FAKE_JWT} and code 990011`;
    const r = redactSecrets(source, { restore: true, tag: "k3f9" });
    expect(r.text).toBe("Code [hidden one-time code 1 k3f9] and [hidden token 1 k3f9] and code [hidden one-time code 2 k3f9]");
    expect(r.restore!.get("[hidden token 1 k3f9]")).toBe(FAKE_JWT);
    expect(restoreSecrets(r.text, r.restore!, "k3f9")).toEqual({ text: source, unknown: 0, missing: 0 });

    const edited = "Code [hidden one-time code 1 k3f9], typed [hidden token 1], invented [hidden token 7 k3f9]";
    expect(restoreSecrets(edited, r.restore!, "k3f9")).toEqual({
      text: "Code 482913, typed [hidden token 1], invented [hidden token 7 k3f9]",
      unknown: 2,
      missing: 2,
    });
  });

  it("reuses one placeholder for a repeated value", () => {
    const r = redactSecrets("code 482913, again code 482913", { restore: true, tag: "ab12" });
    expect(r.text).toBe("code [hidden one-time code 1 ab12], again code [hidden one-time code 1 ab12]");
    expect(r.counts.code).toBe(2);
  });

  it("writes the hidden note", () => {
    expect(hiddenNote({ code: 2, credential: 0, token: 1, card: 0 })).toBe("Hidden by Makosh Mail: 2 one-time codes, 1 token.");
    expect(hiddenNote({ code: 0, credential: 1, token: 0, card: 3 })).toBe("Hidden by Makosh Mail: 1 password, 3 card numbers.");
    expect(hiddenNote({ code: 0, credential: 0, token: 0, card: 0 })).toBeNull();
  });

  it("draws a restore tag absent from every part", () => {
    const draws = [[0, 0, 0, 0], [1, 2, 3, 4]];
    const random = (size: number) => Uint8Array.from(draws.shift()!.slice(0, size));
    expect(newRestoreTag(random, ["contains aaaa here"])).toBe("bcde");
    const tag = newRestoreTag(undefined, ["x"]);
    expect(tag).toMatch(/^[a-z0-9]{4}$/);
  });
});

describe("maskSnippetTail", () => {
  it("masks a digit or token run cut at the end", () => {
    expect(maskSnippetTail("Your order is ready, ref 1234", "Order").text).toBe(`Your order is ready, ref ${PLACEHOLDER.code}`);
    expect(maskSnippetTail("Open the link AbCdEfGh12345678ij", "Hi").text).toBe(`Open the link ${PLACEHOLDER.token}`);
    expect(maskSnippetTail("Meet at noon on day 12", "Hi").text).toBe("Meet at noon on day 12");
    expect(maskSnippetTail("Open the link AbCdEfGh12345678ij", "Hi").counts.token).toBe(1);
  });

  it("with a cut length, masks the tail of a cut snippet only", () => {
    expect(maskSnippetTail("Room 1234", "Hi", 200).text).toBe("Room 1234");
    expect(maskSnippetTail(`${"a ".repeat(98)}x 1234`, "Hi", 200).text).toBe(`${"a ".repeat(98)}x ${PLACEHOLDER.code}`);
  });

  it("uses the subject as context", () => {
    expect(maskSnippetTail("Hello\n663201\nThe team", "Your login code").text).toBe(`Hello\n${PLACEHOLDER.code}\nThe team`);
  });
});

describe("agentSearchRefusal", () => {
  it("refuses redactable text and long digit runs", () => {
    const refusal = "Agents cannot search for codes, numbers or tokens; search by sender, subject or date.";
    expect(agentSearchRefusal(FAKE_JWT)).toBe(refusal);
    expect(agentSearchRefusal("order 1234567")).toBe(refusal);
    expect(agentSearchRefusal("code 482913")).toBe(refusal);
    expect(agentSearchRefusal("garden fence invoice")).toBeNull();
    expect(agentSearchRefusal("")).toBeNull();
  });
});

describe("redactSecrets: linear time", () => {
  const time = (text: string) => {
    const started = performance.now();
    redactSecrets(text, { context: "code" });
    return performance.now() - started;
  };
  it.each([
    ["code words", "code 1234 ".repeat(20_000)],
    ["JWT starts", "eyJ".repeat(66_000) + "."],
    ["PEM begins", "-----BEGIN ".repeat(18_000)],
    ["URLs", "https://".repeat(25_000)],
    ["URL params", "https://example.com/?" + "token=&".repeat(28_000)],
    ["one token run", "aB3".repeat(66_000)],
    ["digit groups", "1 ".repeat(100_000)],
    ["labels", "password: ".repeat(20_000)],
    ["app password shapes", "abcd ".repeat(40_000)],
    ["upper words", "AB12CD ".repeat(28_000)],
  ])("%s: 200 000 characters in one call", (_name, text) => {
    expect(text.length).toBeGreaterThan(190_000);
    // One call timed, generous bound against parallel load.
    expect(time(text)).toBeLessThan(2_000);
  });
});

import { describe, expect, it } from "vitest";
import { PRIVATE_KEY_HEAD_BYTES, classifyPrivateKeyHead, parseAgentList, publicKeyInfo } from "./ssh-keys.ts";
import { parseHostsFile } from "./hosts-file.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A synthetic OpenSSH private-key HEAD: magic, a cipher name and filler. Not a key. */
function opensshHead(cipher: string): Uint8Array {
  const raw = [...ascii("openssh-key-v1"), 0, ...be32(cipher.length), ...ascii(cipher), ...be32(4), ...ascii("none"), ...new Array(30).fill(7)];
  return enc(`-----BEGIN OPENSSH PRIVATE KEY-----\n${b64(raw)}\n-----END OPENSSH PRIVATE KEY-----\n`);
}

describe("publicKeyInfo", () => {
  it("gives type, comment and the SHA256 fingerprint of the key blob (computed outside this test with Python hashlib)", async () => {
    // blob = "ssh-ed25519" + 32 zero bytes, framed as ssh does; fingerprint computed outside this test.
    const blob = [...be32(11), ...ascii("ssh-ed25519"), ...be32(32), ...new Array(32).fill(0)];
    const info = await publicKeyInfo(`ssh-ed25519 ${b64(blob)} me@fixture`);
    expect(info).toEqual({ type: "ssh-ed25519", comment: "me@fixture", fingerprint: "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk" });
  });

  it("refuses text that is not a public key (including a private key header)", async () => {
    expect(await publicKeyInfo("-----BEGIN OPENSSH PRIVATE KEY-----")).toBeNull();
    expect(await publicKeyInfo("ssh-rsa not base64 !!")).toBeNull();
    expect(await publicKeyInfo("ssh-weird AAAA")).toBeNull();
    expect(await publicKeyInfo("")).toBeNull();
  });
});

describe("classifyPrivateKeyHead", () => {
  it("tells an unprotected OpenSSH key from a protected one by the cipher name, and returns nothing else", () => {
    expect(classifyPrivateKeyHead(opensshHead("none"))).toEqual({ format: "openssh", encrypted: false, type: null });
    expect(classifyPrivateKeyHead(opensshHead("aes256-ctr"))).toEqual({ format: "openssh", encrypted: true, type: null });
  });

  it("reads PEM and PKCS#8 headers", () => {
    expect(classifyPrivateKeyHead(enc("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n"))).toEqual({ format: "pem", encrypted: true, type: "RSA" });
    expect(classifyPrivateKeyHead(enc("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n"))).toEqual({ format: "pem", encrypted: false, type: "EC" });
    expect(classifyPrivateKeyHead(enc("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n"))).toEqual({ format: "pkcs8", encrypted: true, type: null });
    expect(classifyPrivateKeyHead(enc("-----BEGIN PRIVATE KEY-----\nMIIE\n"))).toEqual({ format: "pkcs8", encrypted: false, type: null });
  });

  it("does not know what it cannot tell, and ignores everything past the head limit", () => {
    expect(classifyPrivateKeyHead(enc("just some text"))).toEqual({ format: "unknown", encrypted: null, type: null });
    expect(classifyPrivateKeyHead(enc("-----BEGIN OPENSSH PRIVATE KEY-----\n!!!!\n"))).toEqual({ format: "openssh", encrypted: null, type: null });
    // The cipher name sits beyond the limit: it is not looked for there.
    const far = enc("-----BEGIN OPENSSH PRIVATE KEY-----\n" + "A".repeat(PRIVATE_KEY_HEAD_BYTES * 2));
    expect(classifyPrivateKeyHead(far).encrypted).toBeNull();
  });

  it("the result never carries bytes of the file", () => {
    const secretish = opensshHead("none");
    const text = JSON.stringify(classifyPrivateKeyHead(secretish));
    expect(text).not.toContain("openssh-key");
    expect(Object.keys(classifyPrivateKeyHead(secretish)).sort()).toEqual(["encrypted", "format", "type"]);
  });
});

describe("parseAgentList", () => {
  it("parses ssh-add -l lines and an empty agent", () => {
    const out = "256 SHA256:AbCdEf+/12 work laptop (ED25519)\n3072 SHA256:ZZZ me@host (RSA)\n";
    expect(parseAgentList(out)).toEqual([
      { bits: 256, fingerprint: "SHA256:AbCdEf+/12", comment: "work laptop", type: "ED25519" },
      { bits: 3072, fingerprint: "SHA256:ZZZ", comment: "me@host", type: "RSA" },
    ]);
    expect(parseAgentList("The agent has no identities.\n")).toEqual([]);
    expect(parseAgentList("Could not open a connection to your authentication agent.\n")).toEqual([]);
  });
});

describe("parseHostsFile", () => {
  it("offers named hosts, skipping loopback, link-local, broadcast and duplicates", () => {
    const text = `##
127.0.0.1 localhost
255.255.255.255 broadcasthost
::1 localhost
fe80::1%lo0 localhost
10.0.0.5 build.example.test build   # the build box
10.0.0.6 build.example.test
2001:db8::7 web.example.test
10.0.0.9 bad_name!
`;
    expect(parseHostsFile(text)).toEqual([
      { name: "build.example.test", address: "10.0.0.5", aliases: ["build"] },
      { name: "web.example.test", address: "2001:db8::7", aliases: [] },
    ]);
  });
});

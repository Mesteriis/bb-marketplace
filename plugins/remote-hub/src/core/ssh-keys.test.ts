import { describe, expect, it } from "vitest";
import { parseAgentList, publicKeyInfo } from "./ssh-keys.ts";
import { parseHostsFile } from "./hosts-file.ts";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

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

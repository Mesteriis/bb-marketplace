import { describe, expect, it } from "vitest";
import { knownHostsName, parseKnownHosts } from "./known-hosts.ts";

const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("parseKnownHosts", () => {
  it("keeps plain host-key lines with their hosts, type and SHA256 fingerprint, once each", async () => {
    const text = `# comment\n[box.example.test]:2222,10.0.0.5 ${ED} me@fixture\n[box.example.test]:2222,10.0.0.5 ${ED} me@fixture\nplain.example.test ${ED}\n`;
    const entries = await parseKnownHosts(text);
    expect(entries.map((e) => [e.hosts, e.hashed, e.keyType])).toEqual([[["[box.example.test]:2222", "10.0.0.5"], false, "ssh-ed25519"], [["plain.example.test"], false, "ssh-ed25519"]]);
    expect(entries[0]?.fingerprint).toMatch(/^SHA256:/);
    expect(entries[0]?.line).toBe(`[box.example.test]:2222,10.0.0.5 ${ED} me@fixture`);
  });

  it("a hashed entry is kept without a name; markers, malformed lines and control characters are dropped", async () => {
    const text = [
      `|1|c2FsdA==|aGFzaA== ${ED}`,
      `@cert-authority *.example.test ${ED}`,
      `@revoked bad.example.test ${ED}`,
      "host.example.test ssh-ed25519",
      "host.example.test ssh-weird AAAA",
      `host.example.test ${ED}\u0007`,
      "just words",
    ].join("\n");
    const entries = await parseKnownHosts(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ hashed: true, hosts: [] });
  });
});

describe("knownHostsName", () => {
  it("is the bare lower-case host on port 22 and [host]:port otherwise", () => {
    expect(knownHostsName("Box.Example.TEST", 22)).toBe("box.example.test");
    expect(knownHostsName("box.example.test", null)).toBe("box.example.test");
    expect(knownHostsName("box.example.test", 2222)).toBe("[box.example.test]:2222");
  });
});

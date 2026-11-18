// Candidates from an /etc/hosts-style file (stage 3c): host NAMES a person has written down. Nothing is
// created from them by itself; they are offered. Loopback, link-local and broadcast entries are skipped.

export interface HostCandidate {
  name: string;
  address: string;
  aliases: string[];
}

const SKIP_NAMES = new Set(["localhost", "localhost.localdomain", "broadcasthost", "ip6-localhost", "ip6-loopback", "ip6-localnet", "ip6-mcastprefix", "ip6-allnodes", "ip6-allrouters", "ip6-allhosts"]);

function skippedAddress(address: string): boolean {
  const a = address.toLowerCase();
  return a.startsWith("127.") || a === "::1" || a === "0.0.0.0" || a === "::" || a === "255.255.255.255" || a.startsWith("fe80:") || a.startsWith("ff0") || a.startsWith("169.254.");
}

const NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

export function parseHostsFile(text: string): HostCandidate[] {
  const seen = new Set<string>();
  const out: HostCandidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const [address, ...names] = line.split(/\s+/);
    if (address === undefined || skippedAddress(address.split("%")[0] as string)) continue;
    const usable = names.filter((n) => NAME.test(n) && !SKIP_NAMES.has(n.toLowerCase()));
    const [name, ...aliases] = usable;
    if (name === undefined || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, address, aliases });
  }
  return out;
}

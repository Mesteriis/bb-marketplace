// Runtime versions are GitWand's version plus the plugin's build number:
// `3.14.0+bb2` is the second build of GitWand 3.14.0.

export interface RuntimeVersion {
  major: number;
  minor: number;
  patch: number;
  build: number;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\+bb([1-9]\d*)$/;

export function parseRuntimeVersion(text: string): RuntimeVersion | null {
  const m = VERSION.exec(text);
  return m === null ? null : { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), build: Number(m[4]) };
}

/** -1, 0 or 1; throws on a malformed version. */
export function compareRuntimeVersions(a: string, b: string): number {
  const x = parseRuntimeVersion(a);
  const y = parseRuntimeVersion(b);
  if (x === null || y === null) throw new Error(`invalid runtime version: ${x === null ? a : b}`);
  for (const key of ["major", "minor", "patch", "build"] as const) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1;
  }
  return 0;
}

/** Compares plain `x.y.z` versions (the plugin's own); throws on anything else. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (m === null) throw new Error(`invalid version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

export const RUNTIME_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
export type RuntimePlatform = (typeof RUNTIME_PLATFORMS)[number];

/** The runtime platform for Node's `process.platform`/`process.arch`, or null if none is built. */
export function platformKey(platform: string, arch: string): RuntimePlatform | null {
  const key = `${platform}-${arch}`;
  return (RUNTIME_PLATFORMS as readonly string[]).includes(key) ? (key as RuntimePlatform) : null;
}

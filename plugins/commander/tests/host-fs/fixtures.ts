import { parseWindowsPath } from "../../src/adapters/bb/host-fs/paths.ts";
import { parsePosix } from "../../src/core/path.ts";

export const windows = process.platform === "win32";
export const fixturePath = windows ? parseWindowsPath : parsePosix;

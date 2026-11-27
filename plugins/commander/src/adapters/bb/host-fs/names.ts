import { CommanderError } from "../../../core/errors.ts";
import type { NameSegment } from "../../../core/path.ts";

export type NamePlatform = "posix" | "win32";

export function validateTargetName(name: NameSegment, platform: NamePlatform): void {
  if (platform === "posix") return;
  if (!("t" in name) || /[\\:/<>"|?*\u0000-\u001f]/u.test(name.t) || /[. ]$/u.test(name.t)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name.t)) {
    throw new CommanderError("invalid_name", "Invalid Windows target name");
  }
}

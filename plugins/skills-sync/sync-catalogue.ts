import * as path from "node:path";
import type { Source } from "./contract";
import { readFileOrNull } from "./sync-files";
import { listLocalSkills, listUpstreamSkills } from "./sync-buckets";
import type { CatalogueEntry, SkillStatus } from "./sync-types";

/**
 * Read the one frontmatter field the catalogue displays. This is intentionally
 * a small reader: SKILL.md files only need a leading YAML document with a
 * description scalar, not a general-purpose YAML implementation.
 */
export function readFrontmatterDescription(skillDir: string): string {
  const text = readFileOrNull(path.join(skillDir, "SKILL.md"));
  if (text === null) return "";

  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) return "";

  for (let index = 1; index < closing; index += 1) {
    const match = /^\s*description\s*:\s*(.*)$/.exec(lines[index]);
    if (match === null) continue;

    const scalar = match[1].trim();
    if (scalar.startsWith(">") || scalar.startsWith("|")) {
      return readBlockScalar(lines, index + 1, scalar[0]);
    }
    return readScalar(scalar);
  }
  return "";
}

function readScalar(scalar: string): string {
  if (scalar === "") return "";
  if (scalar.startsWith('"')) {
    if (!scalar.endsWith('"')) return "";
    try {
      const parsed: unknown = JSON.parse(scalar);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (scalar.startsWith("'")) {
    if (!scalar.endsWith("'")) return "";
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  return scalar;
}

function readBlockScalar(lines: string[], start: number, style: string): string {
  const raw: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && !/^[ \t]+/.test(line)) break;
    raw.push(line);
  }

  const nonEmpty = raw.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return "";
  const indent = Math.min(...nonEmpty.map((line) => line.search(/\S/)));
  const body = raw.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
  if (style === "|") return body.join("\n").trim();

  let folded = "";
  for (const [index, line] of body.entries()) {
    if (index > 0) folded += body[index - 1] === "" || line === "" ? "\n" : " ";
    folded += line;
  }
  return folded.trim();
}

/**
 * Build the browsing-only catalogue after the real bucket result exists.
 * The new bucket is deliberately read from that result so the offer rule has
 * one source of truth.
 */
export function catalogueSkills(
  source: Source,
  headRoot: string,
  installRoot: string,
  skills: readonly SkillStatus[],
): CatalogueEntry[] {
  const local = new Set(listLocalSkills(installRoot));
  const offered = new Set(
    skills.filter((skill) => skill.bucket === "new").map((skill) => skill.name),
  );

  return [...listUpstreamSkills(headRoot, source).values()]
    .filter(
      (skill) =>
        !local.has(skill.name) &&
        !source.skipBuckets.includes(skill.bucket) &&
        readFileOrNull(path.join(skill.dir, "SKILL.md")) !== null,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({
      name: skill.name,
      upstreamBucket: skill.bucket,
      description: readFrontmatterDescription(skill.dir),
      offered: offered.has(skill.name),
    }));
}

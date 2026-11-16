import type { CatalogueEntry, SkillStatus, SourceStatus } from "./sync-types";
import { BUCKET_METADATA } from "./sync-buckets";

function renderSkillLine(skill: SkillStatus): string {
  const bits: string[] = [];
  if (skill.substantiveFiles.length > 0) {
    bits.push(`upstream: ${skill.substantiveFiles.join(", ")}`);
  }
  if (skill.cosmeticFiles.length > 0) {
    bits.push(`cosmetic only: ${skill.cosmeticFiles.join(", ")}`);
  }
  if (skill.localEditedFiles.length > 0) {
    bits.push(`your edits: ${skill.localEditedFiles.join(", ")}`);
  }
  const where = skill.upstreamBucket === "" ? "" : ` (${skill.upstreamBucket}/)`;
  return `  ${skill.name}${where}${bits.length > 0 ? `\n      ${bits.join("\n      ")}` : ""}`;
}

function renderCatalogueLine(entry: CatalogueEntry): string {
  const where = entry.upstreamBucket === "" ? "" : " (" + entry.upstreamBucket + "/)";
  return (
    "  " +
    entry.name +
    where +
    (entry.description === "" ? "" : "\n      " + entry.description)
  );
}

export function renderStatus(status: SourceStatus): string {
  const lines: string[] = [];
  lines.push(`source ${status.sourceId}`);
  lines.push(`  pinned  ${status.pinned ?? "(no marker file — nothing is pinned)"}`);
  lines.push(`  head    ${status.head}`);
  lines.push(
    "  fetched " +
      (status.fetchedAt === null
        ? "(never recorded)"
        : new Date(status.fetchedAt).toISOString()),
  );
  if (status.commits.length > 0) {
    lines.push(`  ${status.commits.length} upstream commit(s) since the pin, newest first:`);
    for (const commit of status.commits.slice(0, 30)) {
      lines.push(`    ${commit.sha.slice(0, 8)}  ${commit.subject}`);
    }
    if (status.commits.length > 30) {
      lines.push(`    … ${status.commits.length - 30} more`);
    }
  }
  lines.push("");
  for (const { bucket, title } of BUCKET_METADATA) {
    const inBucket = status.skills.filter((skill) => skill.bucket === bucket);
    if (inBucket.length === 0) continue;
    lines.push(`${title} — ${inBucket.length}`);
    for (const skill of inBucket) lines.push(renderSkillLine(skill));
    lines.push("");
  }
  if (status.skills.length === 0) lines.push("Everything installed matches the pin and upstream.");
  if (status.foreign.length > 0) {
    lines.push(
      `Foreign folders (other origins, never touched): ${status.foreign.length} — ${status.foreign.join(", ")}`,
    );
  }
  if (status.catalogue.length > 0) {
    lines.push("");
    lines.push("Catalogue (available, not installed) — " + status.catalogue.length);
    for (const entry of status.catalogue) lines.push(renderCatalogueLine(entry));
  }
  return lines.join("\n").trimEnd();
}

import type { Activity } from "./activity";

export interface InspectorSource {
  seq: number;
  title: string;
}

const markedDecision = /^(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?(?:решение|decision)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/iu;

export function inspectorActivity(rows: readonly Activity[]) {
  const decisions: InspectorSource[] = [];
  const artifacts: InspectorSource[] = [];
  const seenPaths = new Set<string>();
  let check: InspectorSource | null = null;

  for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
    if (!check && row.kind === "check") check = { seq: row.seq, title: row.title };
    if (row.kind === "agent" && decisions.length < 4) {
      const title = row.detail?.split("\n").flatMap(line => markedDecision.exec(line.trim())?.[1] ?? [])[0];
      if (title) decisions.push({ seq: row.seq, title: title.slice(0, 200) });
    }
    for (const path of row.paths ?? []) {
      if (artifacts.length >= 4 || seenPaths.has(path)) continue;
      seenPaths.add(path);
      artifacts.push({ seq: row.seq, title: path });
    }
  }

  return { decisions, artifacts, check };
}

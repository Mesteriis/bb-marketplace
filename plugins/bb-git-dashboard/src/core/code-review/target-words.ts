import type { MessageKey } from "../i18n/dictionary.ts";
import type { Target } from "./model.ts";

/** What a review looks at, as a dictionary key and its values: "Uncommitted changes", "Commit abc1234", … */
export function targetWords(target: Target): {key: MessageKey; values: Record<string, string>} {
  switch (target.kind) {
    case "uncommitted": return {key: "rv.t.uncommitted", values: {}};
    case "staged": return {key: "rv.t.staged", values: {}};
    case "unstaged": return {key: "rv.t.unstaged", values: {}};
    case "files": return {key: "rv.t.files", values: {}};
    case "branch": return {key: "rv.t.branch", values: {base: target.base}};
    case "all": return {key: "rv.t.all", values: {base: target.base}};
    case "commit": return {key: "rv.t.commit", values: {sha: target.sha.slice(0, 7)}};
    case "range": return {key: "rv.t.range", values: {range: target.from + (target.symmetric ? "..." : "..") + target.to}};
  }
}

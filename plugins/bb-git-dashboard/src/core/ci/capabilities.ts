type Kind = "github" | "gitlab" | "gitea" | "azure";
export type CiOperation = "dispatch" | "dispatchInputs" | "rerunFailed" | "rerunAll" | "cancel" | "liveLog";
const operations: CiOperation[] = ["dispatch", "dispatchInputs", "rerunFailed", "rerunAll", "cancel", "liveLog"];

const limitations: Record<Kind, Partial<Record<CiOperation, string>>> = {
  github: {liveLog: "GitHub publishes a job log when the job ends."},
  gitea: {},
  azure: {dispatchInputs: "Azure runtime parameters are not supported; the pipeline runs with its defaults."},
  gitlab: Object.fromEntries(operations.map(operation => [operation, "GitLab support arrives in a later release."])),
};

export function ciLimitation(kind: Kind, operation: CiOperation): string | null {
  return limitations[kind][operation] ?? null;
}

/** CI operations a forge offers. An older self-hosted server may still refuse one at run time. */
export function ciCapabilities(kind: Kind): Record<CiOperation, boolean> {
  return Object.fromEntries(operations.map(operation => [operation, ciLimitation(kind, operation) === null])) as Record<CiOperation, boolean>;
}

import type { z } from "zod";
import type { providerKind } from "../providers.ts";

type Kind = z.infer<typeof providerKind>;
export type Capability = "repositories" | "pulls" | "pipelines" | "issues" | "variables";
const all: Capability[] = ["repositories", "pulls", "pipelines", "issues", "variables"];

const limitations: Record<Kind, Partial<Record<Capability, string>>> = {
  github: {},
  gitea: {},
  azure: {
    issues: "Azure Boards are scoped to the Azure DevOps project.",
    variables: "Azure variable groups are scoped to the Azure DevOps project.",
  },
  gitlab: {},
};

export function limitation(kind: Kind, capability: Capability): string | null {
  return limitations[kind][capability] ?? null;
}

export function capabilities(kind: Kind): Record<Capability, boolean> {
  return Object.fromEntries(all.map(capability => [capability, limitation(kind, capability) === null])) as Record<Capability, boolean>;
}

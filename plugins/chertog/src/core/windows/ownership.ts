import { z } from "zod";

export const TRANSFER_MS = 30_000;
export const PRESENCE_MS = 20_000;
const id = z.string().min(1).max(128);
export const placementSchema = z.strictObject({
  owner: id.nullable(),
  returnSource: id.optional(),
  returned: z.literal(true).optional(),
  generation: z.int().positive(),
  transfer: z
    .strictObject({
      source: id,
      target: id,
      phase: z.enum(["prepared", "ready", "switched"]),
      expires: z.int().nonnegative(),
    })
    .nullable(),
});
export type Placement = z.infer<typeof placementSchema>;
export const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare"), target: id }),
  ...(["claim", "acknowledge", "release", "ready", "switch", "received", "cancel"] as const).map((action) =>
    z.strictObject({ action: z.literal(action) }),
  ),
]);
export type Action = z.infer<typeof actionSchema>;

export function reconcile(p: Placement, present: ReadonlySet<string>, now: number): Placement {
  const t = p.transfer;
  if (!t) return p;
  if (present.has(t.target) && now < t.expires && (t.phase === "switched" || present.has(t.source))) return p;
  return { ...p, generation: p.generation + 1, owner: t.source, transfer: null };
}

/** Only an explicit departure of a detached owner can return its placement. */
export function depart(p: Placement, actor: string, present: ReadonlySet<string>, now: number): Placement {
  const source = p.transfer?.phase === "switched" ? p.transfer.source : p.returnSource;
  if (p.owner !== actor || !source) return reconcile(p, present, now);
  const owner = present.has(source) ? source : present.values().next().value ?? null;
  return { owner, generation: p.generation + 1, transfer: null, returned: true, returnSource: source };
}

export function transition(
  previous: Placement | null,
  actor: string,
  generation: number,
  command: Action,
  present: ReadonlySet<string>,
  now: number,
): Placement {
  const p = previous && reconcile(previous, present, now);
  if (!present.has(actor) || generation !== (p?.generation ?? 0)) throw new Error("Состояние окна изменилось");
  const next = generation + 1;
  if (command.action === "claim" && (!p || ((p.owner === null || !present.has(p.owner)) && !p.transfer))) {
    return { owner: actor, generation: next, transfer: null };
  }
  if (!p) throw new Error("У панели нет владельца");
  const t = p.transfer;
  if (command.action === "acknowledge" && p.owner === actor && p.returned && !t) {
    const { returned, ...rest } = p;
    return { ...rest, generation: next };
  }
  if (command.action === "release" && !t && p.owner === actor) return { owner: null, generation: next, transfer: null };
  if (command.action === "prepare" && !t && p.owner === actor && command.target !== actor && present.has(command.target)) {
    return {
      ...p,
      generation: next,
      transfer: { source: actor, target: command.target, phase: "prepared", expires: now + TRANSFER_MS },
    };
  }
  if (t) {
    if (command.action === "cancel" && t.phase !== "switched" && [t.source, t.target].includes(actor)) {
      return { ...p, generation: next, transfer: null };
    }
    if (command.action === "ready" && t.phase === "prepared" && actor === t.target) {
      return { ...p, generation: next, transfer: { ...t, phase: "ready" } };
    }
    if (command.action === "switch" && t.phase === "ready" && actor === t.source) {
      return { ...p, owner: t.target, generation: next, transfer: { ...t, phase: "switched" } };
    }
    if (command.action === "received" && t.phase === "switched" && actor === t.target) {
      return { owner: actor, returnSource: t.source, generation: next, transfer: null };
    }
  }
  throw new Error("Передача в этом состоянии недоступна");
}

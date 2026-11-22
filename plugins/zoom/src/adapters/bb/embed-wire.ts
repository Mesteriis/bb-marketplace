import { z } from "zod";

const version = "chertog.embed.v1";
const provider = "zoom-call";
const address = {
  version: z.literal(version),
  provider: z.literal(provider),
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  generation: z.number().int().positive().safe(),
};
const hostMessage = z.union([
  z.strictObject({ ...address, kind: z.literal("announce"), mode: z.literal("choose") }),
  z.strictObject({ ...address, kind: z.literal("announce"), resourceRef: z.uuidv4().regex(/^[0-9a-f-]+$/) }),
  z.strictObject({ ...address, kind: z.literal("visibility"), visible: z.boolean() }),
  z.strictObject({ ...address, kind: z.enum(["close", "release"]) }),
]);
export type HostMessage = z.infer<typeof hostMessage>;
export type Address = Pick<HostMessage, "instanceId" | "generation">;
export type Status = "choosing" | "ready" | "denied" | "ended" | "lost" | "revoked" | "cancelled" | "keep" | "hide";

export function readHost(event: Event) {
  const target = event.target;
  if (
    !(event instanceof CustomEvent) ||
    !event.bubbles ||
    event.composed ||
    !(target instanceof HTMLDivElement) ||
    !target.isConnected ||
    target.ownerDocument !== document
  )
    return;
  const value: unknown = event.detail;
  if (typeof value !== "object" || value === null) return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return;
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !field.enumerable ||
      !("value" in field) ||
      !["number", "string", "boolean"].includes(typeof field.value)
    )
      return;
  }
  const parsed = hostMessage.safeParse(value);
  if (parsed.success && matchesTarget(target, parsed.data)) return { target, message: parsed.data };
}

export function matchesTarget(target: HTMLDivElement, message: Address) {
  if (target.ownerDocument !== document || !target.isConnected) return false;
  const layers = document.querySelectorAll('[data-chertog-embed-layer="v1"]');
  const host = target.closest("[data-live-host]");
  const layer = layers[0];
  if (
    layers.length !== 1 ||
    !layer ||
    !host ||
    host.parentElement !== layer ||
    host.getAttribute("data-live-host") !== message.instanceId ||
    layer.querySelectorAll('[data-live-host="' + message.instanceId + '"]').length !== 1 ||
    host.querySelectorAll("[data-chertog-embed-target]").length !== 1 ||
    target.dataset.chertogEmbedTarget !== "v1" ||
    target.dataset.provider !== provider ||
    target.dataset.instanceId !== message.instanceId ||
    target.dataset.generation !== String(message.generation)
  )
    return false;
  return true;
}

export function query() {
  document.dispatchEvent(new CustomEvent(version + ".query", { detail: { version, provider, kind: "query" } }));
}
export function reply(
  target: HTMLElement,
  { instanceId, generation }: Address,
  result: { kind: Status } | { kind: "selected"; resourceRef: string },
) {
  target.dispatchEvent(
    new CustomEvent(version + ".owner", {
      bubbles: true,
      composed: false,
      detail: { version, provider, instanceId, generation, ...result },
    }),
  );
}

// Pinning the target of an action that names its panel explicitly (a drop
// into a chosen draft, a command sent to a chosen thread). The pair of
// instance and addressee is captured before any asynchronous work and
// checked again after it; the action is cancelled if they no longer match.

/** The panel an action is meant for and who that panel addressed at capture. */
export interface PanelTarget {
  readonly instanceId: string;
  readonly addressee: string;
}

/**
 * Reads who an instance addresses right now: null when the instance is not
 * open, not live or has no addressee. `PanelRegistry.addresseeOf` is one.
 */
export type AddresseeReader = (instanceId: string) => string | null;

export type TargetedResult<R> =
  | { readonly status: "done"; readonly value: R }
  | {
      readonly status: "cancelled";
      /**
       * `target-unavailable`: no addressee at capture, the work never started.
       * `target-gone`: the panel was closed or stopped addressing anyone during the work.
       * `target-changed`: the panel addresses someone else now.
       */
      readonly reason: "target-unavailable" | "target-gone" | "target-changed";
    };

/**
 * Runs `prepare` for the captured target and calls `commit` only if the
 * instance still addresses the same recipient afterwards. `commit` starts in
 * the same turn as the check, so nothing can change the target in between;
 * it is where the effect on the recipient belongs. A failure of `prepare`
 * is passed on and nothing is committed.
 */
export async function runForTarget<T, R>(
  read: AddresseeReader,
  instanceId: string,
  prepare: (target: PanelTarget) => Promise<T>,
  commit: (value: T, target: PanelTarget) => R | Promise<R>,
): Promise<TargetedResult<R>> {
  const addressee = read(instanceId);
  if (addressee === null) return { status: "cancelled", reason: "target-unavailable" };
  const target: PanelTarget = Object.freeze({ instanceId, addressee });

  const value = await prepare(target);

  const current = read(instanceId);
  if (current === null) return { status: "cancelled", reason: "target-gone" };
  if (current !== addressee) return { status: "cancelled", reason: "target-changed" };
  return { status: "done", value: await commit(value, target) };
}

// Starts the GitWand backend together with the plugin (and so with BB) instead of on the first call.

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface AutostartDeps {
  /** A usable runtime is resolved (installed or development). */
  hasRuntime: () => boolean;
  /** Checks the signed channel and installs its build; false when the channel offers none. Only used with no runtime. */
  installFirst: () => Promise<boolean>;
  /** Starts the bridge (the supervisor's get()). */
  start: () => Promise<void>;
  log: (message: string) => void;
}

/** Never throws: a backend that cannot start stays visible in the settings state. */
export async function autostart(deps: AutostartDeps): Promise<void> {
  if (!deps.hasRuntime()) {
    let installed: boolean;
    try {
      installed = await deps.installFirst();
    } catch (error) {
      deps.log(`GitWand first runtime install failed: ${messageOf(error)}`);
      return;
    }
    if (!installed || !deps.hasRuntime()) {
      deps.log("GitWand runtime is not installed and the update channel offers no build; the backend stays stopped");
      return;
    }
  }
  try {
    await deps.start();
  } catch (error) {
    deps.log(`GitWand backend did not start: ${messageOf(error)}`);
  }
}

/** After an unexpected exit; the supervisor's crash guard ("failed") stops the loop. */
export async function restartAfterCrash(deps: {
  state: () => string;
  start: () => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  if (deps.state() === "failed") return;
  try {
    await deps.start();
  } catch (error) {
    deps.log(`GitWand backend did not restart: ${messageOf(error)}`);
  }
}

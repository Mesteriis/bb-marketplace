// One owner-click AI request (slice 3f) on the page: ai_start, then ai_poll
// until the job ends. The page hands in the three calls as ports, so this
// stays host-free. A result lives only in this state: nothing is kept after
// the component that ran it unmounts.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiStartInput, AiStartOutput, AiPollOutput } from "../core/contract.ts";
import type { AiErrorKind, AiResultView } from "../core/model.ts";
import { msg } from "./i18n/index.ts";

export interface AiJobPorts {
  start: (input: AiStartInput) => Promise<AiStartOutput>;
  poll: (jobId: string) => Promise<AiPollOutput>;
  cancel: (jobId: string) => Promise<unknown>;
}

export type AiPhase = NonNullable<AiPollOutput["phase"]>;

export type AiJobState =
  | { status: "idle" }
  | { status: "running"; phase: AiPhase | null; jobId: string | null }
  | { status: "done"; result: AiResultView; jobId: string | null }
  | {
      status: "failed";
      /** The kind from ai_poll; null for a refusal of ai_start (its text is the server's fixed text). */
      error: AiErrorKind | null;
      text: string;
      gatewayMessage: string | null;
      provider: string | null;
      model: string | null;
    }
  | { status: "cancelled" };

/** How often a running job is polled. */
export const AI_POLL_MS = 500;

/** The fixed text of an AI error kind; the same words as the core's aiErrorText (a test compares them). */
export const AI_ERROR_TEXT: Record<AiErrorKind, string> = {
  gateway_missing: msg("AI features need the Makosh AI plugin"),
  pool_unavailable: msg("The AI provider is not available"),
  provider_unknown: msg("The chosen AI provider is not available"),
  model_unknown: msg("The chosen AI model is not available"),
  auth: msg("The AI provider refused the sign-in"),
  quota: msg("The AI provider's quota is used up"),
  refused: msg("The AI provider refused this request"),
  too_large: msg("The text is too large for the AI"),
  busy: msg("AI is busy; try again in a moment"),
  failed: msg("The AI request failed"),
  cancelled: msg("The AI request was cancelled"),
  unreadable: msg("The AI answer could not be read"),
  out_of_scope: msg("Outside AI access (Mail settings)"),
  too_long: msg("The AI answer was cut off; try fewer messages or a shorter text"),
};

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : AI_ERROR_TEXT.failed;
}

/**
 * Runs one AI request at a time: a new `run` or `cancel` ends the one before
 * (its job is cancelled on the server), and so does unmounting.
 */
export function useAiJob(ports: AiJobPorts, pollMs: number = AI_POLL_MS) {
  const [state, setState] = useState<AiJobState>({ status: "idle" });
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const serial = useRef(0);
  const jobRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    serial.current++;
    const jobId = jobRef.current;
    jobRef.current = null;
    if (jobId !== null) portsRef.current.cancel(jobId).catch(() => undefined);
  }, []);

  const run = useCallback(
    async (input: AiStartInput) => {
      stop();
      const mine = ++serial.current;
      const live = () => serial.current === mine;
      setState({ status: "running", phase: null, jobId: null });
      let started: AiStartOutput;
      try {
        started = await portsRef.current.start(input);
      } catch (error) {
        if (live()) {
          setState({ status: "failed", error: null, text: messageOf(error), gatewayMessage: null, provider: null, model: null });
        }
        return;
      }
      if (!live()) {
        if ("jobId" in started) portsRef.current.cancel(started.jobId).catch(() => undefined);
        return;
      }
      if ("cached" in started) {
        setState({ status: "done", result: started.cached, jobId: null });
        return;
      }
      const jobId = started.jobId;
      jobRef.current = jobId;
      setState({ status: "running", phase: null, jobId });
      for (;;) {
        let poll: AiPollOutput;
        try {
          poll = await portsRef.current.poll(jobId);
        } catch (error) {
          if (!live()) return;
          jobRef.current = null;
          setState({ status: "failed", error: null, text: messageOf(error), gatewayMessage: null, provider: null, model: null });
          return;
        }
        if (!live()) return;
        if (poll.state === "running") {
          setState({ status: "running", phase: poll.phase ?? null, jobId });
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          if (!live()) return;
          continue;
        }
        jobRef.current = null;
        if (poll.state === "done" && poll.result !== undefined) {
          setState({ status: "done", result: poll.result, jobId });
        } else if (poll.state === "cancelled") {
          setState({ status: "cancelled" });
        } else {
          const kind = poll.error ?? "failed";
          setState({
            status: "failed",
            error: kind,
            text: AI_ERROR_TEXT[kind],
            gatewayMessage: poll.gatewayMessage ?? null,
            provider: poll.provider ?? null,
            model: poll.model ?? null,
          });
        }
        return;
      }
    },
    [pollMs, stop],
  );

  const cancel = useCallback(() => {
    const running = jobRef.current !== null;
    stop();
    setState(running ? { status: "cancelled" } : { status: "idle" });
  }, [stop]);

  const reset = useCallback(() => {
    stop();
    setState({ status: "idle" });
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { state, run, cancel, reset };
}

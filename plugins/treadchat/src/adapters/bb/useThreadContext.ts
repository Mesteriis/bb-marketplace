import { useEffect, useState } from "react";
import { useRealtimeConnectionState, useSdk } from "@get-bb/plugin-sdk/app";

import { activity } from "../../core/activity";

export function useThreadContext(threadId: string) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState({ title: "", currentStep: "", needsAnswer: false });
  useEffect(() => {
    if (connection !== "connected") return;
    const controller = new AbortController();
    const { signal } = controller;
    let refresh = new AbortController();
    async function load() {
      refresh.abort();
      refresh = new AbortController();
      const request = AbortSignal.any([signal, refresh.signal]);
      const [thread, plan, interactions] = await Promise.allSettled([
        sdk.threads.get({ threadId, signal: request }),
        sdk.threads.events.list({
          threadId, signal: request, types: ["turn/plan/updated", "turn/completed"], order: "desc", limit: "1",
        }),
        sdk.threads.interactions.list({ threadId, signal: request }),
      ]);
      if (request.aborted) return;
      const planEvent = plan.status === "fulfilled" ? plan.value[0] : undefined;
      const projected = planEvent && activity(planEvent);
      const currentStep = projected?.kind === "plan" ? projected.detail ?? "" : "";
      setState(previous => {
        const title = thread.status === "fulfilled" ? (thread.value.title ?? threadId) : previous.title;
        const needsAnswer = interactions.status === "fulfilled"
          ? interactions.value.some(interaction => interaction.status === "pending") : previous.needsAnswer;
        const step = plan.status === "fulfilled" ? currentStep : previous.currentStep;
        return previous.title === title && previous.currentStep === step && previous.needsAnswer === needsAnswer
          ? previous : { title, currentStep: step, needsAnswer };
      });
    }
    const unsubscribe = sdk.subscribe({
      event: "thread:changed", threadId,
      callback: event => {
        const metadata = event.metadata;
        if (!metadata || metadata.hasPendingInteraction !== undefined ||
          metadata.statusChange || metadata.eventTypes?.some(type =>
            type === "turn/plan/updated" || type === "turn/completed" || type === "system/interaction/lifecycle")) {
          void load();
        }
      },
    });
    void load();
    return () => { controller.abort(); unsubscribe(); };
  }, [connection, sdk, threadId]);
  return state;
}

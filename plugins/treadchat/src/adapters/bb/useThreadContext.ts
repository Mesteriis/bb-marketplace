import { useEffect, useState } from "react";
import { useRealtimeConnectionState, useSdk } from "@get-bb/plugin-sdk/app";

import { planSteps, type PlanStep } from "../../core/activity";

export function useThreadContext(threadId: string) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState({ title: "", currentStep: "", needsAnswer: false, status: "", steps: [] as PlanStep[] });
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
      const planSnapshot = planEvent ? planSteps(planEvent) : [];
      setState(previous => {
        const title = thread.status === "fulfilled" ? (thread.value.title ?? threadId) : previous.title;
        const needsAnswer = interactions.status === "fulfilled"
          ? interactions.value.some(interaction => interaction.status === "pending") : previous.needsAnswer;
        const steps = plan.status === "fulfilled" ? planSnapshot : previous.steps;
        const currentStep = steps.find(step => step.status === "active")?.title ?? "";
        const status = thread.status === "fulfilled" ? thread.value.status : previous.status;
        return previous.title === title && previous.currentStep === currentStep &&
          previous.needsAnswer === needsAnswer && previous.status === status &&
          previous.steps.length === steps.length && previous.steps.every((step, index) =>
            step.title === steps[index]?.title && step.status === steps[index]?.status)
          ? previous : { title, currentStep, needsAnswer, status, steps };
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

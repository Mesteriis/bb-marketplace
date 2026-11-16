// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertViewResult } from "../core/contract.ts";
import { AlertCard } from "./alert-card.tsx";
import { BB_TEXT } from "./bb-ports.ts";
import { fakeCall, type BbHandlers } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const ALERT: NonNullable<AlertViewResult["alert"]> = {
  source: "grafana",
  name: "HighErrorRate <b>x</b>",
  state: "firing",
  severity: "critical",
  service: "api",
  environment: "prod",
  links: ["https://grafana.example.com/d/abc"],
  alertRef: "c".repeat(64),
};

function mount(view: AlertViewResult, handlers: BbHandlers = {}, inAiScope = true) {
  const fake = fakeCall({
    alert_view: () => view,
    incident_start: () => ({ bbThreadId: "bbt-5" }),
    incident_append: () => ({ bbThreadId: "bbt-5" }),
    ...handlers,
  });
  const props = { onOpenThread: vi.fn(), onOpenLink: vi.fn(), onStarted: vi.fn(), onAppended: vi.fn() };
  render(<AlertCard messageId="m-1" inAiScope={inAiScope} projectId="p-api" call={fake.call} {...props} />);
  return { ...fake, ...props };
}

describe("AlertCard", () => {
  it("shows the alert as text and starts an incident thread in the chosen project", async () => {
    const { to, onStarted, onOpenLink } = mount({ alert: ALERT, incident: null });
    expect(await screen.findByText("HighErrorRate <b>x</b>")).toBeTruthy();
    expect(screen.getByText("firing \u00b7 critical \u00b7 service api \u00b7 prod")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://grafana.example.com/d/abc");
    fireEvent.click(screen.getByRole("button", { name: "Open incident thread\u2026" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Start incident thread" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start incident thread" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("bbt-5"));
    expect(to("incident_start")[0]).toEqual({ messageId: "m-1", projectId: "p-api" });
  });

  it("an open incident offers Open and Add to incident thread", async () => {
    const { to, onAppended, onOpenThread } = mount({
      alert: { ...ALERT, state: "resolved" },
      incident: { bbThreadId: "bbt-5", title: "Incident: HighErrorRate (api)", canAppend: true },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open Incident: HighErrorRate (api)" }));
    expect(onOpenThread).toHaveBeenCalledWith("bbt-5");
    fireEvent.click(screen.getByRole("button", { name: "Add to incident thread" }));
    await waitFor(() => expect(onAppended).toHaveBeenCalledWith("bbt-5"));
    expect(to("incident_append")[0]).toEqual({ messageId: "m-1" });
  });

  it("an old incident offers Open only", async () => {
    mount({ alert: ALERT, incident: { bbThreadId: "bbt-5", title: null, canAppend: false } });
    expect(await screen.findByRole("button", { name: "Open incident thread" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to incident thread" })).toBeNull();
  });

  it("out of AI access: no incident can start", async () => {
    mount({ alert: ALERT, incident: null }, {}, false);
    expect(((await screen.findByRole("button", { name: "Open incident thread\u2026" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(BB_TEXT.out_of_scope)).toBeTruthy();
  });

  it("shows nothing when the message is no alert", async () => {
    const { to } = mount({ alert: null, incident: null });
    await waitFor(() => expect(to("alert_view")).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Alert" })).toBeNull();
  });
});

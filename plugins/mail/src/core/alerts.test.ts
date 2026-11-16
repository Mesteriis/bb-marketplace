import { describe, expect, it } from "vitest";
import { INCIDENT_APPEND_DAYS, alertFingerprint, alertOf } from "./alerts.ts";
import type { DevClass } from "./dev-notify.ts";

const monitoring = (repo: string, state: DevClass["state"] = "firing"): DevClass => ({
  source: "monitoring",
  repo,
  kind: "alert",
  state,
  ref: null,
});
const TOKEN = ["ghp", "InventedToken0123456789abcdefXYZ"].join("_");

describe("alertOf", () => {
  it("is null for anything but monitoring mail", () => {
    expect(alertOf({ devClass: null, subject: "[FIRING:1] X", text: "" })).toBeNull();
    expect(
      alertOf({ devClass: { source: "github", repo: "github.com/a/b", kind: "ci", state: "failed", ref: null }, subject: "x", text: "" }),
    ).toBeNull();
  });

  it("reads Grafana and Alertmanager subjects and labelled lines", () => {
    const alert = alertOf({
      devClass: monitoring("grafana"),
      subject: "[FIRING:2] HighErrorRate (api prod)",
      text: "Labels:\n - alertname = HighErrorRate\n - severity = critical\n - service = api\n - env = prod\nDashboard: https://grafana.example.com/d/abc\nOld: http://grafana.example.com/d/old",
    })!;
    expect(alert).toMatchObject({
      source: "grafana",
      name: "HighErrorRate",
      state: "firing",
      severity: "critical",
      service: "api",
      environment: "prod",
      links: ["https://grafana.example.com/d/abc"],
    });
    const resolved = alertOf({ devClass: monitoring("alertmanager", "resolved"), subject: "[RESOLVED] DiskFull (db)", text: "" })!;
    expect(resolved).toMatchObject({ source: "alertmanager", name: "DiskFull", state: "resolved", service: null });
  });

  it("reads PagerDuty, Datadog and Sentry subjects", () => {
    expect(alertOf({ devClass: monitoring("pagerduty"), subject: "[#1234] Triggered: Disk full on db-1", text: "" })).toMatchObject({
      name: "Disk full on db-1",
      state: "firing",
    });
    expect(alertOf({ devClass: monitoring("pagerduty"), subject: "[#1234] Resolved: Disk full on db-1", text: "" })?.state).toBe("resolved");
    expect(alertOf({ devClass: monitoring("datadog"), subject: "[Recovered] Latency on api", text: "" })).toMatchObject({
      name: "Latency on api",
      state: "resolved",
    });
    expect(alertOf({ devClass: monitoring("datadog"), subject: "[Triggered on {host:web-1}] Latency on api", text: "" })).toMatchObject({
      name: "Latency on api",
      state: "firing",
    });
    expect(alertOf({ devClass: monitoring("sentry"), subject: "demo-api - TypeError: x is undefined", text: "" })).toMatchObject({
      name: "TypeError: x is undefined",
      service: "demo-api",
    });
  });

  it("redacts every field and keeps them on one line", () => {
    const alert = alertOf({
      devClass: monitoring("grafana"),
      subject: `[FIRING:1] Leak ${TOKEN}`,
      text: `service = api ${TOKEN}\nhttps://grafana.example.com/d/x?token=${TOKEN}`,
    })!;
    expect(JSON.stringify(alert)).not.toContain("InventedToken");
    expect(alert.name).not.toContain("\n");
  });
});

describe("alertFingerprint", () => {
  it("is the same across firing and resolved and differs across services", async () => {
    const firing = alertOf({ devClass: monitoring("grafana"), subject: "[FIRING:1] HighErrorRate", text: "service=api\nenv=prod" })!;
    const resolved = alertOf({ devClass: monitoring("grafana", "resolved"), subject: "[RESOLVED] HighErrorRate", text: "service=api\nenv=prod" })!;
    const other = alertOf({ devClass: monitoring("grafana"), subject: "[FIRING:1] HighErrorRate", text: "service=web\nenv=prod" })!;
    const a = await alertFingerprint(firing);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await alertFingerprint(resolved)).toBe(a);
    expect(await alertFingerprint(other)).not.toBe(a);
  });

  it("appends for seven days", () => {
    expect(INCIDENT_APPEND_DAYS).toBe(7);
  });
});

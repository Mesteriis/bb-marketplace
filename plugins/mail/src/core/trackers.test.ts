import { describe, expect, it } from "vitest";
import { TRACKER_HOSTS, TRACKING_REDIRECT_HOSTS, isTrackerHost, isTrackingRedirectHost } from "./trackers.ts";

describe("tracker host lists", () => {
  it("match an exact host or a listed suffix after a dot", () => {
    expect(isTrackerHost("r.superhuman.com")).toBe(true);
    expect(isTrackerHost("R.Superhuman.COM.")).toBe(true);
    expect(isTrackerHost("x.r.superhuman.com")).toBe(false);
    expect(isTrackerHost("u123.ct.sendgrid.net")).toBe(true);
    expect(isTrackerHost("ct.sendgrid.net")).toBe(false);
    expect(isTrackerHost("evil-ct.sendgrid.net.example.org")).toBe(false);
    expect(isTrackingRedirectHost("x.us-east-1.awstrack.me")).toBe(true);
    expect(isTrackingRedirectHost("awstrack.me.example.org")).toBe(false);
  });

  it("never list the test fixtures' hosts or a bare pixel path", () => {
    expect(isTrackerHost("tracker.example.org")).toBe(false);
    for (const entry of [...TRACKER_HOSTS, ...TRACKING_REDIRECT_HOSTS]) {
      expect(entry).toMatch(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(entry.includes("example")).toBe(false);
    }
  });

  it("refuses non-hosts", () => {
    expect(isTrackerHost("")).toBe(false);
    expect(isTrackingRedirectHost("not a host")).toBe(false);
  });
});

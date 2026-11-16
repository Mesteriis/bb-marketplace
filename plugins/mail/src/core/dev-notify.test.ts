import { describe, expect, it } from "vitest";
import { DEV_HEADER_FIELDS, classifyDev, classifyDevFromStored, normalizeListId } from "./dev-notify.ts";

const headers = (pairs: Record<string, string>) => new Map(Object.entries(pairs).map(([k, v]) => [k.toLowerCase(), v]));

describe("DEV_HEADER_FIELDS", () => {
  it("asks the GitHub and GitLab notification headers", () => {
    expect(DEV_HEADER_FIELDS).toEqual(expect.arrayContaining(["X-GitHub-Reason", "X-GitLab-Project-Path", "X-GitLab-Pipeline-Status"]));
  });
});

describe("normalizeListId", () => {
  it("keeps the <id> part in lower case", () => {
    expect(normalizeListId("example-org/demo <Demo.Example-Org.github.com>")).toBe("demo.example-org.github.com");
    expect(normalizeListId("  list.example.org ")).toBe("list.example.org");
    expect(normalizeListId("")).toBeNull();
    expect(normalizeListId("<>")).toBeNull();
    expect(normalizeListId(`<${"a".repeat(201)}>`)).toBeNull();
    expect(normalizeListId("<bad id with spaces>")).toBeNull();
  });
});

describe("classifyDev: GitHub", () => {
  const gh = (subject: string, extra: Record<string, string> = {}, listId: string | null = "demo.example-org.github.com") =>
    classifyDev({ from: "notifications@github.com", subject, headers: headers(extra), listId });

  it("reads a failed CI run with the repo from the List-Id", () => {
    expect(gh("[example-org/demo] Run failed: CI - main (abc1234)", { "X-GitHub-Reason": "ci_activity" })).toEqual({
      source: "github",
      repo: "github.com/example-org/demo",
      kind: "ci",
      state: "failed",
      ref: null,
    });
    expect(gh("[example-org/demo] Run succeeded: CI - main (abc1234)")?.state).toBe("passed");
    expect(gh("[example-org/demo] Run cancelled: CI - main (abc1234)")?.state).toBe("cancelled");
  });

  it("reads pull requests, issues, reviews, releases and security alerts", () => {
    expect(gh("[example-org/demo] Fix the parser (PR #12)")).toMatchObject({ kind: "pr", ref: "12" });
    expect(gh("Re: [example-org/demo] Crash on start (Issue #7)")).toMatchObject({ kind: "issue", ref: "7" });
    expect(gh("[example-org/demo] Fix the parser (PR #12)", { "X-GitHub-Reason": "review_requested" })).toMatchObject({
      kind: "review",
      ref: "12",
    });
    expect(gh("[example-org/demo] Release v1.2.0 - Invented")).toMatchObject({ kind: "release" });
    expect(gh("[example-org/demo] Dependabot alert: invented-lib", { "X-GitHub-Reason": "security_alert" })).toMatchObject({
      kind: "security",
    });
    expect(gh("[example-org/demo] Something else (#3)")).toMatchObject({ kind: "other", ref: "3" });
  });

  it("falls back to the subject's [owner/repo] when there is no List-Id", () => {
    expect(gh("[Example-Org/Demo] Fix (PR #1)", {}, null)?.repo).toBe("github.com/example-org/demo");
  });

  it("does not take a person's mail about GitHub, or GitHub marketing, as a notification", () => {
    expect(classifyDev({ from: "friend@example.org", subject: "My github.com tips", headers: null, listId: null })).toBeNull();
    expect(
      classifyDev({ from: "friend@example.org", subject: "[example-org/demo] Fix (PR #1)", headers: null, listId: null }),
    ).toBeNull();
    expect(classifyDev({ from: "noreply@github.com", subject: "Introducing new features", headers: headers({}), listId: null })).toBeNull();
    expect(classifyDev({ from: "hello@github.com", subject: "[example-org/demo] Fix (PR #1)", headers: null, listId: null })).toBeNull();
  });
});

describe("classifyDev: GitLab", () => {
  it("reads the project path and pipeline status headers", () => {
    expect(
      classifyDev({
        from: "gitlab@gitlab.example.com",
        subject: "Failed pipeline for main | demo | abc1234",
        headers: headers({ "X-GitLab-Project-Path": "Group/Sub/Demo", "X-GitLab-Pipeline-Status": "failed", "X-GitLab-Pipeline-Id": "88" }),
        listId: null,
        knownHosts: new Set(["gitlab.example.com"]),
      }),
    ).toEqual({ source: "gitlab", repo: "gitlab.example.com/group/sub/demo", kind: "ci", state: "failed", ref: "88" });
  });

  it("takes a self-hosted GitLab only from a project remote's host or with a List-Id of that host", () => {
    const mail = {
      from: "gitlab@gitlab.example.com",
      subject: "Failed pipeline for main | demo | abc1234",
      headers: headers({ "X-GitLab-Project-Path": "group/demo", "X-GitLab-Pipeline-Status": "failed" }),
    };
    expect(classifyDev({ ...mail, listId: null })).toBeNull();
    expect(classifyDev({ ...mail, listId: null, knownHosts: new Set(["git.other.example"]) })).toBeNull();
    expect(classifyDev({ ...mail, listId: "demo.group.gitlab.example.com" })).toMatchObject({ source: "gitlab", kind: "ci" });
    // A forged GitLab header from anyone else is ordinary mail.
    expect(classifyDev({ ...mail, from: "someone@elsewhere.example", listId: "demo.group.gitlab.example.com" })).toBeNull();
    expect(classifyDev({ ...mail, from: "gitlab@elsewhere.example", listId: null, knownHosts: new Set(["gitlab.example.com"]) })).toBeNull();
  });

  it("maps gitlab.com senders to gitlab.com and reads merge requests and issues", () => {
    const mr = classifyDev({
      from: "gitlab@mg.gitlab.com",
      subject: "Re: demo | Fix parser (!12)",
      headers: headers({ "X-GitLab-Project-Path": "group/demo", "X-GitLab-MergeRequest-IID": "12" }),
      listId: null,
    });
    expect(mr).toEqual({ source: "gitlab", repo: "gitlab.com/group/demo", kind: "mr", state: null, ref: "12" });
    const issue = classifyDev({
      from: "gitlab@mg.gitlab.com",
      subject: "demo | Crash (#4)",
      headers: headers({ "X-GitLab-Project-Path": "group/demo", "X-GitLab-Issue-IID": "4" }),
      listId: null,
    });
    expect(issue).toMatchObject({ kind: "issue", ref: "4" });
    const passed = classifyDev({
      from: "gitlab@mg.gitlab.com",
      subject: "Successful pipeline for main",
      headers: headers({ "X-GitLab-Project-Path": "group/demo", "X-GitLab-Pipeline-Status": "success" }),
      listId: null,
    });
    expect(passed).toMatchObject({ kind: "ci", state: "passed" });
  });
});

describe("classifyDev: other CI and monitoring", () => {
  it("reads CI senders by domain", () => {
    expect(classifyDev({ from: "builds@circleci.com", subject: "Failed: example-org/demo#123 (main - abc)", headers: null, listId: null })).toEqual({
      source: "ci",
      repo: "example-org/demo",
      kind: "ci",
      state: "failed",
      ref: "123",
    });
    expect(
      classifyDev({ from: "jenkins@ci.example.com", subject: "Build fixed: demo #9", headers: null, listId: null, knownHosts: new Set(["ci.example.com"]) }),
    ).toMatchObject({ source: "ci", state: "passed" });
    expect(classifyDev({ from: "jenkins@ci.example.com", subject: "Build fixed: demo #9", headers: null, listId: "builds.ci.example.com" })).toMatchObject({
      source: "ci",
    });
    // "jenkins@" anywhere else is ordinary mail.
    expect(classifyDev({ from: "jenkins@ci.example.com", subject: "Build fixed: demo #9", headers: null, listId: null })).toBeNull();
    expect(classifyDev({ from: "jenkins@ci.example.com", subject: "Build fixed: demo #9", headers: null, listId: "news.other.example" })).toBeNull();
  });

  it("reads alerts as firing or resolved with the provider as the repo", () => {
    expect(
      classifyDev({ from: "alerts@grafana.net", subject: "[FIRING:2] HighErrorRate api prod", headers: null, listId: null }),
    ).toEqual({ source: "monitoring", repo: "grafana", kind: "alert", state: "firing", ref: null });
    expect(
      classifyDev({ from: "alertmanager@ops.example.com", subject: "[RESOLVED] HighErrorRate", headers: null, listId: "alerts.ops.example.com" }),
    ).toMatchObject({ source: "monitoring", repo: "alertmanager", state: "resolved" });
    // An Alertmanager-like subject from an unknown domain needs a List-Id of that domain.
    expect(classifyDev({ from: "alertmanager@ops.example.com", subject: "[RESOLVED] HighErrorRate", headers: null, listId: null })).toBeNull();
    expect(
      classifyDev({ from: "alertmanager@ops.example.com", subject: "[FIRING:1] HighErrorRate", headers: null, listId: "alerts.elsewhere.example" }),
    ).toBeNull();
    expect(
      classifyDev({ from: "no-reply@pagerduty.com", subject: "[#1234] Triggered: Disk full on db-1", headers: null, listId: null }),
    ).toMatchObject({ repo: "pagerduty", state: "firing", ref: "1234" });
    expect(
      classifyDev({ from: "alert@dtdg.co", subject: "[Recovered] Latency on api", headers: null, listId: null }),
    ).toMatchObject({ repo: "datadog", state: "resolved" });
    expect(classifyDev({ from: "noreply@md.getsentry.com", subject: "demo - TypeError: x is undefined", headers: null, listId: null })).toMatchObject({
      repo: "sentry",
      kind: "alert",
      state: "firing",
    });
  });

  it("leaves a newsletter and a person's [FIRING] subject alone", () => {
    expect(classifyDev({ from: "news@example.org", subject: "Weekly digest", headers: null, listId: "news.example.org" })).toBeNull();
    expect(classifyDev({ from: "friend@example.org", subject: "[FIRING:1] joke", headers: null, listId: null })).toBeNull();
  });
});

describe("classifyDevFromStored", () => {
  it("classifies from From and subject only", () => {
    expect(classifyDevFromStored({ from: "notifications@github.com", subject: "[example-org/demo] Run failed: CI - main (abc)" })).toMatchObject({
      source: "github",
      repo: "github.com/example-org/demo",
      kind: "ci",
      state: "failed",
    });
    expect(classifyDevFromStored({ from: "friend@example.org", subject: "hello" })).toBeNull();
  });
});

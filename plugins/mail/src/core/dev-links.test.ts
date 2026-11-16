import { describe, expect, it } from "vitest";
import { DEV_LINKS_MAX, devLinks } from "./dev-links.ts";
import { repoRefOf } from "./projects.ts";

const remotes = [
  { projectId: "p_demo", remote: repoRefOf("git@github.com:Example-Org/Demo.git")! },
  { projectId: "p_lab", remote: repoRefOf("https://git.example.com/group/sub/proj.git")! },
];

describe("devLinks", () => {
  it("reads every GitHub shape and maps the project", () => {
    const text = [
      "Repo https://github.com/example-org/demo",
      "PR https://github.com/example-org/demo/pull/12/files.",
      "Issue https://github.com/example-org/demo/issues/7#issuecomment-1",
      "Commit https://github.com/example-org/demo/commit/0123abcd",
      "Run https://github.com/example-org/demo/actions/runs/998877",
      "Release https://github.com/example-org/demo/releases/tag/v1.2.0",
      "Compare https://github.com/example-org/demo/compare/v1...v2",
      "Other https://github.com/someone/else/pull/3",
    ].join("\n");
    const links = devLinks(text, [], remotes);
    expect(links.map((link) => [link.kind, link.number, link.projectId])).toEqual([
      ["repo", null, "p_demo"],
      ["pr", "12", "p_demo"],
      ["issue", "7", "p_demo"],
      ["commit", "0123abcd", "p_demo"],
      ["run", "998877", "p_demo"],
      ["release", "v1.2.0", "p_demo"],
      ["compare", null, "p_demo"],
      ["pr", "3", null],
    ]);
    expect(links[1]!.url).toBe("https://github.com/example-org/demo/pull/12/files");
    expect(links[0]!.repo).toEqual({ host: "github.com", path: "example-org/demo" });
  });

  it("reads GitLab shapes on gitlab.com and on a remote's host, subgroups kept", () => {
    const links = devLinks(
      "https://gitlab.com/group/demo/-/merge_requests/5 https://git.example.com/group/sub/proj/-/pipelines/77 " +
        "https://git.example.com/group/sub/proj/-/issues/3 https://git.example.com/group/sub/proj/-/commit/abcdef1 " +
        "https://git.example.com/group/sub/proj",
      [],
      remotes,
    );
    expect(links.map((link) => [link.kind, link.repo?.path, link.number, link.projectId])).toEqual([
      ["mr", "group/demo", "5", null],
      ["pipeline", "group/sub/proj", "77", "p_lab"],
      ["issue", "group/sub/proj", "3", "p_lab"],
      ["commit", "group/sub/proj", "abcdef1", "p_lab"],
      ["repo", "group/sub/proj", null, "p_lab"],
    ]);
  });

  it("takes hrefs too, drops http:, javascript: and relative ones, and ignores anchor text", () => {
    const links = devLinks(
      "see http://github.com/example-org/demo/pull/1",
      ["javascript:alert(1)", "/relative", "https://github.com/example-org/demo/pull/2", "http://github.com/example-org/demo/pull/3"],
      remotes,
    );
    expect(links.map((link) => link.url)).toEqual(["https://github.com/example-org/demo/pull/2"]);
  });

  it("does not take GitHub's own pages or unknown hosts as repositories", () => {
    expect(
      devLinks("https://github.com/features/copilot https://github.com/settings/profile https://example.org/a/b/pull/1", [], remotes),
    ).toEqual([]);
  });

  it("recognises tracker links only on a known host", () => {
    const known = devLinks(
      "https://git.example.com/browse/ABC-123 https://jira.example.org/browse/XYZ-9",
      [],
      remotes,
    );
    expect(known.map((link) => [link.kind, link.number])).toEqual([["tracker", "ABC-123"]]);
    // GitLab shapes count only on gitlab.com and remote hosts, so an unknown host adds no tracker host either.
    expect(devLinks("https://gitlab.example.net/g/p/-/issues/1 https://gitlab.example.net/browse/OPS-4", [], [])).toEqual([]);
  });

  it("de-duplicates and caps at 20", () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://github.com/example-org/demo/pull/${i + 1}`);
    const links = devLinks(`${urls.join(" ")} ${urls[0]}`, [urls[0]!], remotes);
    expect(links).toHaveLength(DEV_LINKS_MAX);
    expect(new Set(links.map((link) => link.url)).size).toBe(DEV_LINKS_MAX);
  });
});

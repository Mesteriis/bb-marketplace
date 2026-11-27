import type { TemplateParam } from "../templating/engine.ts";
import { apacheLicense, mitLicense } from "./licenses.ts";

/** Parameters every scaffold has; a scaffold may not define these names again. */
export const commonParams: TemplateParam[] = [
  {name: "name", label: "Project name (folder and package)", kind: "text", default: "my-project"},
  {name: "description", label: "One-line description", kind: "line", default: ""},
  {name: "author", label: "Author or copyright holder", kind: "line", default: ""},
  {name: "license", label: "License", kind: "choice", default: "MIT", choices: ["MIT", "Apache-2.0", "none"]},
  {name: "year", label: "Copyright year", kind: "text", default: "2026"},
  {name: "contributing", label: "Add CONTRIBUTING.md", kind: "flag", default: false},
  {name: "codeOfConduct", label: "Add CODE_OF_CONDUCT.md", kind: "flag", default: false},
];
/** Values derived from the common ones, not asked for: the copyright holder is the author, else the project's contributors. */
export const derivedParams: TemplateParam[] = [{name: "holder", label: "Copyright holder", kind: "line", default: ""}];

export type OverlayFile = {path: string; body: string; when?: string};

const editorconfig = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[Makefile]
indent_style = tab

[*.md]
trim_trailing_whitespace = false
`;

const gitattributes = `* text=auto eol=lf

*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.ico binary
*.webp binary
*.pdf binary
*.zip binary
*.gz binary

uv.lock linguist-generated
package-lock.json linguist-generated
pnpm-lock.yaml linguist-generated
bun.lock linguist-generated
go.sum linguist-generated
`;

const gitignore = `.env
.env.*
!.env.example
.DS_Store
.idea/
.vscode/
.zed/
*.log
`;

/** The common files; `.editorconfig` and `.gitignore` get the scaffold's own sections and lines appended. */
export function overlayFiles({ignore = [], editorconfig: extra = ""}: {ignore?: string[]; editorconfig?: string}): OverlayFile[] {
  return [
    {path: ".editorconfig", body: editorconfig + (extra ? "\n" + extra.replace(/\n*$/, "\n") : "")},
    {path: ".gitattributes", body: gitattributes},
    {path: ".gitignore", body: gitignore + (ignore.length ? "\n" + ignore.join("\n") + "\n" : "")},
    {path: "LICENSE", body: mitLicense, when: "license=MIT"},
    {path: "LICENSE", body: apacheLicense, when: "license=Apache-2.0"},
    {path: "AGENTS.md", body: `# Instructions for coding agents

{{description}}

## Commands

- \`make check\` — formatting, linting, type checks and tests. Run it after every change; CI runs the same target.
- \`make test\` — tests only.

## Rules

- Make the smallest change that solves the task, in the style of the surrounding code, with a test for new behaviour.
- Keep secrets out of the repository: configuration comes from the environment, \`.env.example\` lists the keys.
- Record third-party code or assets in \`THIRD_PARTY_NOTICES.md\` in the same change.
- Update \`CHANGELOG.md\` under Unreleased for user-visible changes.
`},
    {path: "CLAUDE.md", body: "@AGENTS.md\n"},
    {path: "README.ru.md", body: `# {{name}}

{{description}}

## Разработка

- \`make check\` — форматирование, линтинг, проверка типов и тесты; CI запускает ту же цель.
- \`make test\` — только тесты.

Изменения описываются в [CHANGELOG.md](CHANGELOG.md), уязвимости — по [SECURITY.md](SECURITY.md).
`},
    {path: "SECURITY.md", body: `# Security policy

## Supported versions

Security fixes go to the latest release and the default branch.

## Reporting a vulnerability

Please do not open a public issue. Use the forge's private vulnerability reporting for this repository, or write to the
maintainers privately, with the affected version, the steps to reproduce and the impact. You will get an answer within
a week, and a fix or a plan once the report is confirmed.
`},
    {path: "CHANGELOG.md", body: `# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project skeleton.
`},
    {path: "THIRD_PARTY_NOTICES.md", body: `# Third-party notices

{{name}} includes no third-party code or assets yet. Each one added is listed here, in the same change, with its
source, version, license and copyright notice. Dependencies installed by the package manager are not copied into the
repository and are not listed.
`},
    {path: "CONTRIBUTING.md", when: "contributing", body: `# Contributing

Thank you for helping with {{name}}.

1. Open an issue first for anything larger than a small fix, so the approach can be agreed on.
2. Make the change on a branch, with tests for new behaviour.
3. Run \`make check\`; it must pass, as it does in CI.
4. Describe in the pull request what changed, how it was checked and what was not checked.
`},
    {path: "CODE_OF_CONDUCT.md", when: "codeOfConduct", body: `# Code of conduct

{{name}} follows the [Contributor Covenant, version 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Be respectful, assume good intent and keep discussions about the work. Report unacceptable behaviour to the maintainers
privately; reports are handled confidentially.
`},
  ];
}

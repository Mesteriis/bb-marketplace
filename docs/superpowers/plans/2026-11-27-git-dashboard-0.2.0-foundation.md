# Makosh Git 0.2.0 — фундамент и автоподключение форджа

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** рабочая копия сама узнаёт свой форж и аккаунт по remote, плагин получает
модель форджа v2 (с GitLab) и правило «настоящих проектов» для каталога.

**Architecture:** чистые функции в `src/core/forge/` и `src/core/catalog/`
(разбор remote, резолвер с портами, выбор аккаунта, классификация проектов);
адаптеры: host-методы `ssh -G`, чтение origin и обход папки; backend — опрос
хостов и кэш в `plugin_kv`; RPC и небольшая правка панели репозитория.

**Tech Stack:** TypeScript, zod 4, `node --test`, BB Plugin SDK 0.6.157.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§4, §6, §7 «0.2.0», §12).

## Global Constraints

- id плагина `bb-git-dashboard`, CLI и имена `git_dashboard_*` не меняются; отображаемое имя «Makosh Git».
- Существующий JSON `accounts` читается без изменений; binding Vault (`sha256([id,kind,origin,organization,username])`) не меняется.
- `src/core`, `src/ui` без `node:*`, `@get-bb/*`, Electron, Tauri.
- Опрос хоста: без кредов, `redirect:"manual"`, таймаут 4 с, тело ≤ 64 KiB, параллельно `/api/v1/version` и `/api/v4/version`.
- Кэш форджа: найден — 30 дней, неизвестно/недоступно — 1 день.
- Из `ssh -G` читается только `hostname`.
- «Папка проектов» по умолчанию `/Users/owner/projects`; исключения по умолчанию: скрытые каталоги, `node_modules`, `vendor`, `references`.
- Реальные проекты владельца — только чтение.

## Review Focus

- remote с портом/пользователем (`ssh://git@host:2222/o/r.git`) и с `.git`/без — один и тот же репозиторий.
- алиас SSH, которого нет в `~/.ssh/config` (`ssh -G` возвращает сам алиас) — форж «неизвестен», без зацикливания.
- хост отвечает редиректом на логин или HTML — не Gitea и не GitLab.
- два аккаунта подходят одинаково — выбор не угадывается, требуется явный.
- `.git`-файл с относительным `gitdir:` — классифицируется по разрешённому пути.

---

### Task 1: Архитектурный тест

**Files:** Create `tests/architecture.test.ts`.

- [ ] Тест `core and ui import only allowed modules`: обходит `src/core/**` и `src/ui/**`,
  ищет `from "…"`/`import("…")`; падает на `node:`, `@get-bb/`, `electron`, `@tauri-apps/`;
  для `src/core` разрешены только `zod` и относительные пути внутри `src/core`.
- [ ] Прогнать `npm test` — PASS (текущий код соблюдает правило) либо исправить нарушителя переносом в адаптер.
- [ ] Commit `test(bb-git-dashboard): enforce host-free core and ui`.

### Task 2: Модель форджа v2

**Files:** Modify `src/core/providers.ts`, `src/core/connection.ts`, `src/adapters/bb/provider.ts`;
Create `src/core/forge/capabilities.ts`; Test `tests/forge-model.test.ts`.

**Produces:** `providerKind = z.enum(["github","azure","gitea","gitlab"])`;
`account.tokenSource: z.enum(["vault","gh","glab"]).default("vault")`;
`capabilities(kind): Record<Capability, boolean>` где
`Capability = "repositories"|"pulls"|"pipelines"|"issues"|"variables"`; `limitation(kind, capability): string|null`.

- [ ] Тесты: (1) JSON двух текущих аккаунтов (`Mesteriis`, `second-account`, без `tokenSource`) парсится, `tokenSource === "vault"`;
  (2) `detectProvider("https://gitlab.com/g/p")` → `{kind:"gitlab", origin:"https://gitlab.com"}`;
  (3) `provider({kind:"gitlab",…})` бросает `PROVIDER_UNSUPPORTED`;
  (4) `capabilities("gitlab")` — все `false` в 0.2.0, `capabilities("azure").issues === false`.
- [ ] Реализация; `originOf` для gitlab — `configured.origin`.
- [ ] `npm run check` — PASS; commit `feat(bb-git-dashboard): forge model v2 with GitLab`.

### Task 3: Разбор remote

**Files:** Create `src/core/forge/remote-url.ts`; Test `tests/remote-url.test.ts`.

**Produces:** `parseRemote(url:string): RemoteRef | null`,
`type RemoteRef = {transport:"https"|"ssh"; host:string; port:number|null; path:string}`
(`path` без ведущего `/` и без `.git`, регистр сохраняется); `sameRepository(a,b)` — host без регистра, path без регистра.

- [ ] Тесты: `https://github.com/o/r.git` → `{https, github.com, null, "o/r"}`;
  `git@github-office:Org/r.git` → `{ssh, "github-office", null, "Org/r"}`;
  `ssh://git@git.acme.example:2222/g/sub/r` → port 2222, path `g/sub/r`;
  `https://user:pw@h/o/r` → `null`; `file:///x`, `/abs/path`, `-oProxyCommand=x:o/r` → `null`;
  `https://dev.azure.com/org/proj/_git/r` → path `org/proj/_git/r`.
- [ ] Реализация; commit `feat(bb-git-dashboard): parse Git remotes`.

### Task 4: Резолвер форджа

**Files:** Create `src/core/forge/resolve.ts`; Test `tests/forge-resolve.test.ts`.

**Consumes:** `RemoteRef`. **Produces:**
```ts
type ForgeKind = "github"|"gitlab"|"gitea"|"azure";
type Detection = {kind:ForgeKind|null; origin:string; status:"known"|"probed"|"cached"|"unknown"|"unreachable"};
type Ports = {
  sshHostname(alias:string):Promise<string>;              // ssh -G
  probe(origin:string):Promise<"gitea"|"gitlab"|null|"unreachable">;
  cache:{get(host:string):Promise<{kind:ForgeKind|null;checkedAt:number}|undefined>; set(host:string,v:{kind:ForgeKind|null;checkedAt:number}):Promise<void>};
  now():number;
};
function forgeResolver(ports:Ports): {resolve(remote:RemoteRef, options?:{recheck?:boolean}):Promise<Detection>};
```
Известные хосты: `github.com`→github, `gitlab.com`→gitlab, `dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`→azure (origin `https://dev.azure.com`).
SSH-транспорт → всегда `sshHostname` (мемоизация по алиасу на время жизни резолвера); `origin = "https://" + hostname`.

- [ ] Тесты: алиас `github-office` → hostname `github.com` → `{github, known}`, `probe` не вызван;
  `git.acme.example` с probe `gitea` → `{gitea, probed}`, повторно → `cached`, probe вызван 1 раз;
  кэш `null` возрастом 2 дня → повторный опрос; кэш `gitea` возрастом 29 дней → `cached`;
  probe `unreachable` → `{null, unreachable}` и кэш на 1 день; `recheck:true` игнорирует кэш;
  `sshHostname` вернул сам алиас без точки → `{null, unknown}` без probe;
  параллельные `resolve` одного хоста вызывают probe один раз.
- [ ] Реализация; commit `feat(bb-git-dashboard): resolve the forge behind a remote`.

### Task 5: Выбор аккаунта

**Files:** Create `src/core/forge/account-pick.ts`; Test `tests/account-pick.test.ts`.

**Produces:**
```ts
type GithubFacts = {orgs(accountId:string):Promise<string[]>; canSee(accountId:string, path:string):Promise<boolean>};
function pickAccount(detection:Detection, path:string, accounts:Account[], facts:GithubFacts):
  Promise<{chosen:string|null; candidates:string[]; reason:"owner"|"organization"|"visible"|"host"|"ambiguous"|"none"}>;
```
GitHub: кандидаты — аккаунты kind github с тем же origin; порядок правил: owner == username (без регистра) → член org → `canSee` → иначе `ambiguous` (несколько) / `none`. На каждом шаге ровно один подходящий — выбран; несколько — переход к следующему правилу среди них.
GitLab/Gitea/Azure: аккаунты того же kind и origin хоста; один → `host`, несколько → `ambiguous`.
Ошибка facts для аккаунта = «не подходит» этому правилу.

- [ ] Тесты: `Mesteriis/x` → Mesteriis (`owner`); `office-org/y`, orgs second-account=[office-org] → `organization`;
  `third/z`, canSee только у одного → `visible`; оба видят → `ambiguous`, candidates оба;
  gitea `git.acme.example` без аккаунтов → `none`.
- [ ] Реализация; commit `feat(bb-git-dashboard): pick the account for a repository`.

### Task 6: Автоподключение копии

**Files:** Modify `src/adapters/bb/host-contract.ts`, `host.ts`, `src/adapters/bb/local-git.ts`,
`src/adapters/bb/forge-provider.ts`, `src/adapters/bb/azure-provider.ts`, `src/core/providers.ts`,
`src/adapters/bb/remote-service.ts`, `src/adapters/bb/rpc.ts`, `server.ts`;
Create `src/adapters/bb/forge-probe.ts`, `src/adapters/host/ssh-config.ts`;
Test `tests/forge-probe.test.ts`, `tests/ssh-config.test.ts`, `tests/auto-link.test.ts`.

**Produces:**
- host: `originUrl({root,identity}) → {ok,url}` (`git remote get-url origin`), `sshHostname({alias}) → {ok,hostname}`; alias `^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$`, вызов `ssh -G -- alias`, из вывода только строка `hostname `.
- `Provider.repository(path:string):Promise<Repo>` (GitHub/Gitea `GET /repos/o/r`; Azure `GET /{org}/{project}/_apis/git/repositories/{name}`).
- `probeForge(origin, fetch) → "gitea"|"gitlab"|null|"unreachable"`: Gitea — JSON с строкой `version`; GitLab — JSON с `version` и `revision` (или 401 на `/api/v4/version`).
- RPC `forgeStatus({copyId}) → {ok, remote:{host,path}|null, detection, candidates:Account[], chosen:string|null, reason, linked:Link|null}`; `forgeConnect({copyId, accountId, recheck?:boolean})` → находит репозиторий через `Provider.repository`, сохраняет `repository/<acc>/<id>` и связь как `linkRepository`.
- Автоподключение: `forgeStatus` при `linked === null` и `chosen !== null` сам выполняет `forgeConnect` (выбор запоминается в связи).
- Сверка origin для связи: `sameRepository(parseRemote(origin), parseRemote(repo.clone))` с учётом `sshHostname`; HTTPS-обмен по-прежнему требует точного совпадения (`checkOrigin`).

- [ ] Тесты probe на двойнике fetch: Gitea `{"version":"1.25.3"}` → gitea; `{"version":"28.2.0"}` по v1 → gitea; GitLab 401 на v4 и 404 на v1 → gitlab;
  302 → null; HTML 200 → null; тело 100 KiB → null; таймаут → unreachable; запрос без `authorization`.
- [ ] Тесты ssh-config: парсинг вывода с `hostname github.com` → `github.com`; алиас `-oProxyCommand` отклонён; лишние ключи (`identityfile`, `user`) не возвращаются.
- [ ] Тест auto-link (сервис с фейковыми host/kv/fetch): копия с origin `git@github-office:Mesteriis/makosh-git-sandbox.git` и двумя аккаунтами → связь с Mesteriis; повторный `forgeStatus` не делает сетевых вызовов probe.
- [ ] Реализация; `npm run check` — PASS; commit `feat(bb-git-dashboard): connect working copies to their forge automatically`.

### Task 7: Правило «настоящих проектов»

**Files:** Create `src/core/catalog/project-scan.ts`, `src/adapters/host/project-walk.ts`;
Modify host contract, `host.ts`, `remote-service.ts` (настройки), `rpc.ts`, `server.ts`;
Test `tests/project-scan.test.ts`, `tests/project-walk.test.ts`; Script `scripts/scan-preview.ts` (только чтение, для отчёта).

**Produces:**
```ts
type Entry = {path:string; git:"dir"|"file"|null; gitdir?:string /* абсолютный, из .git-файла */};
type Verdict = {path:string; kind:"project"|"worktree"|"submodule"; parent?:string} | {path:string; kind:"skipped"; reason:"hidden"|"excluded"|"depth"|"broken-gitdir"};
function classify(entries:Entry[], rules:{exclude:string[]; maxDepth:number}, root:string): {projects:Verdict[]; attached:Verdict[]; skipped:Verdict[]};
function shouldDescend(name:string, rules):"descend"|"hidden"|"excluded";
```
`gitdir` внутри `<X>/.git/worktrees/…` → worktree, parent = X; внутри `<X>/.git/modules/…` → submodule, parent = X; иначе `.git`-файл → `broken-gitdir` в skipped.
Обход: `maxDepth` по умолчанию 6; внутрь проектов спускаться; симлинки не раскрывать.
Настройки: `projectsRoot` (string, `/Users/owner/projects`), `projectExclude` (string через запятую, `node_modules,vendor,references`); скрытые каталоги исключаются всегда.
RPC `projectScanPreview({hostId}) → {ok, root, projects:number, attached:number, skipped:{reason,count,examples:string[]}[]}`.

- [ ] Тесты classify на фиктивном дереве: `Personal/a/.git/` → project; `Personal/bb-main/.worktrees/x/.git` (файл → `…/bb-main/.git/worktrees/x`) не обходится (скрытый) → в skipped `hidden`; `agent-team/worktrees/w/.git` файл → worktree под `agent-team`;
  `infra/mod/.git` файл → `…/infra/.git/modules/mod` → submodule; `lim/references/r/.git/` → skipped `excluded`; `hass/.git/` и `hass/distrib/d/.git/` → оба project; относительный `gitdir: ../.git/worktrees/w` разрешается от папки файла.
- [ ] Тест project-walk на временной папке (`mkdtemp`) с реальными `.git`-файлами/каталогами.
- [ ] Реализация; прогон `node scripts/scan-preview.ts /Users/owner/projects` — сохранить числа для отчёта.
- [ ] commit `feat(bb-git-dashboard): recognise real projects under the projects folder`.

### Task 8: Панель, имя, документация, выпуск 0.2.0

**Files:** Modify `src/ui/repository-panel.tsx`, `app.tsx`, `package.json`, `package-lock.json`, `PLUGIN_OVERVIEW.md`, `README.md`,
`../../marketplace.json` (только запись `bb-git-dashboard`); Create `CHANGELOG.md`.

- [ ] Панель: строка «Форж: GitHub · github.com · аккаунт Mesteriis (по владельцу)»; при `ambiguous` — выбор аккаунта из `candidates` → `forgeConnect`; статусы `unknown`/`unreachable` с кнопкой «Перепроверить» (`recheck:true`); ручной `ConnectionPicker` остаётся.
- [ ] `bb.name` и `displayName` → «Makosh Git»; описание — текущее поведение плюс автоподключение; версия 0.2.0; `npm install --package-lock-only`.
- [ ] `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs` — все PASS.
- [ ] Проверка на реальных remote только чтением: `node scripts/resolve-preview.ts /Users/owner/projects` классифицирует хосты (`github.com`, `github-office`, `git.acme.example`, `git.dev.acme.example`, `gitlab.acme.example`).
- [ ] commit `feat(bb-git-dashboard): Makosh Git 0.2.0`.

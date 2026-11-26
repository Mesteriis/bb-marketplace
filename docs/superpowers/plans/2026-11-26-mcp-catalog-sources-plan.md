# MCP Catalog: more catalogs in search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search the official MCP Registry, the GitHub MCP Registry and the Docker MCP Catalog from one «Поиск» tab, feeding the unchanged review → accept → collection → install pipeline.

**Architecture:** Each catalog is an adapter implementing the existing `RegistryPort`; a pure core `CatalogSearch` merges them, labels results by catalog and routes lookups back to the source catalog. Docker records are mapped to official `server.json` by a pure core function.

**Tech Stack:** TypeScript, zod 4, vitest, BB plugin SDK; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-mcp-catalog-sources-design.md` (and the base `2026-11-26-mcp-catalog-design.md`).

## Global Constraints

- Plugin `plugins/mcp-catalog`; layers: `src/core` pure (no I/O, no host imports), `src/ui` props only, `src/adapters/bb` host/I/O. Enforced by `tests/architecture.test.ts` at repo root.
- Catalog ids: `"official" | "github" | "docker"`. UI labels: «Официальный», «GitHub», «Docker».
- GitHub base URL `https://api.mcp.github.com/v0.1/servers`; Docker URL `https://desktop.docker.com/mcp/catalog/v3/catalog.json`; Docker cache TTL 6 h; page size 30.
- Docker names `com.docker.mcp/<key>`; server version `sha256-<first 12 hex>`; OCI package `version` = full `sha256:<64 hex>`.
- All user-visible text in Russian. RPC contract changes are additive only.
- No personal data (paths, ids) in code, tests or fixtures. Fixtures are small hand-written excerpts.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no merge.

## Review Focus

1. A server present in both official and GitHub shows once, with both labels, and review/accept fetch the official record.
2. Docker catalog unreachable or malformed → search still returns official/GitHub results plus a warning.
3. A Docker entry with volumes/poci/templated command is listed with a reason and `startReview` refuses it.
4. A `com.docker.mcp/*` review/accept refetches from Docker and the digest in `ociDigest` must equal the record's digest.
5. Paging through merged results never repeats or drops items of a catalog (cursor per catalog).

---

### Task 1: Catalog-aware search core + GitHub adapter

**Files:**
- Create: `src/core/catalogs.ts`, `src/core/catalogs.test.ts`
- Modify: `src/core/registry.ts` (RegistryMeta), `src/core/contract.ts`, `src/core/service.ts`, `src/adapters/bb/registry-http.ts` (+ test), `server.ts`

**Interfaces:**
- Produces:
  - `type CatalogId = "official" | "github" | "docker"`; `RegistryMeta` gains optional `unsupported?: string`.
  - `interface CatalogSource { id: CatalogId; port: RegistryPort; lookup?(name: string, version: string): Promise<RegistryServer | undefined> }`
  - `class CatalogSearch { constructor(sources: CatalogSource[]); search(query: string, cursor: string | undefined, enabled: CatalogId[]): Promise<{ servers: RegistryServer[]; meta: (RegistryMeta & { catalogs: CatalogId[] })[]; nextCursor?: string; warnings: string[] }>; find(name: string, version: string): Promise<{ server: RegistryServer; catalog: CatalogId }> }`
  - Cursor: opaque base64url JSON `{ [id]: string | null }` (null = that catalog exhausted).
  - `find`: names starting `com.docker.mcp/` → docker only; otherwise official, then github. Pages followed up to the hard cap already used by service (keep its constant).
  - Contract: `SearchItem` gains `catalogs: CatalogId[]` and `unsupported: string | null`; search input gains optional `catalogs: CatalogId[]`; `SearchResult.warning` keeps one joined string.
  - `RegistryHttp` constructor takes the base URL (default official) — GitHub uses the same class with its URL.
- Service: `search` and `findInRegistry` go through `CatalogSearch`; `startReview` refuses an item whose meta has `unsupported` (message `«не поддерживается: <причина>»`).

- [ ] **Step 1: Failing tests in `catalogs.test.ts`:** `merges_same_name_version_into_one_with_both_labels` (official+github fake ports, expect one server, `catalogs: ["official","github"]`); `one_catalog_failure_is_a_warning` (github throws → official results, warnings length 1, text contains «GitHub»); `cursor_pages_each_catalog_independently` (official 2 pages, github 1 page → second call queries only official); `find_routes_docker_names_to_docker` and `find_prefers_official_then_github`; `disabled_catalog_is_not_queried`.
- [ ] **Step 2:** run `npx vitest run src/core/catalogs.test.ts` → FAIL.
- [ ] **Step 3:** implement `catalogs.ts`; extend contract/service; parametrise `RegistryHttp`; wire official + github in `server.ts`.
- [ ] **Step 4:** service tests: search item carries `catalogs`; `startReview` on unsupported throws. Run `npm test` → PASS; `npm run build` OK.
- [ ] **Step 5:** commit `feat(mcp-catalog): search several catalogs; GitHub MCP Registry`.

### Task 2: Docker MCP Catalog

**Files:**
- Create: `src/core/docker-catalog.ts` (+ test), `src/adapters/bb/docker-catalog-http.ts` (+ test)
- Modify: `src/core/review.ts` (prompt hint), `server.ts`

**Interfaces:**
- Consumes: `CatalogSource`, `RegistryMeta.unsupported` from Task 1.
- Produces:
  - `mapDockerEntry(key: string, entry: unknown): { server: RegistryServer; meta: RegistryMeta }` — never throws for an unusable entry: returns a minimal server (name, description, version) with `meta.unsupported` set; throws only if `key` itself is invalid.
  - `searchDocker(entries: Record<string, unknown>, query: string, offset: number, limit: 30): RegistryPage` (cursor = next offset as string).
  - `DockerCatalogHttp implements RegistryPort` with `lookup`; cache 6 h; injectable fetch and clock.
  - `reviewPrompt(server, hints?: { ociDigest?: string; allowHosts?: string[] })` — adds one line «ociDigest для entry.json: <digest>» and, if any, «Сеть: allowHosts … — каталог Docker это не применяет, отрази в review.md».
- Mapping rules: exactly as the spec's "Docker → server.json mapping" list.

- [ ] **Step 1: Failing tests** with hand-written fixture entries: `maps_image_with_digest_to_oci_package` (expect identifier `mcp/brave`, package version `sha256:` + 64 hex, server version `sha256-` + 12 hex); `secrets_become_required_secret_env`; `literal_env_becomes_default`; `config_template_env_takes_description_and_required` (both array `{Name,Schema}` and object `properties` forms); `remote_maps_to_remotes_with_secret_headers`; unsupported reasons for `poci`, `volumes`, templated `command`, mixed env template, image without digest — each asserts the exact Russian reason string you define; `search_matches_title_description_tags_case_insensitive`; `paging_by_offset`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** adapter tests: cache hit within 6 h does not refetch; refetch after; HTTP error → thrown message «каталог Docker недоступен: …». Review prompt test with hints.
- [ ] **Step 5:** wire docker source in `server.ts`; `startReview`/accept pass hints for docker records; accept checks `entry.ociDigest` equals the record's package version for docker records. `npm test`, `npm run build` → PASS. Commit `feat(mcp-catalog): Docker MCP Catalog as a search source`.

### Task 3: Search tab UI

**Files:** Modify `src/ui/search-tab.tsx`, `app.tsx` / adapter glue as needed; test in `src/ui/catalog-page.test.tsx`.

- Badges per item from `catalogs` («Официальный», «GitHub», «Docker»); three toggles above results (all on), changing them re-runs the search with `catalogs`; an `unsupported` item shows «не поддерживается: <причина>» and its review button is disabled.
- [ ] Failing UI tests: badges render; toggling «Docker» off sends `catalogs: ["official","github"]`; unsupported item has disabled button and the reason text.
- [ ] Implement; `npm test`, `npm run build` PASS; check rendered tab in the test BB at desktop width; commit `feat(mcp-catalog): catalog badges and filter in search`.

### Task 4: Docs and end-to-end check

- Update `PLUGIN_OVERVIEW.md` and `README.md` of the plugin (catalogs, what Docker entries are unsupported). Root `node scripts/check-manifests.mjs` OK.
- In the test BB (`~/.bb-test/bb`, the plugin installed from the worktree path): search «github» shows GitHub and Docker results; start a review of one Docker entry without secrets that maps cleanly; do not accept into the real repo.
- Commit `docs(mcp-catalog): catalogs`.

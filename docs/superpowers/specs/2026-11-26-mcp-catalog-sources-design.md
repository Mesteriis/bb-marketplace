# MCP Catalog: more catalogs in search — design

Date: 2026-11-26. Status: approved by the owner. Builds on `2026-11-26-mcp-catalog-design.md`.

## Intent

The owner wants to find MCP servers in more places than the official MCP Registry while keeping the rule
"install only what was reviewed and accepted". The extra catalogs widen **search only**; review by an agent thread,
the owner's «Принять», the git collection and installation stay exactly as they are.

## Goals

- Search the official registry, the **GitHub MCP Registry** and the **Docker MCP Catalog** from the one «Поиск» tab.
- Each result shows which catalogs list it; a filter turns catalogs on/off (all on by default).
- A Docker entry that the pipeline cannot install is still visible, marked «не поддерживается: <причина>», and cannot be sent to review.
- Failure of one catalog is a warning; the others still answer.

## Non-goals

- Catalogs that need an API key (Glama, PulseMCP) and Smithery (API down). Owner said no.
- Docker MCP Gateway features (allowHosts network limits, OAuth flows, volumes, dynamic tools).
- Changing the collection format, review, accept or install.

## Anti-goals

- A second storage format in `mcp-collection/`: every entry stays an official-schema `server.json`.
- Any path that installs from a catalog without review + accept.

## Approaches

1. **(chosen) One adapter per catalog behind the registry port; each turns its record into `server.json`.**
   The rest of the pipeline is unchanged. Cost: a mapping layer for Docker.
2. One tab per catalog — three searches instead of one; rejected.
3. Keep Docker's native record in the collection — every stage would need two formats; rejected.

## Decided

- **Official**: `https://registry.modelcontextprotocol.io/v0/servers` (as today).
- **GitHub MCP Registry**: `https://api.mcp.github.com/v0.1/servers?search=&limit=&cursor=` — same envelope
  (`servers[].server`, `_meta["io.modelcontextprotocol.registry/official"]`, `metadata.nextCursor`), same parser.
  Its records are a curated subset of the official registry with the same names: a record present in both is
  shown once with both catalog labels.
- **Docker MCP Catalog**: one JSON file `https://desktop.docker.com/mcp/catalog/v3/catalog.json`
  (~1.6 MB, `registry: {<key>: entry}`, 316 entries on 2026-11-26), cached in memory for 6 hours, searched locally
  (case-insensitive substring over key, title, description, tags), 30 per page, cursor = offset.
- Docker → `server.json` mapping:
  - name `com.docker.mcp/<key>`; description from `description` (fallback `title`); `repository` from `source`/`upstream` when it is a GitHub URL; `websiteUrl` = `upstream` if present.
  - `image: name@sha256:<hex>` → one package `{registryType:"oci", identifier:name, version:"sha256:<hex>", transport:{type:"stdio"}}`.
    Server `version` = `sha256-<first 12 hex of the digest>`.
  - `secrets[]` → environment variables `{name: env, description, isSecret:true, isRequired:true}`.
  - `env[]` with a literal value → variable with `default` = value, `isRequired:false`.
  - `env[]` whose value is exactly `{{<configName>.<prop>}}` → variable with the description of that config property,
    `isRequired` from the config's `required` list; config `properties` may be an array of `{Name, Schema}` or an object.
  - `remote` `{transport_type, url, headers}` → `remotes[]` (`streamable-http` / `sse`), header values that reference
    `${X}` become secret headers.
  - Unsupported (shown, not reviewable): `type:"poci"`, `volumes`, any template in `command`, an env value mixing text
    and templates, an image without a digest, `oauth` with no other usable way to run. The reason goes in the item.
- The review prompt for a Docker record also states the digest to write as `ociDigest` and lists `run.allowHosts`
  (if any) as information the reviewer must report, since this catalog does not enforce it.
- Accept and review refetch the record from **the catalog it came from**: a name `com.docker.mcp/*` → Docker;
  otherwise official first, then GitHub.

## Left to the builder

Cursor encoding across catalogs, ordering inside a page (official order first, then GitHub-only, then Docker),
exact UI layout of the badges and filter (follow the existing search tab), cache invalidation details.

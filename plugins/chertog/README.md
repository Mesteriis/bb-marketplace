# Chertog

Chertog (Чертог) is a plugin for [BB](https://github.com/get-bb/bb) that is
planned to turn BB's Home into a tiling workspace with named layouts. The
implementation brief is [docs/spec.md](./docs/spec.md).

This directory currently holds the package scaffold only. The plugin loads in
BB and registers nothing. See [PLUGIN_OVERVIEW.md](./PLUGIN_OVERVIEW.md) for
what it does today.

## Names

The package is `bb-plugin-chertog` and the plugin id BB derives from it is
`chertog`. Both are fixed by the brief, so this plugin does not follow the
`bb-plugin-makosh-<name>` convention in
[docs/architecture.md](../../docs/architecture.md).

## Layout

| Path | Holds |
| --- | --- |
| `src/core/` | Domain types, ports and application logic. No host code. Empty for now. |
| `src/ui/` | React components that take data and callbacks through props. No host code. Empty for now. |
| `src/adapters/bb/` | BB's implementations of the core's ports. Empty for now. |
| `server.ts`, `app.tsx` | Composition for BB. |
| `tests/architecture.test.ts` | Fails the build when `src/core` or `src/ui` imports host code. |

## Develop

```sh
npm install
npm run check   # typecheck and tests
npm run build   # bb plugin build
```

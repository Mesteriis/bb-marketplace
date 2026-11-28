/**
 * Tool and package versions the built-in scaffolds pin, checked on 2026-11-27 against the registries (npm, PyPI,
 * the Go proxy and go.dev/dl) and the projects' release pages; those marked 2026-11-28 were read from PyPI that day.
 * One place, so a release refreshes them together.
 */
export const versions = {
  // Python
  // uv: the version CI installs and checks are made with (newest on PyPI 2026-11-28); uvMinimum, the lowest uv that has
  // everything the scaffolds' pyproject uses — [dependency-groups] (0.4.27), [tool.uv] package (0.4.0) and
  // required-version (0.5.14), per uv's changelog — and the lower bound their required-version states.
  python: "3.13", uv: "0.13.10", uvMinimum: "0.5.14", ruff: "0.17.6", mypy: "2.4.1", pytest: "9.2.0", hatchling: "1.33.0",
  // Starlette's TestClient now asks for httpx2 instead of httpx.
  fastapi: "0.165.0", uvicorn: "0.54.0", httpx2: "2.16.2",
  // PyPI, 2026-11-28. aiogram's testing toolkit (the [test] extra) needs an async runner: pytest-asyncio.
  aiogram: "3.34.0", pytestAsyncio: "1.5.0",
  // PyPI, 2026-11-28. Django 6.1: django-stubs 6.1.2 declares mypy below 2.5 (5.2's stubs stop below mypy 1.20).
  django: "6.1.3", djangoStubs: "6.1.2", pytestDjango: "4.14.0", celery: "5.7.0", celeryTypes: "0.26.0", gunicorn: "27.0.1",
  pylint: "4.1.4", pylintDjango: "2.8.0", bandit: "1.9.4", poetry: "2.5.2",
  // Docker Hub, 2026-11-28: the newest stable Redis 8 tag.
  redisImage: "8.12-alpine",
  // Go: the oldest supported release as the language version, the newest as the toolchain.
  go: "1.26.0", goToolchain: "1.27.4", golangciLint: "2.15.0", govulncheck: "1.10.0",
  // Node.js and TypeScript. typescript-eslint 8.74 supports TypeScript below 6.1, so typed linting stays on 6.0;
  // BB plugins stay on the 5.x their SDK is built and checked with.
  node: "24", typesNode: "24.19.4", typescript: "6.0.3", typescriptBb: "5.9.3",
  eslint: "10.16.0", eslintJs: "10.0.1", typescriptEslint: "8.74.0", globals: "17.14.0", reactHooks: "7.1.1",
  vite: "8.4.0", vitejsReact: "6.3.0", vitest: "5.1.2", react: "19.3.1", typesReact: "19.3.3", typesReactDom: "19.3.0",
  // A plugin must pin the SDK of the BB that builds it (`bb plugin types` aligns the pin); the default is the SDK this
  // plugin is built with. The SDK's types need its optional peers hono and @types/better-sqlite3, in its own ranges.
  bbSdk: "0.6.157", hono: "4.13.23", typesBetterSqlite3: "7.6.12", zod: "4.6.7",
} as const;

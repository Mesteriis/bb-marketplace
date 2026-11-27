import type { Scaffold } from "../../core/scaffolds/model.ts";
import { versions as v } from "../../core/scaffolds/versions.ts";

/**
 * A Go HTTP service: cmd/ and internal/, golangci-lint v2 and govulncheck pinned, a table test, graceful shutdown;
 * a React + Vite + TypeScript web UI in web/ and Docker by flags. `make check` is what CI runs.
 */
export const goServiceWithWeb: Scaffold = {
  id: "go-service-with-web",
  title: "Go service with a web UI",
  description: "Go HTTP service (cmd/, internal/, golangci-lint, govulncheck) with an optional React + Vite + TypeScript UI and Docker.",
  params: [
    {name: "module", label: "Go module path", kind: "text", default: "example.com/my-project", pattern: "^(?!.*//)(?!.*\\.\\.)[a-z0-9][a-z0-9.-]*/[A-Za-z0-9_./-]*[A-Za-z0-9_]$"},
    {name: "binary", label: "Command name", kind: "text", default: "server", pattern: "^[a-z][a-z0-9-]{0,39}$"},
    {name: "web", label: "Web UI in web/ (React, Vite, TypeScript)", kind: "flag", default: true},
    {name: "docker", label: "Dockerfile and compose.yaml", kind: "flag", default: false},
  ],
  ignore: ["/bin/", "/dist/", "/web/node_modules/", "/web/dist/", "/coverage.out"],
  editorconfig: "[*.go]\nindent_style = tab\n\n[go.mod]\nindent_style = tab\n",
  ci: {make: true},
  files: [
    {path: "go.mod", body: `module {{module}}

go ${v.go}

toolchain go${v.goToolchain}
`},
    {path: "cmd/{{binary}}/main.go", body: `// Command {{binary}} serves the HTTP API until it receives SIGINT or SIGTERM.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"{{module}}/internal/server"
)

func main() {
	if err := run(); err != nil {
		slog.Error("stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           server.New(os.Getenv("WEB_DIR")),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	errs := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", addr)
		errs <- srv.ListenAndServe()
	}()
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		return err
	}
	if err := <-errs; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
`},
    {path: "internal/server/server.go", body: `// Package server holds the HTTP routes.
package server

import (
	"encoding/json"
	"net/http"
)

// New returns the service's handler; webDir, when set, is the built web UI served at /.
func New(webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", health)
	if webDir != "" {
		mux.Handle("GET /", http.FileServer(http.Dir(webDir)))
	}
	return mux
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
`},
    {path: "internal/server/server_test.go", body: `package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		path   string
		status int
		body   string
	}{
		{name: "health", method: http.MethodGet, path: "/api/health", status: http.StatusOK, body: "{\\"status\\":\\"ok\\"}\\n"},
		{name: "health refuses POST", method: http.MethodPost, path: "/api/health", status: http.StatusMethodNotAllowed},
		{name: "unknown path", method: http.MethodGet, path: "/nope", status: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			New("").ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, nil))
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d", rec.Code, tt.status)
			}
			if tt.body != "" && rec.Body.String() != tt.body {
				t.Fatalf("body = %q, want %q", rec.Body.String(), tt.body)
			}
		})
	}
}
`},
    {path: ".golangci.yml", body: `version: "2"

linters:
  default: standard
  enable:
    - bodyclose
    - errorlint
    - gosec
    - misspell

formatters:
  enable:
    - gofmt
    - goimports
`},
    {path: "Makefile", body: `GOLANGCI_LINT_VERSION := v${v.golangciLint}
GOVULNCHECK_VERSION := v${v.govulncheck}
LINT := bin/golangci-lint-$(GOLANGCI_LINT_VERSION)

.PHONY: check fmt fmt-check vet lint test vuln build web-install web-check web-build

# WEB=0 leaves web/ out (CI checks it in a job of its own where one image cannot hold both Go and Node.js).
WEB ?= 1
CHECKS := fmt-check vet lint test vuln
{{#web}}
ifneq ($(WEB),0)
CHECKS += web-check
endif
{{/web}}

check: $(CHECKS)

fmt:
\tgofmt -w .

fmt-check:
\t@test -z "$$(gofmt -l .)" || (gofmt -l .; echo "run make fmt"; exit 1)

vet:
\tgo vet ./...

# golangci-lint is installed as a pinned binary, as its documentation advises, not through go install; the install
# script is taken from the same release tag, and it checks the binary's checksum.
$(LINT):
\tcurl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/$(GOLANGCI_LINT_VERSION)/install.sh | sh -s -- -b bin $(GOLANGCI_LINT_VERSION)
\tmv bin/golangci-lint $(LINT)

lint: $(LINT)
\t$(LINT) run ./...

test:
\tgo test -race ./...

vuln:
\tgo run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION) ./...

build:
\tgo build -o bin/{{binary}} ./cmd/{{binary}}
{{#web}}

# web/ needs Node.js ${v.node}; the first install writes web/package-lock.json, which is committed.
web-install:
\tcd web && if [ -f package-lock.json ]; then npm ci; else npm install; fi

web-check: web-install
\tcd web && npm run check

web-build: web-install
\tcd web && npm run build
{{/web}}
`},
    {path: ".env.example", body: `# Copy to .env for local runs; never commit .env.
# Address to listen on (default 127.0.0.1:8080).
ADDR=
# Folder of the built web UI to serve at / (web/dist after make web-build); empty serves the API only.
WEB_DIR=
`},
    {path: "README.md", body: `# {{name}}

{{description}}

## Development

Needs Go ${v.goToolchain.split(".").slice(0, 2).join(".")} (the toolchain line in go.mod fetches it).

- \`make check\` — gofmt, go vet, golangci-lint, tests with the race detector and govulncheck; CI runs the same target.
- \`go run ./cmd/{{binary}}\` — serves \`GET /api/health\` on \`ADDR\` (default 127.0.0.1:8080).
{{#web}}
- \`cd web && npm run dev\` — the web UI with hot reload (Node.js ${v.node}); commit \`web/package-lock.json\` after the first install.
{{/web}}
{{#docker}}
- \`docker compose up --build\` — runs it in a container.
{{/docker}}
`},
    // The web UI.
    {path: "web/package.json", when: "web", body: `{
  "name": {{name|json}},
  "private": true,
  "type": "module",
  "engines": {"node": ">=${v.node}"},
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "lint": "eslint .",
    "test": "vitest run",
    "check": "tsc --noEmit && eslint . && vitest run && vite build"
  },
  "dependencies": {
    "react": "^${v.react}",
    "react-dom": "^${v.react}"
  },
  "devDependencies": {
    "@eslint/js": "^${v.eslintJs}",
    "@types/node": "^${v.typesNode}",
    "@types/react": "^${v.typesReact}",
    "@types/react-dom": "^${v.typesReactDom}",
    "@vitejs/plugin-react": "^${v.vitejsReact}",
    "eslint": "^${v.eslint}",
    "eslint-plugin-react-hooks": "^${v.reactHooks}",
    "globals": "^${v.globals}",
    "typescript": "~${v.typescript}",
    "typescript-eslint": "^${v.typescriptEslint}",
    "vite": "^${v.vite}",
    "vitest": "^${v.vitest}"
  }
}
`},
    {path: "web/tsconfig.json", when: "web", body: `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": false,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
`},
    {path: "web/vite.config.ts", when: "web", body: `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API runs on 127.0.0.1:8080 in development; the UI calls it through this proxy.
export default defineConfig({
  plugins: [react()],
  server: {proxy: {"/api": "http://127.0.0.1:8080"}},
});
`},
    {path: "web/eslint.config.js", when: "web", body: `import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {ignores: ["dist", "eslint.config.js"]},
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {globals: globals.browser, parserOptions: {projectService: true, tsconfigRootDir: import.meta.dirname}},
    plugins: {"react-hooks": reactHooks},
    rules: reactHooks.configs.recommended.rules,
  },
);
`},
    {path: "web/index.html", when: "web", body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{name}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`},
    {path: "web/src/main.tsx", when: "web", body: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");
createRoot(root).render(<StrictMode><App/></StrictMode>);
`},
    {path: "web/src/App.tsx", when: "web", body: `import { useEffect, useState } from "react";
import { readHealth, type Health } from "./health.ts";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", {signal: controller.signal})
      .then(async response => { setHealth(readHealth(await response.json())); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setHealth({status: "unreachable", detail: String(error)}); });
    return () => { controller.abort(); };
  }, []);
  return <main>
    <h1>{{name}}</h1>
    <p role="status">{health === null ? "Checking the API…" : health.status === "ok" ? "The API is up." : "The API is unreachable."}</p>
  </main>;
}
`},
    {path: "web/src/health.ts", when: "web", body: `/** What the API's health answer means; anything unexpected counts as unreachable. */
export type Health = {status: "ok"} | {status: "unreachable"; detail: string};

export function readHealth(body: unknown): Health {
  if (typeof body === "object" && body !== null && "status" in body && body.status === "ok") return {status: "ok"};
  return {status: "unreachable", detail: "unexpected answer"};
}
`},
    {path: "web/src/health.test.ts", when: "web", body: `import { describe, expect, it } from "vitest";
import { readHealth } from "./health.ts";

describe("readHealth", () => {
  it("accepts the API's ok answer", () => {
    expect(readHealth({status: "ok"})).toEqual({status: "ok"});
  });
  it("treats anything else as unreachable", () => {
    for (const body of [null, "ok", {status: "down"}, []]) expect(readHealth(body).status).toBe("unreachable");
  });
});
`},
    {path: "Dockerfile", when: "docker", body: `# syntax=docker/dockerfile:1
# Pin the base images by digest before a release: docker buildx imagetools inspect <image>.
{{#web}}
FROM node:${v.node}-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web/ ./
RUN npm run build

{{/web}}
FROM golang:${v.goToolchain.split(".").slice(0, 2).join(".")} AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/{{binary}} ./cmd/{{binary}}

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/{{binary}} /{{binary}}
{{#web}}
COPY --from=web /web/dist /web
{{/web}}
ENV ADDR=0.0.0.0:8080
{{#web}}
ENV WEB_DIR=/web
{{/web}}
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/{{binary}}"]
`},
    {path: "compose.yaml", when: "docker", body: `services:
  app:
    build: .
    ports:
      - "8080:8080"
    env_file:
      - path: .env
        required: false
`},
    {path: ".dockerignore", when: "docker", body: `.git
bin
.env
.env.*
web/node_modules
web/dist
`},
  ],
};

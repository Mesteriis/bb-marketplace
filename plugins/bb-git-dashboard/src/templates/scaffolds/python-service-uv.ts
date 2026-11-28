import type { Scaffold } from "../../core/scaffolds/model.ts";
import { versions as v } from "../../core/scaffolds/versions.ts";

/**
 * A Python service on uv: src layout, hatchling, Ruff, mypy strict and pytest, a Makefile whose `check` CI runs, typed
 * settings from the environment, and a plain asyncio service, a FastAPI app or an aiogram Telegram bot; Docker by a flag
 * (uv's Docker recipe).
 */
export const pythonServiceUv: Scaffold = {
  id: "python-service-uv",
  title: "Python service (uv)",
  description: "Python on uv with Ruff, mypy strict and pytest; a plain asyncio service, a FastAPI app or an aiogram bot; Docker optional.",
  params: [
    {name: "package", label: "Python package (import name)", kind: "text", default: "app", pattern: "^[a-z_][a-z0-9_]{0,59}$"},
    {name: "python", label: "Python version", kind: "choice", default: v.python, choices: ["3.12", "3.13", "3.14"]},
    {name: "variant", label: "Kind of service", kind: "choice", default: "plain", choices: ["plain", "fastapi", "aiogram"]},
    {name: "docker", label: "Dockerfile and compose.yaml", kind: "flag", default: false},
  ],
  ignore: ["__pycache__/", ".venv/", ".mypy_cache/", ".ruff_cache/", ".pytest_cache/", "dist/", "*.egg-info/"],
  editorconfig: "[*.py]\nindent_size = 4\n",
  ci: {pythonTool: "uv", lockfile: false, make: true},
  files: [
    {path: "pyproject.toml", body: `[project]
name = {{name|json}}
version = "0.1.0"
description = {{description|json}}
readme = "README.md"
requires-python = ">={{python}}"
{{#license=MIT}}
license = "MIT"
license-files = ["LICENSE"]
{{/license}}
{{#license=Apache-2.0}}
license = "Apache-2.0"
license-files = ["LICENSE"]
{{/license}}
dependencies = [
{{#variant=fastapi}}
    "fastapi==${v.fastapi}",
    "uvicorn==${v.uvicorn}",
{{/variant}}
{{#variant=aiogram}}
    "aiogram==${v.aiogram}",
{{/variant}}
]

[project.scripts]
{{name|json}} = "{{package}}.__main__:main"

[build-system]
requires = ["hatchling==${v.hatchling}"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/{{package}}"]

[dependency-groups]
dev = [
{{#variant=aiogram}}
    "aiogram[test]==${v.aiogram}",
{{/variant}}
{{#variant=fastapi}}
    "httpx2==${v.httpx2}",
{{/variant}}
    "mypy==${v.mypy}",
    "pytest==${v.pytest}",
{{#variant=aiogram}}
    "pytest-asyncio==${v.pytestAsyncio}",
{{/variant}}
    "ruff==${v.ruff}",
]

[tool.uv]
required-version = ">=${v.uvMinimum}"

[tool.ruff]
line-length = 120

[tool.ruff.lint]
extend-select = ["B", "I", "UP", "SIM", "RUF", "ASYNC"]

[tool.mypy]
strict = true
warn_unreachable = true
files = ["src", "tests"]

[tool.pytest]
addopts = ["-ra", "--strict-markers"]
testpaths = ["tests"]
{{#variant=aiogram}}
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
{{/variant}}
`},
    {path: "src/{{package}}/__init__.py", body: `"""The {{package}} package."""
`},
    {path: "src/{{package}}/config.py", body: `"""Settings read from the environment once, where the program starts; .env.example lists the keys."""

import os
from dataclasses import dataclass
from typing import Self


@dataclass(frozen=True)
class Settings:
{{#variant=plain}}
    interval: float = 30.0

    @classmethod
    def from_env(cls) -> Self:
        raw = os.environ.get("APP_INTERVAL", "")
        if not raw:
            return cls()
        interval = float(raw)
        if interval <= 0:
            raise ValueError("APP_INTERVAL must be a positive number of seconds")
        return cls(interval=interval)
{{/variant}}
{{#variant=fastapi}}
    host: str = "127.0.0.1"
    port: int = 8000

    @classmethod
    def from_env(cls) -> Self:
        port = int(os.environ.get("APP_PORT") or 8000)
        if not 0 < port < 65536:
            raise ValueError("APP_PORT must be a TCP port")
        return cls(host=os.environ.get("APP_HOST") or "127.0.0.1", port=port)
{{/variant}}
{{#variant=aiogram}}
    token: str

    @classmethod
    def from_env(cls) -> Self:
        token = os.environ.get("BOT_TOKEN", "")
        if not token:
            raise ValueError("BOT_TOKEN must be set: the bot's token from @BotFather")
        return cls(token=token)
{{/variant}}
`},
    {path: "src/{{package}}/service.py", when: "variant=plain", body: `"""The service's work: here a heartbeat, to be replaced by the real loop."""

import asyncio
import logging

log = logging.getLogger(__name__)


async def heartbeat(interval: float, *, beats: int | None = None) -> int:
    """Logs every interval; stops after beats when given (tests), else runs until cancelled."""
    count = 0
    while beats is None or count < beats:
        await asyncio.sleep(interval)
        count += 1
        log.info("alive (%d)", count)
    return count
`},
    {path: "src/{{package}}/app.py", when: "variant=fastapi", body: `"""The HTTP application."""

from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="{{name}}")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
`},
    {path: "src/{{package}}/bot.py", when: "variant=aiogram", body: `"""The bot's handlers. A router joins one dispatcher only, so each dispatcher gets a new one from create_router()."""

from aiogram import F, Router
from aiogram.filters import CommandStart
from aiogram.types import Message

GREETING = "Hello! Send me any text and I will send it back."


def create_router() -> Router:
    router = Router(name="{{package}}")

    @router.message(CommandStart())
    async def start(message: Message) -> None:
        await message.answer(GREETING)

    @router.message(F.text)
    async def echo(message: Message) -> None:
        await message.answer(message.text or "")

    return router
`},
    {path: "src/{{package}}/__main__.py", body: `"""Entry point."""

{{#variant=plain}}
import asyncio
import logging

from {{package}}.config import Settings
from {{package}}.service import heartbeat


async def run(settings: Settings) -> None:
    # A task group: a failing task cancels the others and nothing is left running unseen.
    async with asyncio.TaskGroup() as tasks:
        tasks.create_task(heartbeat(settings.interval))


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run(Settings.from_env()))
{{/variant}}
{{#variant=fastapi}}
import uvicorn

from {{package}}.config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run("{{package}}.app:create_app", factory=True, host=settings.host, port=settings.port)
{{/variant}}
{{#variant=aiogram}}
import asyncio
import logging

from aiogram import Bot, Dispatcher

from {{package}}.bot import create_router
from {{package}}.config import Settings


async def run(settings: Settings) -> None:
    dispatcher = Dispatcher()
    dispatcher.include_router(create_router())
    async with Bot(token=settings.token) as bot:
        await dispatcher.start_polling(bot)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run(Settings.from_env()))
{{/variant}}


if __name__ == "__main__":
    main()
`},
    {path: "tests/test_service.py", when: "variant=plain", body: `import asyncio

import pytest

from {{package}}.config import Settings
from {{package}}.service import heartbeat


def test_heartbeat_stops_after_the_given_beats() -> None:
    assert asyncio.run(heartbeat(0, beats=3)) == 3


def test_settings_refuse_a_non_positive_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_INTERVAL", "0")
    with pytest.raises(ValueError, match="APP_INTERVAL"):
        Settings.from_env()
`},
    {path: "tests/test_app.py", when: "variant=fastapi", body: `from fastapi.testclient import TestClient

from {{package}}.app import create_app


def test_health_answers_ok() -> None:
    response = TestClient(create_app()).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
`},
    {path: "tests/test_bot.py", when: "variant=aiogram", body: `"""The bot against aiogram's testing toolkit: a fake Telegram in memory, no network (aiogram[test], pytest-asyncio)."""

import pytest
from aiogram import Dispatcher
from aiogram.test import ChatState, UserActor

from {{package}}.bot import GREETING, create_router
from {{package}}.config import Settings


@pytest.fixture
def bot_dispatcher() -> Dispatcher:
    dispatcher = Dispatcher()
    dispatcher.include_router(create_router())
    return dispatcher


async def test_start_greets(bot_user: UserActor, bot_chat: ChatState) -> None:
    await bot_user.send("/start")
    assert bot_chat.messages[-1].text == GREETING


async def test_text_comes_back(bot_user: UserActor, bot_chat: ChatState) -> None:
    await bot_user.send("ping")
    assert bot_chat.messages[-1].text == "ping"


def test_settings_need_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BOT_TOKEN", raising=False)
    with pytest.raises(ValueError, match="BOT_TOKEN"):
        Settings.from_env()
`},
    {path: "Makefile", body: `.PHONY: bootstrap check lint test fmt build

# Creates the environment and uv.lock; commit uv.lock afterwards.
bootstrap:
\tuv sync

check: lint test

lint:
\tuv run ruff check .
\tuv run ruff format --check .
\tuv run mypy

test:
\tuv run pytest

fmt:
\tuv run ruff check --fix .
\tuv run ruff format .

build:
\tuv build
`},
    {path: ".pre-commit-config.yaml", body: `repos:
  - repo: https://github.com/astral-sh/uv-pre-commit
    rev: ${v.uv}
    hooks:
      - id: uv-lock
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v${v.ruff}
    hooks:
      - id: ruff-check
        args: [--fix]
      - id: ruff-format
`},
    {path: ".env.example", body: `# Copy to .env for local runs; never commit .env.
{{#variant=plain}}
# Seconds between heartbeats (default 30).
APP_INTERVAL=
{{/variant}}
{{#variant=fastapi}}
# Address and port to listen on (default 127.0.0.1:8000).
APP_HOST=
APP_PORT=
{{/variant}}
{{#variant=aiogram}}
# The bot's token from @BotFather (required).
BOT_TOKEN=
{{/variant}}
`},
    {path: "README.md", body: `# {{name}}

{{description}}

## Development

Needs [uv](https://docs.astral.sh/uv/).

- \`make bootstrap\` — creates the environment and \`uv.lock\`; commit \`uv.lock\`.
- \`make check\` — Ruff, mypy and pytest; CI runs the same target.
- \`make fmt\` — fixes formatting and imports.
{{#variant=plain}}
- \`uv run {{name}}\` — runs the service; settings are listed in \`.env.example\`.
{{/variant}}
{{#variant=fastapi}}
- \`uv run {{name}}\` — serves the API; \`GET /health\` answers \`{"status": "ok"}\`.
{{/variant}}
{{#variant=aiogram}}
- \`uv run {{name}}\` — runs the bot by long polling; \`BOT_TOKEN\` comes from the environment (see \`.env.example\`).
- Tests talk to aiogram's in-memory fake Telegram (\`aiogram[test]\`, experimental in aiogram 3); nothing goes to the network.
{{/variant}}
{{#docker}}
- \`docker compose up --build\` — runs it in a container (after \`make bootstrap\`: the image installs from \`uv.lock\`).
{{/docker}}
`},
    {path: "Dockerfile", when: "docker", body: `# syntax=docker/dockerfile:1
# Pin the base images by digest before a release: docker buildx imagetools inspect <image>.
FROM ghcr.io/astral-sh/uv:${v.uv} AS uv

FROM python:{{python}}-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \\
    --mount=type=bind,source=uv.lock,target=uv.lock \\
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \\
    uv sync --locked --no-install-project --no-dev
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable

FROM python:{{python}}-slim
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=build --chown=10001:10001 /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"
USER 10001:10001
WORKDIR /app
CMD ["{{name}}"]
`},
    {path: "compose.yaml", when: "docker", body: `services:
  app:
    build: .
    env_file:
      - path: .env
        required: false
{{#variant=fastapi}}
    environment:
      APP_HOST: 0.0.0.0
    ports:
      - "8000:8000"
{{/variant}}
`},
    {path: ".dockerignore", when: "docker", body: `.git
.venv
.env
.env.*
**/__pycache__
.mypy_cache
.ruff_cache
.pytest_cache
dist
`},
  ],
};

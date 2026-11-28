import type { Scaffold } from "../../core/scaffolds/model.ts";
import { versions as v } from "../../core/scaffolds/versions.ts";

// The Makefile's runner: uv or Poetry, one line each so the rest of the Makefile is the same for both.
const run = "$(RUN)";

/**
 * A Django 6.1 site on uv (or Poetry, for the older projects that use it with GitLab CI): settings from the
 * environment, one app with a health view, Ruff, mypy strict with django-stubs, pytest-django, and the migration check
 * in `make check`; Celery, Docker (gunicorn behind compose) and pylint with bandit by flags.
 */
export const djangoUv: Scaffold = {
  id: "django-uv",
  title: "Django site (uv or Poetry)",
  description: "Django 6.1 with Ruff, mypy and django-stubs, pytest-django; Celery, Docker, pylint and bandit optional; uv or Poetry.",
  params: [
    {name: "project", label: "Django project package (settings, URLs)", kind: "text", default: "config", pattern: "^[a-z_][a-z0-9_]{0,59}$"},
    {name: "python", label: "Python version", kind: "choice", default: v.python, choices: ["3.12", "3.13", "3.14"]},
    {name: "tool", label: "Dependency manager", kind: "choice", default: "uv", choices: ["uv", "poetry"]},
    {name: "celery", label: "Celery worker (Redis broker)", kind: "flag", default: false},
    {name: "docker", label: "Dockerfile and compose.yaml (gunicorn)", kind: "flag", default: false},
    {name: "strictLint", label: "pylint with pylint-django, and bandit", kind: "flag", default: false},
  ],
  ignore: ["__pycache__/", ".venv/", ".mypy_cache/", ".ruff_cache/", ".pytest_cache/", "db.sqlite3", "staticfiles/"],
  editorconfig: "[*.py]\nindent_size = 4\n\n[*.html]\nindent_size = 2\n",
  // The dependency manager is read from the files: [tool.uv] or [tool.poetry].
  ci: {lockfile: false, make: true},
  files: [
    {path: "pyproject.toml", body: `[project]
name = {{name|json}}
version = "0.1.0"
description = {{description|json}}
readme = "README.md"
{{#tool=uv}}
requires-python = ">={{python}}"
{{/tool}}
{{#tool=poetry}}
# Poetry resolves for every Python in this range: its upper bound meets the dependencies' own.
requires-python = ">={{python}},<4"
{{/tool}}
{{#license=MIT}}
license = "MIT"
{{/license}}
{{#license=Apache-2.0}}
license = "Apache-2.0"
{{/license}}
dependencies = [
{{#celery}}
    "celery[redis]==${v.celery}",
{{/celery}}
    "django==${v.django}",
{{#docker}}
    "gunicorn==${v.gunicorn}",
{{/docker}}
]

[dependency-groups]
dev = [
{{#strictLint}}
    "bandit==${v.bandit}",
{{/strictLint}}
{{#celery}}
    "celery-types==${v.celeryTypes}",
{{/celery}}
    "django-stubs[compatible-mypy]==${v.djangoStubs}",
    "mypy==${v.mypy}",
{{#strictLint}}
    "pylint==${v.pylint}",
    "pylint-django==${v.pylintDjango}",
{{/strictLint}}
    "pytest==${v.pytest}",
    "pytest-django==${v.pytestDjango}",
    "ruff==${v.ruff}",
]

{{#tool=uv}}
[tool.uv]
package = false
required-version = ">=${v.uv}"
{{/tool}}
{{#tool=poetry}}
[tool.poetry]
package-mode = false
requires-poetry = ">=${v.poetry}"
{{/tool}}

[tool.ruff]
line-length = 120

[tool.ruff.lint]
extend-select = ["B", "I", "UP", "SIM", "RUF", "DJ"]

[tool.mypy]
strict = true
warn_unreachable = true
plugins = ["mypy_django_plugin.main"]
files = ["{{project}}", "core", "tests", "manage.py"]

[tool.django-stubs]
django_settings_module = "{{project}}.test_settings"

[tool.pytest]
addopts = ["-ra", "--strict-markers"]
testpaths = ["tests"]
DJANGO_SETTINGS_MODULE = "{{project}}.test_settings"
{{#strictLint}}

[tool.pylint.main]
load-plugins = ["pylint_django"]
django-settings-module = "{{project}}.test_settings"

[tool.pylint.format]
# The same limit as Ruff's.
max-line-length = 120

[tool.pylint."messages control"]
# Docstrings are asked for where they say something, not on every module and function.
disable = ["missing-module-docstring", "missing-function-docstring", "missing-class-docstring"]

[tool.bandit]
exclude_dirs = ["tests", ".venv"]
{{/strictLint}}
`},
    {path: "manage.py", executable: true, body: `#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""

import os
import sys


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "{{project}}.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`},
    {path: "{{project}}/__init__.py", body: `"""The Django project: settings, URLs and the WSGI and ASGI entry points."""
{{#celery}}

# The Celery app loads with Django, so @shared_task binds to it.
from .celery import app as celery_app

__all__ = ("celery_app",)
{{/celery}}
`},
    {path: "{{project}}/settings.py", body: `"""Django settings, read from the environment once at start; .env.example lists the keys."""

import os
import secrets
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent

# 1 for local development only: detailed errors and a key for this run.
DEBUG = os.environ.get("DJANGO_DEBUG", "") == "1"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set unless DJANGO_DEBUG=1")
    # Sessions and signed values of this run do not outlive it.
    SECRET_KEY = secrets.token_urlsafe(50)
ALLOWED_HOSTS = [host for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",") if host]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "core",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "{{project}}.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "{{project}}.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Outside debug the site is HTTPS only; set DJANGO_HSTS_SECONDS once HTTPS works everywhere (manage.py check --deploy).
if not DEBUG:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_SSL_REDIRECT = os.environ.get("DJANGO_SSL_REDIRECT", "1") == "1"
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "0"))
{{#celery}}

# Celery reads the CELERY_ settings (namespace="CELERY" in {{project}}/celery.py).
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "")
{{/celery}}
`},
    {path: "{{project}}/test_settings.py", body: `"""Settings for tests and type checks: debug on, so a key of the run, and a database in memory."""

import os

os.environ.setdefault("DJANGO_DEBUG", "1")

{{#strictLint}}
# pylint: disable=wildcard-import,unused-wildcard-import,wrong-import-position
{{/strictLint}}
from .settings import *

DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
`},
    {path: "{{project}}/urls.py", body: `from django.contrib import admin
from django.urls import path

from core.views import health

urlpatterns = [
    path("admin/", admin.site.urls),
    path("health/", health, name="health"),
]
`},
    {path: "{{project}}/wsgi.py", body: `"""The WSGI entry point (gunicorn {{project}}.wsgi)."""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "{{project}}.settings")

application = get_wsgi_application()
`},
    {path: "{{project}}/asgi.py", body: `"""The ASGI entry point."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "{{project}}.settings")

application = get_asgi_application()
`},
    {path: "{{project}}/celery.py", when: "celery", body: `"""The Celery app: its settings are Django's with the CELERY_ prefix; tasks are found in the installed apps."""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "{{project}}.settings")

app = Celery("{{project}}")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
`},
    {path: "core/__init__.py", body: `"""The site's first app."""
`},
    {path: "core/apps.py", body: `from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core"
`},
    {path: "core/views.py", body: `from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET


@require_GET
def health(request: HttpRequest) -> JsonResponse:
    """Answers that the site is up; a load balancer's check."""
    return JsonResponse({"status": "ok"})
`},
    {path: "core/tasks.py", when: "celery", body: `from celery import shared_task


@shared_task
def ping() -> str:
    """A task to see the worker answer; replace with the site's own."""
    return "pong"
`},
    {path: "tests/__init__.py", body: `"""The site's tests."""
`},
    {path: "tests/test_health.py", body: `from django.test import Client


def test_health_answers_ok(client: Client) -> None:
    response = client.get("/health/")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_refuses_post(client: Client) -> None:
    assert client.post("/health/").status_code == 405
`},
    {path: "tests/test_tasks.py", when: "celery", body: `from core.tasks import ping


def test_ping_runs_in_process() -> None:
    # apply() runs the task here, without a broker or a worker.
    assert ping.apply().get() == "pong"
`},
    {path: "Makefile", body: `.PHONY: bootstrap check lint test migrations deploy-check fmt run

{{#tool=uv}}
RUN := uv run
{{/tool}}
{{#tool=poetry}}
RUN := poetry run
{{/tool}}
TEST_SETTINGS := --settings={{project}}.test_settings

# Creates the environment and the lock file; commit it afterwards.
bootstrap:
{{#tool=uv}}
\tuv sync
{{/tool}}
{{#tool=poetry}}
\tpoetry install
{{/tool}}

check: lint test migrations

lint:
\t${run} ruff check .
\t${run} ruff format --check .
\t${run} mypy
{{#strictLint}}
\t${run} pylint {{project}} core tests
\t${run} bandit -q -c pyproject.toml -r .
{{/strictLint}}

test:
\t${run} pytest

# Fails when a model changed without its migration; the system checks with the test settings.
migrations:
\t${run} python manage.py makemigrations --check $(TEST_SETTINGS)
\t${run} python manage.py check $(TEST_SETTINGS)

# The deployment checks, with the production environment set (DJANGO_SECRET_KEY, DJANGO_ALLOWED_HOSTS, ...).
deploy-check:
\t${run} python manage.py check --deploy

fmt:
\t${run} ruff check --fix .
\t${run} ruff format .

run:
\tDJANGO_DEBUG=1 ${run} python manage.py runserver
`},
    {path: ".pre-commit-config.yaml", body: `repos:
{{#tool=uv}}
  - repo: https://github.com/astral-sh/uv-pre-commit
    rev: ${v.uv}
    hooks:
      - id: uv-lock
{{/tool}}
{{#tool=poetry}}
  - repo: https://github.com/python-poetry/poetry
    rev: ${v.poetry}
    hooks:
      - id: poetry-check
      - id: poetry-lock
{{/tool}}
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v${v.ruff}
    hooks:
      - id: ruff-check
        args: [--fix]
      - id: ruff-format
`},
    {path: ".env.example", body: `# Copy to .env for local runs; never commit .env.
# 1 for local development only (detailed errors, a key of the run).
DJANGO_DEBUG=
# Required unless DJANGO_DEBUG is 1.
DJANGO_SECRET_KEY=
# Host names the site answers to, comma-separated.
DJANGO_ALLOWED_HOSTS=
# Seconds browsers keep to HTTPS (HSTS); set once HTTPS works everywhere.
DJANGO_HSTS_SECONDS=
{{#celery}}
# Celery's broker, for example redis://redis:6379/0 with compose.yaml.
CELERY_BROKER_URL=
{{/celery}}
`},
    {path: "README.md", body: `# {{name}}

{{description}}

## Development

{{#tool=uv}}
Needs [uv](https://docs.astral.sh/uv/).

- \`make bootstrap\` — creates the environment and \`uv.lock\`; commit \`uv.lock\`.
{{/tool}}
{{#tool=poetry}}
Needs [Poetry](https://python-poetry.org/) ${v.poetry} or newer.

- \`make bootstrap\` — creates the environment and \`poetry.lock\`; commit \`poetry.lock\`.
{{/tool}}
- \`make check\` — Ruff, mypy with django-stubs, pytest-django and the migration check; CI runs the same target.
- \`make run\` — the development server with \`DJANGO_DEBUG=1\`; \`/health/\` answers \`{"status": "ok"}\`.
- \`make deploy-check\` — \`manage.py check --deploy\` with the production environment set.

Settings come from the environment, listed in \`.env.example\`.
{{#celery}}
Celery reads its \`CELERY_\` settings from Django's; \`core/tasks.py\` has a first task.
{{/celery}}
{{#docker}}
- \`docker compose up --build\` — the site under gunicorn in a container (after \`make bootstrap\`: the image installs from the lock file).
{{/docker}}
{{#celery}}
{{#docker}}
  With Celery, compose also runs a worker and Redis.
{{/docker}}
{{/celery}}
`},
    {path: "Dockerfile", when: "docker", body: `# syntax=docker/dockerfile:1
# Pin the base images by digest before a release: docker buildx imagetools inspect <image>.
{{#tool=uv}}
FROM ghcr.io/astral-sh/uv:${v.uv} AS uv

FROM python:{{python}}-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \\
    --mount=type=bind,source=uv.lock,target=uv.lock \\
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \\
    uv sync --locked --no-dev
{{/tool}}
{{#tool=poetry}}
FROM python:{{python}}-slim AS build
RUN pip install --no-cache-dir poetry==${v.poetry}
ENV POETRY_VIRTUALENVS_IN_PROJECT=1 POETRY_NO_INTERACTION=1
WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN poetry install --only main
{{/tool}}

FROM python:{{python}}-slim
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=build --chown=10001:10001 /app/.venv /app/.venv
WORKDIR /app
COPY --chown=10001:10001 . /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8000
# Docker runs the process, so gunicorn's control socket (for gunicornc, in the home the app user has not) is off.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--no-control-socket", "{{project}}.wsgi"]
`},
    {path: "compose.yaml", when: "docker", body: `services:
  web:
    build: .
    env_file:
      - path: .env
        required: false
    ports:
      - "8000:8000"
{{#celery}}
    environment:
      CELERY_BROKER_URL: redis://redis:6379/0
    depends_on:
      - redis
  worker:
    build: .
    command: ["celery", "-A", "{{project}}", "worker", "--loglevel=INFO"]
    env_file:
      - path: .env
        required: false
    environment:
      CELERY_BROKER_URL: redis://redis:6379/0
    depends_on:
      - redis
  redis:
    image: redis:${v.redisImage}
{{/celery}}
`},
    {path: ".dockerignore", when: "docker", body: `.git
.venv
.env
.env.*
**/__pycache__
.mypy_cache
.ruff_cache
.pytest_cache
db.sqlite3
staticfiles
`},
  ],
};

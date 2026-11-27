# Makosh site and read-status endpoint

What answers at the site's public address (`MAKOSH_ORIGIN`): four pages (the project and
the marketplace, Makosh Mail, the privacy policy, the terms) and the
endpoint that Makosh Mail's read statuses use. Node standard library only.

| Path | What |
| --- | --- |
| `/`, `/mail`, `/privacy`, `/terms` | pages (`src/pages.mjs`), the catalog from `catalog.json` |
| `/o/<token>.gif` | a 1×1 image; a token signed with `MAKOSH_TRACK_KEY` is recorded (token, time, coarse client kind — no IP address) |
| `/api/events?after=N` | the recorded opens after sequence number N, `Authorization: Bearer <MAKOSH_API_KEY>` |
| `/healthz` | `ok` |

A token is `<id>.<sig>`: `id` is 16–32 base64url characters, `sig` the
first 16 base64url characters of HMAC-SHA256(`MAKOSH_TRACK_KEY`, `id`).
Opens are kept 90 days, at most 100 per token and 50 000 in all; the same
token and client kind inside a minute is one open. The feed answers
`{ events, next, epoch, last }`: `epoch` is a random id of the store (kept
in `<data file>.state` with the highest number given), so numbers are never
reused and a reader that sees another epoch starts over.

Environment: `MAKOSH_TRACK_KEY`, `MAKOSH_API_KEY` (32+ characters each),
`MAKOSH_ORIGIN` (the site's public https address, like
`https://makosh.example.org`; without it the server does not start),
`MAKOSH_DATA_FILE`, `MAKOSH_CONTACT_EMAIL`,
`MAKOSH_GOOGLE_SITE_VERIFICATION` (the meta tag's content) or
`MAKOSH_GOOGLE_VERIFICATION_FILE` (`google<16 hex>.html`), `PORT`.

- Tests: `node --test test/*.test.mjs` (from this folder).
- Catalog: `node site/scripts/catalog.mjs` from the repository root after
  `marketplace.json` changes, then deploy.
- Deployment: `deploy/compose.yml` (the public address and the address the
  proxy reaches come from `.env`: `MAKOSH_ORIGIN`, `MAKOSH_BIND`) and
  `deploy/nginx-site.conf.example`; where the maintainer's own copy runs is
  described in their infrastructure wiki.

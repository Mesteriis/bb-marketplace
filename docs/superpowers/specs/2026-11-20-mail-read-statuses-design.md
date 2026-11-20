# Makosh Mail: read statuses — design

Date: 2026-11-20. Status: the way is decided (the owner, 2026-11-20:
their own public endpoint at `makosh.sh-inc.dev`, on their server); the
endpoint is built and running (`site/`), the plugin side is not built yet.
Ninth of nine projects that bring Superhuman Mail's features to Makosh Mail.

## Intent

Superhuman shows under a sent message when it was opened, how many times
and on what kind of device. It does this with a tiny remote image in the
message: the recipient's mail program fetches it, and the fetch is the
"read".

## The decision that is needed

The image must live at a public HTTPS address that the recipient's
program can reach. Makosh Mail runs on the owner's computer and has no
such address. Three ways:

1. **The owner's own endpoint (recommended).** A very small service the
   owner runs (a Cloudflare Worker with a KV store, or a container on
   their server): `GET /o/<token>.gif` records the time and answers a
   1×1 image; `GET /events?since=…` with a secret gives the records to
   Makosh Mail, which asks every few minutes. The token is random and
   says nothing about the message; the endpoint never learns addresses,
   subjects or text. Needs: where to run it, a domain, and the owner's
   go-ahead to deploy something public.
2. **Receipts without an endpoint.** Ask for a read receipt with the
   standard header (`Disposition-Notification-To`) and show the receipts
   that come back. Nothing public is needed, but few programs answer
   (Gmail's web page never does for personal accounts), and Outlook asks
   the recipient "send a receipt?" for every message — visible, and to
   some people rude.
3. **A tunnel to this computer** (Tailscale Funnel, `bb connect`). Not
   offered: it opens the owner's computer to the internet, and opens are
   lost whenever the computer sleeps.

## What is the same whichever way is chosen

- Setting `readStatuses`, on by default (the owner's decision), with a
  per-message switch in the composer ("Track opens") and per-recipient
  exceptions (never track an address or a domain).
- Store (migration 26): `sent_tracking` (message id, token, created at)
  and `open_events` (token, at, kind of device as far as it can be told,
  never an IP address). Kept 90 days.
- Page: under a sent message, "Opened 3 times, last today 14:05"; in the
  conversation list a small mark on conversations whose last message of
  the owner's was opened; a row in Today for "opened, not answered".
- What a "read" does not prove is said on the page: Apple Mail's privacy
  protection and Gmail's image proxy fetch images on their own, so an
  open may be a machine, and no open does not mean unread.
- Never in: encrypted or signed mail (the body must not change), mail
  the owner sends to themselves, plain-text-only messages.
- Agents and AI get no part of this: not a tool, not in agent text.

## The endpoint as built

`site/` in this repository, running at `https://makosh.sh-inc.dev`:
`GET /o/<token>.gif` and `GET /api/events?after=N` with a bearer key. A
token is `<id>.<sig>`: 16–32 base64url characters and the first 16
base64url characters of HMAC-SHA256(track key, id); only signed tokens
are recorded, the image is the same for every request. Kept per open:
sequence number, token, time, coarse client kind; never an IP address.
90 days, 100 opens a token. The plugin needs two secrets (the track key
and the feed key), kept in its vault and entered once by the owner.

## Superseded: what was undecided

Whether the recommended endpoint is a Cloudflare Worker or a container
on the owner's server; its domain; who deploys it.

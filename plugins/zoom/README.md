# Makosh Zoom

A Zoom client for [BB](https://github.com/get-bb/bb): a calendar of your Zoom
meetings, scheduling and instant meetings, and the call itself inside BB.

See [PLUGIN_OVERVIEW.md](./PLUGIN_OVERVIEW.md) for what it does, its setup
and its limits.

## Create the Zoom app

1. Open the [Zoom App Marketplace](https://marketplace.zoom.us/), choose
   **Develop → Build App → General App**, and keep it **User-managed**.
2. Under **Embed**, turn on **Meeting SDK**.
3. Open the plugin's page in BB. It shows the redirect URL for the address BB
   is open on. Add it to **OAuth Redirect URL** and to **OAuth Allow List**.
4. Under **Scopes**, add `meeting:read:list_meetings`,
   `meeting:write:meeting`, `user:read:user` and `user:read:token`.
5. Copy the Client ID and Client Secret into the plugin settings
   (Settings → Installed plugins → Makosh Zoom).
6. Press **Войти через Zoom** on the plugin's page and approve the app.

## Settings

| Setting | Meaning |
| --- | --- |
| Zoom Client ID | Client ID of your Zoom app. |
| Zoom Client Secret | Its Client Secret. Secret; never sent to the browser. |
| Token encryption key | Generated on first load. Changing it disconnects the account. |

## Layout

| Path | Holds |
| --- | --- |
| `src/core/` | OAuth, the Zoom REST calls, the Meeting SDK signature, link parsing, the week layout, the wire contract. No host code. |
| `src/ui/` | The page: connect screen, week calendar, new-meeting dialog, join by link, call panel. |
| `src/adapters/bb/` | Encrypted token storage, HTTP routes (`/oauth/callback`, `/call`), the call page, the RPC binding. |
| `server.ts`, `app.tsx` | Composition for BB. |

The Meeting SDK version the call page loads is pinned in
`src/adapters/bb/call-page.ts` (`MEETING_SDK_VERSION`).

## Develop

```sh
npm install
npm run check   # typecheck and tests
npm run build   # bb plugin build
```

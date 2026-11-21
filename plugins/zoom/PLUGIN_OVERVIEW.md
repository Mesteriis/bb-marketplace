Makosh Zoom is a small Zoom client for your own account: see your meetings,
create one, and take the call without leaving BB.

## What you get

- A **Zoom** page in the sidebar with a week of your upcoming Zoom meetings,
  Monday to Sunday, in your time zone.
- **New meeting**: schedule one with a topic, start and duration, or start an
  instant meeting and enter it right away.
- **Join** a meeting from the calendar as its host, or paste any Zoom link or
  meeting number and join as a participant.
- The call runs inside BB through Zoom's Meeting SDK for web, in BB's colours
  and sized to the panel. **В браузере** moves it to your default browser and
  **Открыть в Zoom** to the Zoom app.

Nothing else: no chat, recordings, transcription, agent tools or CLI.

## Setup

The plugin uses your own Zoom app. Create a **General app** (user-managed) in
the Zoom App Marketplace, enable Meeting SDK in it, and add the scopes
`meeting:read:list_meetings`, `meeting:write:meeting`, `user:read:user` and
`user:read:token`. Register the redirect URL the plugin's page shows, put the
app's Client ID and Client Secret into the plugin settings, then press
**Войти через Zoom**.

BB must be open on `https://…` or on `http://127.0.0.1:<port>`. For a
`127.0.0.1` address Zoom needs **Use public client OAuth** turned on, the URL
in **PKCE OAuth Redirect URL**, and the app's Public client ID in the plugin
settings.

## Limits

- One Zoom account.
- Inside BB a call has no camera and no screen sharing: the BB app has no
  camera permission and cannot capture the screen. The microphone works once
  macOS allows it for bb. Use **В браузере** for video and screen sharing.
- Zoom lets an unpublished Meeting SDK app into meetings of its own account
  only. A meeting hosted by another account may be refused in the embedded
  call; the page then offers to open it in the Zoom app.
- The calendar lists meetings Zoom returns for your account. Invitations that
  exist only in another calendar are not shown; join them by link.
- The page text is Russian.

## Privacy

The Client Secret and the OAuth tokens stay on the BB server; tokens are
encrypted at rest. The browser receives a signature for one meeting and your
Zoom access key (ZAK), which Zoom's SDK needs to join as you. The call page
loads Zoom's SDK from `source.zoom.us` in a sandboxed frame and talks to Zoom's
servers only.

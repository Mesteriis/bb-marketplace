# Changelog

## Unreleased

- **В браузере**: open the same call in the system browser, where screen sharing works. BB itself has no screen-capture handler.
- The call page takes BB's theme colours and refits Zoom's view whenever the panel is resized.
- The call panel names the reason when the browser refuses the camera, microphone or screen.

- Sign in as a PKCE public client when a Public client ID is set: Zoom accepts a `127.0.0.1` redirect only that way.

- First version: Zoom sign-in (OAuth with PKCE), a week calendar of the account's upcoming meetings, scheduled and instant meeting creation, and joining a call inside BB through Zoom's Meeting SDK, with a hand-off to the Zoom app.

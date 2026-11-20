# Makosh Mail: dictation — design

Date: 2026-11-20. Status: approved in advance (the owner, 2026-11-19:
"Завершай все что наметили"). The decisions below are the builder's and
are listed in the final report. Seventh of nine projects that bring
Superhuman Mail's features to Makosh Mail.

## Intent

Superhuman lets the owner speak a message instead of typing it. BB already
has a voice service the owner chose (the same one its prompt box uses);
Makosh Mail's composer has no microphone.

## Goals

- A **Dictate** button in the composer's toolbar. Press: recording starts
  and the button shows the time; press again (or Enter in the bar): the
  recording is turned into text by BB's voice service and inserted where
  the cursor was, as one editor step (one Undo). Escape or Cancel throws
  the recording away.
- The text goes in as plain text; a blank line in the transcript starts a
  new paragraph.
- When recording is not possible (no microphone, permission refused, no
  voice service) the button says why and nothing is recorded.

## Non-goals

- Voice commands ("send", "new paragraph"), live text while speaking,
  dictation outside the composer (the request field of Write with AI, the
  search box).
- A hotkey: the composer's free combinations collide with Apple Mail's
  keys the plugin already follows; the button is reachable by Tab.
- Keeping recordings: a failed transcription can be retried once from
  memory, then it is gone.

## Anti-goals

- Audio or text going anywhere but BB's own voice service, which the owner
  configured in BB (BB decides whether that is local or a cloud service).
- A microphone left on: every end (stop, cancel, an error, closing the
  composer) stops the tracks.
- A recording without a visible sign.

## How

- `src/ui/dictation.ts` — a hook over the browser's `MediaRecorder` and
  `getUserMedia` (no host import): `idle → recording → transcribing →
  idle`, at most 5 minutes (it stops and transcribes by itself), the
  elapsed seconds, cancel, and one retry of a failed transcription. The
  recorder and the microphone are injected, so tests need no browser
  audio.
- A port `transcribe(audio: Blob, signal): Promise<string>` that the app
  fills with BB's `system.transcribeVoice` (the page SDK); absent: no
  button.
- The transcript is cleaned like any text from outside (control and
  hidden characters removed), cut to 20 000 characters, split on blank
  lines into paragraphs and inserted at the selection.

## Testing

The hook with a fake recorder and clock (start, stop, cancel, the
5-minute end, a refused microphone, a failed transcription and its
retry, tracks stopped at every end); the insertion in the editor
(paragraphs, one Undo, the cursor after the text); the toolbar button's
states.

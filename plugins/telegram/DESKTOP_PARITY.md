# Telegram Desktop parity

The target is the Telegram Desktop feature set in Makosh Telegram for BB, plus
the BB-specific requirements in the README. Personal calls are in scope.
The creation and publication of stories are out of scope. Paid messages and Stars
features are frozen at their current implementation and are also out of scope,
including further development and live acceptance of Stars payments,
subscriptions, paid media, reactions, revenue, and price settings.
Telegram Business, including business quick replies, and gifts are out of
scope for further development and acceptance. Their existing implementation
is recorded for reference.
Story viewing stays in scope. The live 4 GB upload check is deferred until a
Premium account is available.

Use the [Telegram Desktop changelog](https://github.com/telegramdesktop/tdesktop/blob/dev/changelog.txt)
and the relevant upstream application code to identify features. Check the
BB UI, RPC contract and TDLib adapter before counting a feature as implemented.
Use tests to verify the behaviors they exercise and a signed-in BB build for
integration acceptance. This inventory records findings so far and is open.

Telegram settings include a separate incoming-call preference for the current
BB session. Personal calls use TDLib signaling and an optional NTgCalls macOS
runtime. Video calls show the remote camera and a local preview. The browser
captures the local camera after permission, sends frames up to 720p at 24 fps,
and closes capture when the camera is turned off or the call ends. The incoming
dialog allows answering with the camera off. The frame endpoint is bound to
the active call; uploads additionally require the camera tab's ticket.

The main BB verified an incoming and an outgoing voice call on the designated
test account. The user confirmed sound in both directions and BB verified mute
and hang-up. On a live outgoing video call the BB view showed local and remote
frames, and the user confirmed that the second account showed the Mac camera.
The HD retest showed a 1280×720 local camera and a 360×640 remote stream in
BB. The user accepted the resulting quality on the second account. Synthetic
coverage exercises both frame directions, 720p and camera-off behavior.

### Deferred call work

- Screen sharing during one-to-one Telegram video calls.

### Deferred Mini App work

- Embed a JavaScript developer console in the Mini App window. Show browser
  console messages and uncaught JavaScript errors, and let the user run
  expressions in the selected Mini App iframe. This depends on the BB browser
  host exposing a DevTools interface scoped to that frame. Use the existing
  WebApp event console panel as the starting point for the interface.

### UI coverage before the messenger redesign

Inventory checked in source on 2026-11-20. The Telegram UI covers chat and
folder navigation, forum topics, search, media, voice and video calls. Group,
channel and chat management is reached through the corresponding details panel.
Account, devices, incoming calls, privacy and cache controls are in Telegram
settings. Agent read access is set per chat and agent sends use the BB
confirmation dialog.

The contract had 727 RPCs. Four were absent as literal method names in the app
entry point. Their user flows use these current methods:

| Method | Current UI flow |
| --- | --- |
| `folders` | `folderLayout` in the chat sidebar |
| `postingAllowed` | `postingPermissions` in the conversation |
| `sendDocument` | `prepareDocumentUpload` and the streaming upload in the composer |
| `addChatMember` | `addChatMembers` in chat details |

This source inventory leaves navigation and permission-dependent availability
to be checked in signed-in BB. During the redesign, use it to check access to
actions in a direct chat, group, channel and forum topic at desktop and compact
widths. Keep screen sharing in the deferred call work above.

#### Redesign acceptance

- Give every implemented user-facing capability a discoverable UI path.
  Record its entry point, required role and the check in each layout. Include
  message actions, attachment and sending options, moderation, settings, and
  agent workflows through BB dialogs. The RPC inventory helps locate the
  feature flows.
- Keep the existing two adjacent vertical navigation regions, a folder rail
  and a chat list. The full BB workspace shows the conversation and a separate
  details pane. Compact browsing keeps the rail and list, and opening a chat
  uses the available width for that conversation. Back restores the list.
- Exercise long chat and folder titles, filenames, message text, localized
  labels, and empty or narrow menu states. Keep action icons and timestamps in
  their own space. Wrap message and menu text where practical, and expose the
  full accessible name when a navigation label is truncated.
- Use one file picker and drag-and-drop for automatic photo, video and
  document detection. Show detected types in the attachment review and give
  the user an explicit option to send the original file.

### Opening a public channel from a folder invitation

The folder invitation shows an open action for channels in its list of
chats to add that have an active public username. Opening a channel keeps
the invitation and its selection in the sidebar. BB resolves the public
username and requires the original channel ID. Channel browsing and
folder import use separate actions. The existing import review token is
independent of the channel username. Isolated BB Chromium verified the
history view, rejection of a reassigned username, selection retention,
and zero membership or folder mutations. Signed-in acceptance remains open.

### Mini App directory and channel recommendations

With an empty search, the Mini Apps tab lists previously used apps and
Telegram's popular app bots. Popular apps can be paged and repeated
entries are shown once. BB checks that each bot exposes a main Mini App.
The Public channels tab loads Telegram's channel recommendations with
an empty search. Typing switches to the existing filtered search in
either tab. Isolated Chromium verified both app pages, deduplication,
the launch review, and opening a recommended channel. The TDLib fixture
recorded zero app launches or channel joins. Signed-in acceptance remains open.

### Public group discovery

The Public groups scope requests public Telegram chats and displays only
supergroups. Public channels keeps its channel filter and recommendations.
Both scopes resolve a pasted public Telegram chat link by username and
check the returned chat type. The TGStat links open the public directory
in a browser tab with no BB search terms attached. The fixture exercises
the group, channel and Mini App filters, exact group links, and the
existing recommendations. Installed Chromium also checked the exact
group link, the catalog destination and zero join requests. Signed-in
acceptance remains open.

### Manual text send animation

Verified manual text sends in chat history, forum topics and channel
discussions animate the exact confirmed row from the composer position.
The animation uses transforms and preserves the history layout and scroll.
It skips reduced motion, hidden panels, older history and late deliveries
after navigation. The UI fixture covers all three composer surfaces.

### Sensitive content preference

Settings → Privacy shows the current Show 18+ Content switch and whether
Telegram allows the account to change it. BB reads the option when the
section opens and checks it again before a write. If Telegram confirms
the updated value, the setting applies across the account's devices.
The settings search finds the control by its name. The adapter fixture
covers stale values, restricted accounts and unconfirmed writes. Chromium
in an installed isolated BB found the switch through settings search,
then confirmed enabling and disabling it through two TDLib writes.
Verification with the signed-in account remains open.

A message with an explicit restriction reason from TDLib displays that
reason in history, context and global search. The restricted attachment,
caption and thumbnail stay out of those views. Direct photo, playback
and download requests recheck the current message. Chromium in an
installed isolated BB verified the reason in the media search and the
message context, with no thumbnail or download for the restricted file.

For messages that TDLib marks as sensitive without an explicit access
restriction, BB reads the account preference and observes option updates.
It holds back the attachment until the preference is enabled. If TDLib
reports that age verification is required, BB displays that requirement
and locks the switch. Fixture tests exercise opening a message after
enabling the preference, the age-verification state and an explicit
restriction that remains in effect. Chromium in an installed isolated BB
opened the same result with the setting off, on and off again. The
photo decoded only with the setting on, and the fixture recorded two
explicit option writes. When TDLib supplies a valid verification bot
username, BB can open the bot's Main Mini App after review. The launch is
bound to the current TDLib age requirement and rejects stale results.
Closing the Mini App refreshes the preference from TDLib. An external
Telegram link and an explicit status refresh are available for flows
requiring device access or a same-origin frame. Fixtures cover the
launch review, stale bot rejection and refresh without a setting write.
Only the age verification window accepts the Mini App's completion event.
The event requests a fresh TDLib status check. BB closes the window once
TDLib confirms the account may change the setting. BB can show an
unconfirmed result and let the user check again. The event carries no
authority to change the preference, and BB does not store the reported age.
[Telegram Desktop Mini App event handler](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/ui/chat/attach/attach_bot_webview.cpp).
Chromium in an installed isolated BB launched one reviewed verification app
and refreshed on close. Only a simulated Telegram update unlocked the
switch, with zero preference writes. A separate run delivered the completion
event from the sandboxed frame, kept the settings locked while unconfirmed,
and closed the window after TDLib reported the changed status.
End-to-end age verification on a signed-in account remains open.

The same account preference and age verification state apply to agent chat
discovery, search and history. Hidden messages cannot produce a chat or
message match, and history withholds their text and local transcripts.
Direct translation and location previews also check the setting. Fixtures
cover both preference values, a verification requirement, and the absence
of a translation, speech download or map request for hidden content.

### Recent public search tags

Public posts shows the account's recent hashtags and cashtags on an empty
query. A tag prefix narrows the suggestions. Selecting a suggestion fills
the query and runs the matching tag search. Individual tags can be removed
from TDLib's history. Installed Chromium in an isolated BB verified that
opening suggestions and removing a cashtag produced zero post searches.
Reopening the tab preserved the removal, and selecting a hashtag sent one
TDLib tag search with the exact tag. Hashtag and cashtag histories can also
be cleared separately after confirmation. Isolated Chromium checked that
cancelling preserves the tags and clearing either type issues only its
corresponding TDLib request. Reopening the tab confirmed the hashtag
history remained empty while the cashtag was still present.
Signed-in acceptance remains open.

### Photo editing before sending

An attached photo can be edited before sending in a chat or forum topic.
The editor previews quarter-turn rotation, a centered square crop, a crop
drawn on the photo or adjusted with edge controls, and text
with font, color, size, alignment, and vertical position controls. Applying
edits replaces the local photo and preserves the Telegram caption and delivery
options. Cancelling keeps the original draft photo.
An isolated BB verified visible text in the preview, a rotated JPEG in the
draft, cancellation, caption retention, and silent delivery in a synthetic chat and forum topic.
Neither scenario sent a message.
An isolated BB selected an off-center crop with the pointer, adjusted an
edge with the keyboard, then rotated and applied the crop. The exported
draft retained the selected area, verified with fixture pixels and dimensions.
The photo editor draws with a brush, translucent marker, arrow, or eraser.
Undo and redo operate on individual strokes. Rotation and crop preserve the
stroke positions on the original image.
An isolated BB verified the four tools, undo, redo, and rotation with
pixels from a synthetic photo. Applying the JPEG kept the caption and
silent delivery in the local draft.
The editor zooms toward the pointer with the wheel and pans with the
middle mouse button. The zoom controls also work from the keyboard, and
arrow keys pan the focused, zoomed preview. Zoom changes the view only.
Two isolated Chromium runs verified pointer-centered zoom, middle-button
panning, drawing at zoom, and pixel-accurate free cropping at zoom.
The chat and forum photo viewer can open a single photo or the selected
album item directly in drawing mode. Applying the drawing attaches a local
JPEG to a reply on that exact message and keeps the existing draft text.
The request rechecks the source and conversation's sharing settings
before editing and before sending. Protected and expiring photos are
excluded. Cancelling returns to the viewer.
The isolated BB browser runs verified the spoiler gate, cancellation,
caption retention, and one synthetic send to the selected album entry
in a group and in a forum topic. The TDLib adapter fixture also covers
a protection change before dispatch and rejects closed topics.
The same action is available from Shared media. Applying changes leaves
the gallery and opens the composer for the source chat or its exact forum
topic, keeping the text already drafted there. A draft with a reply or
attachment stays intact. Two isolated BB browser runs confirmed delivery
on explicit send from the gallery in a group and an open forum topic.
A third run verified that opening Shared media and attempting a draw
preserves the topic's existing attachment and caption.
Individual still photos in a draft album use the same editor. Each edit
follows its photo through reordering and draft exchange. The edited JPEG
is sent in the selected position. Reset edits restores the source photo.
An isolated BB verified the edit and reset after moving an album draft
between synthetic chats, with zero uploads or sends.
Formatted drafts and local replacement photos in the formatted message
editor use the same controls. Photo edits follow the block when it moves
and keep its caption and spoiler. Applying an edit keeps the JPEG local
until the formatted message is sent or saved.
An isolated BB saved a synthetic formatted message with a rotated replacement
photo and retained its caption, credit, spoiler, and neighboring document.

### Draft exchange

In an eligible chat or forum topic, the composer retains text beyond
Telegram's 4096-unit message limit and offers an explicit send as a UTF-8
text document. The upload preserves whitespace and the selected reply.
Rejected uploads leave the original draft available. Ordinary text send,
text scheduling and Telegram draft synchronization enforce their original
message limits. The installed Chromium fixture verified the exact uploaded
bytes and reply ID, and UI tests exercised chat and topic retries.

In the standard text composer, Ctrl+S exchanges one draft across chats and
forum topics in the same open BB account. UI tests cover a round trip between
a chat and a topic, including bold text, the link-preview choice, Cyrillic
keyboard input, held-key repeats, and separate account stashes. Chromium in a
temporary BB installation exchanged drafts three times across two synthetic
chats, kept composer focus, and recorded zero sends and zero Telegram draft
writes. BB also restores the reply and selected quote in their original chat
or topic. A second installed-browser run verified that another chat keeps
its own draft and the original chat restores its reply, with zero sends and
zero Telegram draft writes. The UI test verifies the restored message ID and
quote sent through a fixture. Single photo, video, and document drafts carry
their caption and delivery options to eligible conversations. UI fixtures
check refusing a document in a restricted group, transferring it to a topic,
and restoring a topic photo for explicit sending in a chat. A temporary BB
installation moved a document between two synthetic chats with its caption
and silent option, while preserving input focus. It made zero document
uploads, sends, and cloud draft writes. Regular albums use the same slot from
their album composer. A mixed photo and video fixture restored ordered files,
styled caption, spoiler and silent delivery in a forum topic after a chat
without video permission rejected it. Installed Chromium restored an ordered
document album and its caption and silent setting across synthetic chats and
focused the caption, with zero uploads, sends and cloud draft writes.
The album composer offers individual captions on photos, videos, motion
photos and documents in regular albums. Each caption can contain styles,
links and custom emoji. Captions and formatting follow their file through
reorder and draft exchange. Switching back to the shared caption restores
the text in that field. The adapter validates caption count and entity
ranges and rejects a payload that supplies both caption modes.
Installed Chromium reordered two photos, exchanged the draft across
synthetic chats and confirmed one album dispatch with the captions in order.
A separate run confirmed a link on the first outgoing photo and bold text
on the second after the same reorder and draft exchange.
Original video quality is available for a single video and as an option
for the video files in a regular album. For H.264 or HEVC with AAC audio
or no audio, BB submits MP4 files as-is and remuxes MOV to MP4 with stream
copy. An incompatible file leaves the draft available. A single video can
then be attached as the original document. Adapter fixtures verified
matching audio and video stream hashes and byte identity for HEVC MP4.
Chromium in an isolated BB submitted the same HEVC fixture as a single
video and in a photo/video album, using the original file in both requests.
Single-video drafts in chats and forum topics have a local preview, trim
range, output quality limit and estimated size, plus a selectable cover
frame. BB encodes the trimmed SDR video as streamable H.264 MP4 and supplies
a separate JPEG cover to TDLib. Regular album videos and formatted message
video blocks use the same editor. Album edits stay with the file during
reordering and draft exchange. With the whole range selected, the editor
defaults to Original. It checks the probed duration before using original
quality, keeps compatible MP4 bytes and remuxes compatible MOV streams.
A cover-only edit extracts a separate SDR JPEG. For supported BT.2020 PQ
and HLG sources, FFmpeg applies perceptual tone mapping to the cover
while retaining the HDR video. Fixtures checked both transfer functions,
distinct SDR luminance levels, unchanged HEVC bytes in Original mode
and refusal of an edit with unverified color primaries. Trimming or scaling
a supported HDR clip encodes 10-bit HEVC and checks that the original
transfer, primaries, matrix and range survived. The PQ fixture also verified
static mastering-display and content-light metadata. Isolated Chromium
sent a synthetic PQ clip and its SDR cover, first in Original quality and
then trimmed to one second. Probing the trimmed upload verified HEVC,
10-bit depth, BT.2020, PQ and the requested duration. With a compatible
FFmpeg build, BB trims single-layer Dolby Vision 8.1 and 8.4 within the
selected resolution limit and generates a separate SDR cover. The output
must retain the original Dolby Vision profile and layer flags. FFprobe
verified per-frame RPU data in both synthetic fixture outputs and unchanged
original MP4 bytes for cover-only edits. The fixtures use generated gray
frames and synthetic dovi_tool 2.3.1 metadata. The isolated BB upload RPC
sent one synthetic 8.1 clip with the RPU intact. The Chromium editor did
not load the preview metadata in the smoke test. Dolby Vision 8.1 and 8.4
sources with or without active-area offsets can be resized with dovi_tool.
BB scales each scene's four offsets to the output dimensions, restores the
encoded packet clock, and verifies the Dolby Vision profile and active area
before upload. Fixtures resize both profiles from 800 to 480 pixels and
check two different scenes with asymmetric offsets and trimmed AAC audio.
An isolated BB upload RPC delivered one synthetic 8.4 video with six frames,
the mapped scene boundary, an AAC track starting at zero, and an SDR cover.

Resizing sources with nonzero offsets and a display transform and editing
other Dolby Vision profiles remain open.

BB preserves dynamic HDR10+ metadata when trimming or scaling a supported
HEVC source with single-window metadata on every frame. The adapter chooses
source frames by presentation time and reattaches metadata with
`hdr10plus_tool`. For variable frame rates it restores each HEVC packet's
presentation time and duration before copying the trimmed audio into the
MP4. It verifies the frame clock and metadata sequence before handing the
file to TDLib. Sparse or multi-window metadata still requires Original.
The upload fixtures cover constant and variable frame rates, exact frame
timestamps and durations, per-frame luminance values, AAC timing, and refusal
when the tool is unavailable. An isolated BB upload RPC with synthetic TDLib
sent one trimmed 480p clip and a separate SDR cover. Probing the submitted
clip verified 21 matching HDR10+ frames, repeating 70, 85 and 95 ms frame
intervals, and AAC aligned to the same 1.75-second timeline.
Selecting a trimmed range
switches to a bitrate and size limit. Adapter fixtures for both known TDLib
video payload shapes verified byte-for-byte source preservation, the
selected cover frame and refusal of a shortened original range.
Isolated Chromium verified the quality switch, zero uploads before Send,
and the original MP4 with a separate cover. Signed-in acceptance remains
open. The album's original-quality option also applies to unedited videos.
For files with multiple tracks, preparation follows the default video track
and ignores attached artwork when selecting video. The adapter fixture
verified both trimming and extracting a cover from a second, default track
with different dimensions. Isolated Chromium sent the original MP4 and
the native fixture verified the cover came from the default track.
Formatted drafts use the same account slot and restore through the formatted
editor. A fixture moved a styled heading and a local document into a topic,
retained silent delivery, and rejected restoration in a group without
document permission. Installed Chromium with synthetic Premium and limits
restored the two blocks and file between chats, focused the first block,
and recorded zero uploads, sends and cloud draft writes. Ctrl+S in the
ordinary composer can open either specialized editor and restore a stashed
draft while leaving the ordinary text in place. Installed Chromium verified
both editors, plus an existing formatted draft that the shortcut preserved
until an explicit two-way exchange. This produced zero uploads, sends, and
cloud draft writes. Albums and formatted messages now carry the selected
quote and reply across chats and topics, with source verification before
restoring and before sending. UI tests cover a protected source, then
successful restoration and explicit dispatch, while keeping the ordinary
draft and its own reply. Two installed Chromium runs restored and sent a
synthetic document album and a synthetic formatted message, respectively.
Both preserved the ordinary draft and silent delivery and refused
restoration while the source was protected. Albums and formatted messages
can also exchange directly. BB checks destination permissions and keeps
existing drafts when the other editor is occupied. Installed Chromium
swapped between both editors, restored three local files, kept silent
delivery and ordinary text, and moved keyboard focus to the restored
editor with zero uploads or sends.
The manual text send path can now accept an external reply source in a chat
or forum topic. It checks the original message, chat protection, and TDLib
reply eligibility and rechecks before dispatch. A transport fixture checked
the destination topic, exact quote and source identity, and an isolated BB
RPC run allowed one synthetic reply and blocked the protected source.
Ctrl+S now restores an eligible text reply in a different chat or topic
after checking its source. A UI fixture moved a selected quote into a
topic, preserved an edit made while the source check was pending, and sent
only after the user invoked the topic's send action. Installed Chromium
also blocked a protected source and restored and explicitly sent one
unquoted synthetic reply after rechecking the source. Browser automation
did not verify selection of a quoted passage. Delivered cross-chat replies
open the verified source and support returning to the reply. The installed
browser run opened and returned without sending and preserved a local
draft. A UI fixture also opened a source with its forum topic ID and rejected
a mismatched message reference. Between topics of the same forum, the
installed browser resolved the source, opened the original topic's context,
returned to the reply and reopened its topic with the local draft intact.
The media composer carries the source and any selected quote when a reply
is restored in another conversation. Tests cover a restored reply into a
forum topic and an album with a matching delivered source. They also check
that revoking eligibility blocks dispatch and that a mismatched source
leaves the delivery unconfirmed. An isolated installed BB run sent one
synthetic album with the quote and blocked the protected source. Installed
Chromium also restored a reply into another chat, sent a synthetic
location from the media composer, and kept the text draft. The regular
attachment controls also preserve the source and quote for a photo, video,
or document. A quoted document draft can move across conversations when
the destination supports documents and the source is still eligible.
Installed Chromium moved a document draft into another chat, refused a
newly protected source before uploading, and sent one synthetic file after
eligibility returned. The upload fixture also verified the source in the
final delivery to a forum topic. Regular inline results and polls also
carry the active reply. Installed Chromium sent one synthetic inline
result and one synthetic poll from a group composer, and blocked the inline
result when the original source became protected after the search. The
transport fixture covers the selected quote and a poll sent into a forum
topic.

The Reply button in a group or topic also opens the reply destination
picker on Ctrl-click or Cmd-click. A local reply with a selected quote can
open the same picker. BB reviews the source, quote, destination permissions
and selected topic in TDLib before opening the destination draft. It
preserves the source draft and leaves an existing destination reply in
place. Tests cover preparing a quoted reply in another group's topic,
refusing a changed source or destination, and retaining the original draft.
Installed Chromium opened a second topic in the same forum and retained
the source text and reply on return. The destination composer took focus
and the fixture recorded zero sends. A later installed Chromium run selected
a word by double-click in the quote field, applied it, and transferred the
exact excerpt to another topic. A separate run set a range in the quote
field and verified Ctrl+Enter, focus restoration and the resulting external
reply. The UI test also verifies Escape closes the picker and preserves
the reply. Captions on photos, videos, GIFs, audio, documents and voice notes
can serve as quote sources. The same excerpt and entity checks apply to
local and external replies. Tests also reject mismatched offsets and
expiring source messages. Installed Chromium selected a word from an
italicized document caption, moved the reply to another topic and sent one
synthetic message. The TDLib fixture verified the topic, source message,
quote offset and italic entity. BB can quote a selection from the message
or caption when the user clicks its reply button, including a modified
click for a different destination. A test distinguishes repeated words
after a UTF-16 surrogate pair and binds a shared album caption to the
correct item. Installed Chromium selected a word from a visible file
caption, used the ordinary reply button and then Cmd-clicked it with a
new selection. The other topic received the exact quote and its italic
entity in one synthetic send. Opening a delivered quote centers and
highlights the excerpt in the nearby-message view when the UTF-16 offset
still matches the original. If the original changed, BB opens the message
without highlighting another occurrence. Spoiler and rich quote
anchors are omitted. Installed Chromium opened a quote from another
topic, scrolled to the second occurrence in a long message, and
returned to the reply with its draft preserved.

### Read state in open history

TDLib edit events refresh the exact loaded message in a chat or forum
topic, including while a newer unread page is still available. The event
carries the message identity. The updated row uses the same presentation
rules as history and does not load a page or send a read receipt. Fixtures
cover the read window, edits coalesced during an open request, and rejected
message and topic mismatches.
Chromium in an isolated BB preserved playback at seven seconds through a
caption edit inside the unread window. Replacing the attachment invalidated
the old stream and loaded the replacement at the start. Neither edit issued
an extra history page request.
The nearby-message viewer patches edited rows on the initial and expanded
pages, preserving the focused message. Search repeats the affected result
page with the original query, filter, cursor, author and date range. It
retains the other loaded pages and deduplicates overlapping results.
Channel inbox viewers reuse their topic-scoped message source.
In an isolated BB, Chromium kept an open context video at the same
timestamp through a caption edit. The affected match disappeared on
return to search, with one search-page refresh and no extra history page
request.

Global message and media search rechecks loaded pages affected by an edit
with the original query, filters and chat scope. Rows are identified by
chat and message together. The media thumbnail request is bound to the
file in the current search result. An edit in public posts surfaces a
manual refresh and makes no background public search request.
Chromium in an isolated BB loaded two pages with the same message ID in
different chats. An edit removed the obsolete hit, retained the other
row, and made exactly one additional global search request with no
history pagination.

Deletion updates remove matching rows from global and conversation search
without re-running the query. A pending page cannot restore a removed row.
An open nearby-history view keeps a locally retained copy with a label.
Chromium in an isolated BB verified that a TDLib deletion removed the hit
while keeping another chat’s hit with the same message ID, with no extra
search, history request or send.




At the end of a loaded channel or topic, BB offers an explicit action to open
the next unread destination. The channel action can look through the current
list, other folders, the main list and Archive. The topic action can check
later pages of the current forum. The destination uses the ordinary read
position, and moving between conversations cancels a pending search. BB
leaves scroll gestures to history navigation. UI fixtures cover a loaded
channel, an archive result, an obsolete result and paginated forum topics.
Chromium in an installed isolated BB opened an archived channel and a forum
topic. Scrolling at the end of the channel produced no archive lookup.
[Telegram Desktop navigation source](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/history/history_view_pull_to_next_channel.cpp).

Jumping to unread messages in a chat or forum topic focuses the first
unread message and exposes the unread divider as its accessible
description. Keyboard history paging remains available from that row.
If the read boundary falls inside an album, the divider appears between
the read and unread items.
In an isolated BB, Chromium activated the jump with Space and reported the
unread list item as focused with the description “Unread messages”.
After reloading the main BB plugin, its saved Telegram session reached ready
again. In an approved test direct chat, the existing setup had zero incoming
unread messages. The main BB set a manual unread mark, reopened that chat,
and cleared the mark automatically while messages were visible. Opening with
new incoming unread messages was verified using synthetic TDLib data.
In a later signed-in check, Chromium previewed one incoming test marker
without clearing its unread badge. Opening the conversation showed the
read boundary and the new marker. TDLib then returned zero unread, but
the list badge did not clear during that browser run. The candidate now
refreshes the exact chat's read state in the search result after TDLib
acknowledges a visible receipt. Isolated Chromium exercised a chat visible
only in search and confirmed that one receipt cleared the badge.
The same verified read state updates an existing row on any loaded sidebar
page. Isolated Chromium scrolled through forty chats, opened the chat on the
second page at its read boundary and confirmed that one visible receipt
cleared its badge. The panel regression also retained the corrected badge
after a refresh that returned only the first page.

BB sends read receipts through the newest unread row actually visible in a
foreground chat or topic. The adapter verifies the chat, message, and topic
before marking that ID. A chat preview keeps its unread badge, and a manual
unread mark stays until the next visit. When TDLib exposes a last-read
boundary, the initial history request starts around it and scrolling down
loads the next page. The installed browser run opened at the boundary,
acknowledged visible rows before the end of the first page, fetched two
newer pages and cleared the badge when the last message became visible.
While Telegram acknowledges one read, BB coalesces additional visible rows
into a receipt for the newest of them. A hidden tab defers delivery. Chromium
with delayed synthetic TDLib acknowledgments jumped to the latest history
while one receipt was pending, sent the next receipt after the first response,
and cleared the search result badge. The test recorded no message sends.
If the first receipt and its automatic retry both fail, returning to the
visible tab or regaining the browser connection lets the current visible
row retry. In isolated BB, Chromium verified two failed attempts, no further
attempt before the recovery event, one successful retry and a cleared badge.
Chat and forum topic fixtures verify that recovery does not mark an offscreen
row and does not repeat an acknowledged receipt.
Chromium also verified that contact with the viewport edge leaves a message
unread and that it is marked read as soon as its first pixels enter the viewport.
Before dispatch, BB rechecks candidate rows against the current history
viewport when the observer supplies viewport bounds. A UI regression
moved a tall row offscreen between the observer delivery and receipt
frame and verified no read until it returned. Installed Chromium opened
the read boundary, marked a row taller than the whole history pane once,
and cleared its search-result badge. The signed-in profile was ready but
had zero unread messages in the approved test conversation and was still
running an earlier build at the time of this check.
History resize tracking follows the message ID when a visible row is
replaced during album regrouping. A scroll event from an earlier adjustment
keeps the saved position when a second preview resizes before the next paint.
Installed Chromium opened a synthetic unread boundary, acknowledged one
visible message and fetched one earlier page on scroll with zero duplicate
IDs. It then replaced the anchor row and grew a preview above it by 120 CSS
pixels. The anchor stayed in the same place with zero measured drift.
The previous bundle lost the anchor on the same row replacement.
Native modal dialogs pause automatic receipts for the obscured conversation.
Closing the dialog or removing it from the page rechecks the current
viewport without requiring a scroll. In an isolated installed BB, a control
build sent one receipt while the modal covered an unread row. The fixed
build sent zero receipts while the modal was open and one after it closed.
The browser also verified opening at the boundary when chat metadata omitted
the unread count and latest message. If the last-read row was deleted, the
initial chat or topic page prefers its first unread incoming row. Isolated
Chromium opened the incoming row after an outgoing message taller than
the pane and cleared the badge with one receipt and no manual scrolling.
If TDLib returns rows on both sides of the read position but omits the
last-read message itself, BB requests the boundary separately. A Chromium
run in an isolated BB verified the recovered anchor, visible read receipts,
two pages loaded by scrolling, and the unread badge clearing at the end.
The latest-message action can skip directly from an unread history slice to
the newest page in a chat or forum topic. Tests cover retry in place and an
intermediate-page response arriving after the jump. Isolated BB in Chromium
opened a search-only chat at its read boundary, requested the latest page
without requesting the intervening pages, and cleared the search result badge
after one receipt for the last visible message. It recorded zero sends.
The fresh history kept the boundary and enabled read receipts. A live
revision received during pagination is applied after the newer pages are
connected. Chat and forum fixtures cover missing latest-message metadata
and short pages. Topic routing and hidden-window behavior were verified
with fixtures. For a zero read marker, BB requests the earliest page using
TDLib's lower history cursor. Installed Chromium skipped the first
outgoing row as the opening anchor, started on the first incoming row and
loaded two newer pages on scroll. The transport fixtures cover a chat
and a topic and ensure that the initial request stays bounded.

BB restores the last conversation and selected forum topic after the panel
reloads. Browser storage contains the chat, optional topic and list IDs
under an opaque key scoped to the connected Telegram account. BB resolves
them again before restoring. An unavailable topic falls back to its chat.
A removed folder falls back to All Chats or Archive depending on the current
chat. An explicit selection made during restoration takes effect immediately.
Chromium in an isolated BB reopened the same chat and topic after reloading
both the installed plugin and the browser page. The fixture recorded no sends.
Closing a conversation or switching lists discards that saved destination.
Keyboard navigation to Archive cancels an in-flight restore. A late read
acknowledgement reconciles only the chat it belongs to, even when a second
chat has been opened and its acknowledgement arrives first. An explicit
unread mark pauses automatic receipts until the next visit to that chat.
Installed Chromium in an isolated BB delayed the real session RPC
response and kept Archive selected after Ctrl+9. Escape closed the
conversation and it stayed closed on reload. Chromium also opened Chat
details and found the AI access control via Alt+Shift+I at the full panel
width and with the Telegram panel constrained to 590 px.
Keyboard folder switches now place focus after the conversation closes, so
the target is reachable in the narrow layout. Returning from a conversation
focuses its chat row when it is still in the list. Chromium in an installed
isolated BB verified six Chat details visits across a direct chat, group and
channel at 900 and 590 px. It checked access to the AI setting, availability
of Recent actions for groups and channels, Escape focus restoration,
Archive and Saved Messages shortcuts, and a nested folder switch.
The channel inbox inside Chat details handles the find shortcuts within
the selected correspondence. Escape restores focus at the previous inbox
level and leaves Chat details open. Escape in the conversation leaves a
pending send in view. Chromium at 590 px dispatched one scoped search and restored
focus at all three levels. The fixture excluded the other conversation's
result. The UI regression also verifies that Escape preserves an unsent
draft after a refused send.
On the main BB, Chromium verified keyboard switching between existing
folders at 590 px without opening a chat. Ten custom folders were present
and none had dotted names, so hierarchy was exercised on fixture data.

### Managing pins from the pinned-message list

The pinned-message list offers a review and explicit confirmation for
removing all pins in a chat or in the current forum topic. The adapter
checks current rights and the reviewed pin before calling the matching
TDLib method. Installed Chromium confirmed separate synthetic group and
topic runs with one mutation each after confirmation, none after
cancellation, and a refreshed list. The transport fixture covers channel
rights, a changed pin and a renamed or mismatched topic.
An individual result can also be unpinned without leaving the list. An
installed browser removed one synthetic group pin, kept the other, moved
keyboard focus to its pin control and refreshed the pinned banner. A UI
fixture covers retaining the next-page cursor and discarding a stale
result that Telegram has already unpinned.

### Folders in forwarding and link sharing

The forwarding review can open any loaded Telegram folder by its nested
path. Browsing and search are scoped to that folder and leave the main
chat list in place. Additional recipient pages load on request and keep
the current selection. Changing the folder clears the reviewed recipient.
The shared-link chooser can switch folders before opening a conversation,
where the link still requires explicit insertion into the draft.
UI tests cover folder-scoped search, pagination, recipient reset,
and draft-only link sharing. Chromium in an isolated BB selected two
different nested folders, verified that a scoped search excluded chats
outside its folder, forwarded once after explicit review and inserted a
link into a draft without sending it. Signed-in verification is pending.

### Forwarding with a comment

The forwarding review can send a comment separately before forwarding a
message, album, or selection. Both requests use the reviewed destination,
topic and delivery settings. A refused or unconfirmed comment stops the
sequence. After confirmation, BB rechecks the source and destination and
reports a separate outcome if forwarding fails. Transport tests exercise
scheduled topic delivery, partial outcomes, and a source that changes
after the comment is sent. Installed Chromium verified that a synthetic
forward created no writes before confirmation and that the comment was
sent before the original message.

### Clearing history by date

Chat details can clear one local calendar day or an inclusive range, with
a separate confirmation of the conversation, dates and scope. The TDLib
adapter rechecks the available scope and only removes private-history
copies in the matching period after Telegram confirms the deletion. The
adapter fixture covers both endpoints, a refused request and isolation
from another chat. Installed Chromium verified a synthetic one-day
deletion for both participants, including cancellation before confirmation,
one TDLib request with exact local-day boundaries and removal of the
message from the visible timeline. Signed-in verification is pending.

### Markdown attachment viewer

Conversation attachments named `.md` or `.markdown` can open in a
local preview with headings, code, tables and task lists. The adapter
resolves the attachment in its message, checks Telegram protection and
limits the preview to 128 KiB of UTF-8. Downloads remain available through
the ordinary attachment action. The renderer displays image descriptions,
skips raw HTML and allows explicit navigation to validated HTTP(S) links.
Installed Chromium opened a synthetic Markdown attachment, rendered the
table and task list, and observed one bounded TDLib download only after
opening the preview. The preview also worked when BB started at 420 px.
Resizing the already-open BB from 1422 px to 420 px closed the conversation
and its preview. Live Telegram acceptance is pending.

### Channel poll voting restrictions

A channel poll can require 24 hours of membership, allow selected countries,
or apply both rules. BB loads the TDLib country list and current selection
limit and validates the destination and restrictions again at submission.
Existing polls display their restrictions and Telegram’s reason for
blocking the current user’s vote. The installed browser fixture verified
the restriction message, the selection limit and one synthetic publish
with the selected country and membership rule. A transport fixture
rejects an over-limit selection, a hidden country, a group destination
and voting while the membership restriction applies. The main signed-in BB
still reported the new RPC as unknown. Signed-in verification remains open.

### Poll vote history

BB opens a poll vote chart on request after checking the message and TDLib
statistics permissions. The chart displays Telegram’s time series, and a
keyboard-accessible slider shows exact counts by time. When Telegram supplies
a detail token, BB verifies the selected time against the base graph before
requesting the detailed graph. Returning restores the previous selection.
The installed browser fixture verified the asynchronous stacked bar chart,
keyboard time selection, detail request and return. Adapter coverage includes
permission denial, invalid times and malformed graph data. Live verification
on an eligible poll remains open.

### Suggested poll answers

Eligible regular group polls can accept participant-suggested answers.
BB checks that an open poll still accepts suggestions before adding one.
Removal checks the identity and text of the suggested answer and the
current TDLib permission, shows a confirmation, then checks again before
deleting. The installed browser fixture added an answer and removed a
different answer after confirmation, with cancellation leaving the poll
intact. Transport tests cover permission denial and stale answer text.
Live verification remains pending.

### Polls with one choice and per-option vote counts

Recent TDLib versions accept polls with one choice. The editor can remove
extra options down to one, and the older TDLib path rejects single-choice
drafts before attempting to send them. BB shows the reported count and
percentage for each option when TDLib exposes the results. The installed
browser fixture verified both visible and hidden results and a publish
request with exactly one option. Live publish verification remains open.
BB displays poll locations and venues on questions and answers, and in a
quiz explanation when Telegram exposes that explanation. The composer
publishes HTTP(S) links on specific answers, and the poll displays links
with their Telegram titles. The installed fixture displayed a question
venue, an answer link and an available explanation location. It also
verified that an unavailable explanation stayed hidden and that the
composer sent one synthetic choice with its link. The location editor
now attaches coordinates or a named venue to a question, choice or quiz
explanation. A choice accepts one attachment. The installed browser
fixture sent one synthetic quiz with a question venue, a choice location
and an explanation location in the corresponding TDLib fields. The
installed browser also rendered visible question and answer photos,
opened a higher-resolution version, and fetched the explanation image
only after expansion. The adapter checks the message, attachment slot,
current file and result visibility before downloading a poll photo.
The poll editor previews selected photos and attaches JPEGs to the
question, an answer or a quiz explanation. The browser fixture selected
three JPEGs, confirmed one synthetic poll send with all three local
files present, and checked their cleanup after TDLib confirmed delivery.
BB also opens supported video, audio and GIF poll attachments through
the range-enabled player when TDLib knows the exact size, and downloads
supported files through the ordinary ticket route. Both paths verify
the current attachment slot and Telegram protection. The installed
fixture decoded and sought a video, and the downloaded document matched
its original bytes. Adapter tests cover audio and GIF references and
hidden explanation media. The conversation and topic poll composer
streams selected documents, audio, GIFs and videos through the BB upload
ticket. TDLib allows video and GIF on answer options. Installed Chromium
selected all four types and published one synthetic quiz. The fixture
checked the native attachment slots, local files during dispatch and
cleanup after confirmation. The adapter fixture also rejects truncated
uploads and unsupported slots before dispatch. The same upload path saves
poll attachments into a Telegram Business quick reply. Tests verify the
question document, explanation audio and answer GIF, plus rejection of a
renamed shortcut, with no conversation send. Installed Chromium saved a
synthetic quick reply poll with four files, reopened the saved poll and
recorded no conversation sends. The poll editor also selects
stickers from installed packs. Conversation polls load supported sticker
artwork when visible. The quick reply preview shows attachments in their
question, answer and explanation slots. Media requests verify the current
shortcut, message and slot against TDLib. Quick reply previews keep poll
answers read-only and defer loading explanation media until expansion.
Installed Chromium decoded and sought a synthetic poll video in a saved
shortcut. The explanation's document appeared after expansion, and a
download through the local BB ticket matched the fixture bytes.
Live Photos in conversations, poll slots and quick replies expose the still
image and load the paired MP4 or WebM clip on demand when its size is known.
The range stream checks the current message or shortcut, poll slot and
video file ID. The installed synthetic chat fixture decoded the still,
opened the motion player after revealing the spoiler, and sought in both
the chat photo and the poll clip. An installed run also decoded motion
video from a saved quick reply poll. The enlarged photo viewer can also play
the selected photo's motion clip. Installed Chromium opened the album from
a still, moved to a covered Live Photo, verified that revealing it loaded
only the still, and then loaded and sought its motion clip on request. It
verified that navigating away removes the player and also sought a clip
from a poll in the viewer. Signed-in verification remains open.
The chat and topic media composer can send a still image and separate MP4
or MOV clip as one native Live Photo. The upload stages both files, verifies
the video format and requires a TDLib version with nested photo inputs.
Installed Chromium sent one synthetic photo message with a caption,
spoiler and MOV remuxed to MP4. The fixture checked both staged files and
their cleanup. **Import Motion Photo** extracts the paired files
from Android XMP container metadata or a legacy MicroVideo offset.
Tests cover padding, gain maps, offsets and malformed inputs. Installed
Chromium rejected a static JPEG and sent one synthetic Live Photo from
a single JPEG containing a MOV clip. AVIF Motion Photos load XMP from the
image container and cross-check its directory with the terminal motion
box. Tests cover file-relative and item-relative XMP offsets, disabled
motion and inconsistent or truncated boxes. Installed Chromium rejected a
static AVIF, decoded a synthetic AVIF still and saved the embedded clip
and still as one native photo message through the fixture. HEIC uses the
same item metadata and terminal box checks. BB stages the HEIC bytes with
the clip and uses macOS image decoding and JPEG encoding without source
metadata before constructing the TDLib request. Installed Chromium rejected
a static HEIC and dispatched one synthetic Live Photo with a decoded HEIC
still and its embedded MOV. The fixture verified staged JPEG and MP4 bytes
and cleanup. Poll composers in conversations and Business quick replies can
attach Live Photos to the question, options and quiz explanation using an
imported Motion Photo or a selected pair. Adapter fixtures cover all three
slots, conflicting attachments and staging cleanup. Installed Chromium
imported three synthetic Motion Photos and published one quiz with all
three pairs. Chat and topic albums also accept an imported Motion Photo
or a photo with a separately selected clip. The still and clip keep one
position through reordering and draft exchange. The upload fixture checked
the nested pair alongside a still image and video in the same album, and
verified the returned motion file. Installed Chromium moved an imported
Live Photo from third to first and sent one synthetic album, preserving
the three positions in TDLib. Business quick reply albums also accept
an imported Motion Photo or a still with a separate clip. The transport
checks the returned album and motion IDs. The adapter fixture verified
that both staged files remain available until the pending motion upload
completes. Installed Chromium saved and reopened one synthetic quick reply
album with the Live Photo first, checked all three positions and saw the
motion playback control after scrolling it into view. Motion styles and
signed-in acceptance remain open.

## Gaps confirmed in the plugin

Profile and chat photo galleries play the selected animated avatar on
request using TDLib's MP4 variant. BB binds the stream to the current
profile or chat, gallery page, avatar and file. Each new range rechecks
the binding. The browser shows the still image while playback is closed
and releases the player when navigating away. Installed Chromium
decoded both a group and a channel fixture, with zero stream requests
before activation. Adapter fixtures cover own and peer profiles,
the smaller fallback variant, protected history and a changed file.
The gallery also loads a basic group, supergroup or channel's current
avatar from TDLib's full chat information. It displays the avatar if no
matching history message is visible, deduplicates it when the same photo
is already on the first page, and preserves the history cursor. The
current avatar stream is bound to the photo and its chat avatar version.
Installed Chromium played two current avatar fixtures while TDLib
refused chat-photo history. Adapter fixtures cover all three chat kinds,
a replaced avatar, protected content and the duplicate case.
Your profile and editable group or channel details also accept a local
video avatar. The editor previews the clip and uses the reviewed frame for
the static cover. BB validates the size, square dimensions, H.264 track
and duration before sending. It checks the current avatar version,
account session and editing rights again before the Telegram request.
Tests exercise personal, group and channel uploads, a rights change
during review, a stale avatar and invalid dimensions or cover time.
Chromium in an installed isolated BB decoded the preview, sought to
0.5 seconds and verified one write to the selected group after Save.
It recorded zero avatar writes before confirmation.
The editor now accepts MP4 and MOV sources up to 4 MB and lets the user
select up to ten seconds. FFmpeg crops the selected clip to the center
square and removes audio when preparation is needed. Chromium in isolated
BB previewed a landscape MOV, chose seconds 1 through 2 and sought to
1.5 seconds. The fixture received one write with a cover offset of
0.5 seconds. The adapter test probed the result as one 512 × 512 H.264
video track, one second long, with no audio.
Signed-in verification remains open.

The Notifications panel keeps up to 30 incoming notices for the active BB
Telegram connection. TDLib can deliver a batch; all eligible entries appear
once and follow the preview flag and spoiler handling. The transient
banner expires independently of the panel. Telegram removal events clear
the matching notices and events for other connections are discarded.
Opening a notice routes to its exact chat, message and forum or bot topic.
Local dismissal does not send a read receipt.
TDLib's update for an existing notice refreshes its preview in place,
keeping its original position and banner deadline. Updates for a different
chat, topic or message are ignored. Permanent deletion removes matching
notices and repeated notification events cannot restore them. An incoming
push notice with a message ID can appear before the full message arrives.
It stays in the same row when TDLib supplies the exact chat and topic.
Opening and marking read become available after that update when supported.
BB does not show text from the push payload.
Installed Chromium in an isolated BB displayed two unique notices from
a repeated synthetic batch, kept the hidden preview private, retained the
list after the banner timeout, and removed only the matching entry on
the TDLib removal event before dismissing the remainder.
A separate run edited an older notice in place, hid its updated preview and
removed it on permanent message deletion. Replaying the original batch and
edit did not recreate it. The newer banner remained unchanged.
An installed isolated BB showed one pending push without a preview or read
and open controls. Replacing it with the full topic message added both
controls to the same row. Replaying the push added no row, and TDLib removal
cleared the notice. Neither synthetic preview was exposed.
A second run sent one read receipt for the resolved message with the forum
topic source and cleared the notice on acknowledgement. The pending push
sent no read receipt.
The banner and center can mark through one notice without opening the
conversation. The center can also mark through the newest listed notice
in each supported chat or topic. A failed read leaves its notices available
to retry. Local read acknowledgements and Telegram inbox and forum read
updates remove notices only through the confirmed position in that scope.
Chromium in an isolated BB marked an older notice and left the newer
notice visible. Bulk marking used the newest listed message, kept a
notice that arrived during the request, and cleared it after a Telegram
read update. The fixture recorded two read requests and no opened chat.

Keyboard activation of the inline player transfers focus to playback after
loading. Focus stays where the user moved it during loading, and a failed
load leaves the close control accessible. Escape closes the focused player
and restores the opener without leaving the conversation. Native fullscreen
has a visible control as well as a keyboard shortcut and keeps its native
Escape handling.
Isolated Chromium opened a synthetic streamed video with Enter, played and
paused it with Space, sought with Right and with a digit in native fullscreen,
and restored focus with Escape after leaving fullscreen. The fixture recorded
no stream request before activation.

Messages with a Telegram effect show a replay control. BB binds the effect
to the exact message and plays the supported TGS animation once in an
overlay. Reduced-motion mode shows the emoji without requesting the
animation. Installed Chromium in an isolated BB drew the effect on a
canvas, removed it at completion, and measured an unchanged message-row
height. The fixture observed no effect request before the click and one
metadata-only replay with reduced motion.
The private chat text composer lists effects from TDLib's available
catalog and checks account eligibility before dispatch. The send result
must contain the selected effect ID. Isolated Chromium selected an
effect without dispatching, retained the draft after a synthetic refusal,
and showed the effect on the acknowledged retry. The fixture confirmed
the exact 64-bit ID on both explicit requests. In a private chat, the
standard attachment composer also offers effects for one photo or video
sent immediately. UI tests and an installed isolated BB Chromium run
covered keeping the video draft and selected effect after a synthetic
refusal. TDLib fixtures and the installed run verified the exact effect ID
on photo and streamed video requests.
The album composer also sends one selected effect with a private-chat
album. BB checks that a confirmed member of the returned
album carries the same effect ID. A photo-album adapter test rejects
missing acknowledgement. Isolated Chromium sent a synthetic photo and
video in order and retried a refusal with the original caption and effect.
Exchanging the album draft clears the effect selection. A private chat
can combine the selected effect with a date for text, a single photo or
video, or an album. The send-when-online option covers text, individual
attachments, local GIF and audio uploads, and albums when Telegram
provides the exact recipient status. The adapter checks the date again
immediately before dispatch, or rechecks the recipient for the online mode.
An attachment or album draft keeps the online mode on exchange and asks
the user to clear it if the destination does not support it. Isolated
Chromium verified the online schedule and exact effect ID for a video
upload and a mixed album. Signed-in acceptance remains open.
The single-message forward review offers an effect for a private recipient.
Changing the recipient clears the choice. BB rechecks the source, recipient,
and effect before dispatch. The optional comment uses its own send without
the effect. BB checks the effect ID on the confirmed forward. The control
currently applies to individual history messages. Isolated Chromium
confirmed the exact source and recipient, with zero dispatches before the
explicit forward action.
An individual message, album, or selected batch can be forwarded when a
private recipient comes online if TDLib reports an exact last-seen status.
Premium accounts can repeat a dated forward of a single message. An
optional comment uses the same schedule. BB rechecks eligibility and
verifies the acknowledged scheduling state. This also works through the
channel inbox's reviewed source scope. Isolated Chromium tested the online
and weekly modes for a single message, and the online mode for an album
and a selection. Signed-in acceptance remains open.
In the conversation history, BB selects the newest visible unread
incoming effect and plays it once. The existing read-receipt observer
gates playback on visibility and suppresses it behind a modal or in a
hidden page. Reduced motion also suppresses automatic playback. An
isolated installed Chromium run played the unread effect in a
full-height panel, skipped the read effect, and verified that switching
away and reopening the chat did not replay it.
[TDLib message effects](https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl).

Private chat background settings accept Telegram photo wallpaper links.
BB resolves the link through TDLib, previews the downloaded photo, and
rechecks its identity and the current chat background before applying it
for the current user. The conversation renders the wallpaper's blur setting.
Installed Chromium in an isolated BB discarded one synthetic preview with
zero writes and applied the next preview with the exact remote wallpaper
ID and `only_for_self` flag. The same settings accept solid fills,
rotated two-color gradients and freeform gradients from shared links.
BB previews freeform gradients as a static blend and preserves the
original palette when saving. Installed Chromium applied a synthetic
45-degree two-color fill and a four-color fill, matched both rendered
backgrounds, and recorded zero image requests. PNG and TGV pattern links
also support review and application. BB combines the bounded image or
sanitized SVG geometry with the linked fill, intensity, and inversion.
An isolated installed Chromium run applied an inverted TGV pattern and
a regular PNG pattern and verified their masks in the conversation.
The pattern is static in BB. Signed-in verification remains open.
Wallpaper links in messages open a BB review. A direct chat is the suggested
destination when eligible, and other conversations offer a private-chat
picker. Applying checks both the wallpaper and destination background
revisions. A stale review can be reloaded before another confirmation.
Installed Chromium opened a native Telegram link from a synthetic group,
confirmed that cancellation made zero writes, and applied the linked
pattern to the selected private chat while keeping the group open.
Pasting a wallpaper link into chat search opened the same destination
picker and could be cancelled without altering a chat.
[TDLib background schema](https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl).

Telegram Desktop’s contact birthday celebration is available in BB contact
profiles for birthdays that Telegram exposes. The badge follows the local
calendar at midnight, including February 29. Its animation respects reduced
motion. Chromium in isolated BB opened a synthetic reader’s contact profile
and verified the badge and both motion settings. [Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

The Contacts list shows nearby birthdays reported by TDLib for current
contacts. It marks today's birthdays and opens the selected conversation.
The adapter resolves only contacts listed in the update and omits the birth
year from the reminder. Installed Chromium received a delayed TDLib
update, showed a contact outside the first page and opened their private
conversation. The run recorded zero sends. [TDLib birthday update](https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl).

Private contact notes are displayed in the contact profile and can be edited
or cleared in the chat’s contact settings. BB checks Telegram’s length limit
and the reviewed revision, and preserves supported formatting on unchanged
text. Installed Chromium read, edited and cleared a synthetic note. Its
TDLib fixture confirmed both updates used the exact contact and declined
phone number sharing. [Telegram contact notes](https://telegram.org/blog/comments-in-video-chats-threads-for-bots?setln=en).

BB sends a birthday suggestion from the saved contact’s settings after a
review of the recipient and date. The adapter verifies that Telegram allows
a free message to that user. An incoming suggestion shows the date and
requires a separate confirmation to fill the profile birthday. BB checks
the exact incoming message again and refuses to replace an existing date.
Installed Chromium exercised one synthetic suggestion and one synthetic
profile update, each after its confirmation. [Telegram suggested birthdays](https://telegram.org/blog/comments-in-video-chats-threads-for-bots?setln=en).

A saved contact can have a personal photo visible only to the current
Telegram account. BB uses the contact’s personal-photo revision and
Telegram’s separate personal-photo operation. Installed Chromium previewed,
saved, displayed, and then removed a synthetic photo after confirmation.
[Telegram contact photos](https://telegram.org/blog/hidden-media-zero-storage-profile-pics?setln=en).

BB also sends profile photo suggestions to saved contacts after a preview
and confirmation. It rechecks that Telegram allows a free message to the
contact. The received suggestion opens the exact photo from the private
message. Applying it checks the reviewed profile photo revision and uses
Telegram's existing photo ID. Installed Chromium exercised one synthetic
outbound suggestion and accepted one synthetic incoming photo after separate
confirmations. [TDLib profile photo suggestions](https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl).

Profile-photo privacy settings let the user preview, set and remove the
public fallback. BB uses Telegram's public-photo flag and verifies the exact
current public photo ID before deletion. An adapter test rejects a stale
revision or a photo ID that is also the main profile photo. Installed
Chromium saved and removed a synthetic fallback from the privacy panel.
[Telegram public profile photos](https://telegram.org/blog/hidden-media-zero-storage-profile-pics?setln=en).

Profile settings show the personal channel and allow the user to add, change
or remove it after review. BB limits the picker to channels returned by
`getSuitablePersonalChats` and checks the reviewed choice before calling
`setPersonalChat`. A contact's profile can also open their personal channel.
Installed Chromium in an isolated BB verified the picker, cancellation,
adding and removing a channel, and opening one from a contact profile.
[Telegram personal channels](https://core.telegram.org/api/profile).

Privacy settings list individual and group-member exceptions with
pagination. BB can add and remove reviewed targets in standard rule sets.
It checks the current revision, keeps unrelated rules in their existing
order, and shows custom rule combinations read-only. Installed Chromium
added one synthetic contact and removed one synthetic group exception.
The fixture verified that both confirmations left the base rules intact.
[TDLib privacy rules](https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl).

For group and channel invitations, BB can add and remove Telegram's
Premium-user exception. It checks the rule revision before sending the
change and keeps named exceptions ahead of a newly added Premium rule.
Chromium in an isolated BB verified cancellation without a write and
confirmed both changes. The synthetic TDLib fixture verified that the
named group restriction and the existing audience rules kept their order.

Privacy settings include who can send voice and video messages in private
chats. BB checks the current account's Premium status before changing the
audience or an exception. Chromium in an isolated BB verified the read-only
view for a standard account and saved the contacts audience for a synthetic
Premium account. The TDLib fixture confirmed the existing group restriction
was preserved. Signed-in Premium acceptance remains open.
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

Privacy settings include the default audience for new private chats, with
Everybody and My contacts and Premium users as the choices. BB checks
Telegram's current permission and audience before saving. An existing
paid-message rule makes the setting read-only in BB. Installed Chromium
verified an explicit save in isolated BB and verified that the unavailable
configuration had no save control. The TDLib fixture recorded only the
expected free-messaging change. Signed-in acceptance remains open.
[TDLib new chat privacy](https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl).

Review of prepared bot messages is limited by TDLib’s supplied result. For
example, an article result exposes a title, description, URL and optional
thumbnail. TDLib does not expose the outgoing message body in that result.
BB shows the validated result URL as text, presents contact, venue and game
labels, and shows the file name, size, duration, artist and dimensions when
supplied for media results. Isolated BB in Chromium displayed the synthetic
video metadata, sent nothing on cancel or destination selection, and sent one
result to the chosen test chat after explicit confirmation. The Mini App
frame remained open. Signed-in acceptance is pending.
[TDLib prepared result](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1prepared_inline_message.html)
and [TDLib article result](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1inline_query_result_article.html).

Telegram Desktop can request camera and microphone access for Mini Apps on
macOS and Windows. BB offers separate camera and microphone opt-ins before
launch on secure browser surfaces that support credentialless frames. The
default launch uses the opaque sandbox with device access disabled. The
opt-in launch uses an origin-scoped browser permission policy, a fixed
relay that verifies the sending window and origin, and a credentialless
frame restricted to the Telegram-supplied HTTPS origin. A separate BB
camera review still handles QR scanning. An isolated Chromium run with
synthetic HTTPS pages exercised both media devices, camera-only permission,
the two-way message relay, credential isolation and a blocked navigation
to the host origin. A separate Chromium fixture rendered the React launch
dialog, opted into the camera, observed one app-button event, and confirmed
one Telegram close callback and zero remaining frames after the app closed.
The fixture used synthetic data and a fake camera. Signed-in device
acceptance remains open.
Known named and main Mini App links offer a direct
handoff to the default system Telegram app. For bot profiles, BB offers
this handoff when Telegram supplies a public username and main app.
The link carries only the public bot, app name and documented launch
options. It is available before or during a BB launch and does not pass
the frame URL or authenticated session data. Chromium in an installed
isolated BB verified the native URL and zero BB Mini App launches while
intercepting the click before opening the system client.
[Permissions Policy](https://www.w3.org/TR/permissions-policy/).
[Content Security Policy frame-src](https://www.w3.org/TR/CSP3/#directive-frame-src).
[Telegram Mini App deep links](https://core.telegram.org/api/links#main-mini-app-links).
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

The Mini App bridge handles the keyboard dismissal, haptic feedback and
orientation lock events on hosts that expose the browser APIs. Haptics
require an active user gesture and are rate-limited. Keyboard dismissal
requires focus in the requesting frame. Orientation locks apply only to
that app's fullscreen window and are released on exit, hiding or close.
The fixture covers the frame and focus checks, rate limit and lock cleanup.

The context action on an inline message emoji opens a review for setting it
as a user status. It offers durations and can remove the current matching
status. BB checks Premium eligibility, the exact animated emoji and the
reviewed status before writing. Linked emojis keep their link action.
Installed Chromium set a synthetic emoji status after keyboard review and
confirmed its removal in a second review.

Instant View chat cards can review and confirm joining a public channel or
group, including chats that require approval. BB compares the article's
cached link, current chat identity and join mode before sending a request.
In isolated BB at 440 px, Chromium verified both join modes, focus on the
confirmation action, zero mutations on cancellation and the result in the
open article. Signed-in membership changes remain to be verified.

| Desktop function | BB gap | Evidence required to close |
| --- | --- | --- |
| Native Instant View | Eligible previews open formatted text, copyable code blocks with language labels, inline and displayed equations, inline dates and live relative times, inline JPEG/PNG/GIF/WebP images, article bylines with publication dates, section and reference links, cached article links with in-view navigation to the target section and return to the source link, email, phone and public Telegram mention links, related articles with cover thumbnails, public chat links, embedded posts, external embed cards that load URL content in a sandboxed frame on request and respect the article’s scrolling setting, and opt-in static text, lists and tables from supplied embed HTML even when a source URL is available, downloadable documents, link buttons including supported Telegram deep links and copy buttons, collapsible sections, quotes with nested article blocks, nested lists that retain media, downloadable attachments and section anchors, tables, maps, photos with optional destination links, MP4/WebM with muted autoplay for visible unspoiled videos flagged for autoplay, with automatic playback suspended outside the viewport or in a hidden tab and resumed on return, galleries with photos, video, audio and voice notes in BB. The article can open Telegram's supplied feedback bot. When TDLib returns an excerpt, BB keeps it available while the user retries loading the full article. Other media and rich article blocks are pending. | Open eligible links in the signed-in BB, including text-heavy and media-rich articles, and verify the original-page path for unavailable articles. |
| Telegram Business and quick replies | Settings manage shortcuts, create formatted text messages with links, display supported media including WebP and animated TGS stickers, edit message text and captions on photos, documents, videos, GIFs, audio and voice notes, and update the Business address, opening hours, start page, automatic greeting and scheduled away message. The composer can submit multi-message shortcuts in eligible private chats. Typing a slash prefix filters the list by name, with keyboard focus and Escape support. Chromium verified case-insensitive Cyrillic filtering and explicit selection. A test verifies that sending preserves a newer draft. The Edit action in the composer opens the reviewed shortcut in Telegram Business settings. BB reloads its ID and name before showing its messages. Chromium verified that closing the editor returns focus to the unchanged draft. The app fixture covers a shortcut renamed between selection and opening. Business bot settings configure account-level permissions and private-chat scope. Private chat details support pausing, resuming and removing bot access. New or existing shortcuts can receive streamed document, video, audio, GIF and voice message uploads, and saved documents can be downloaded through BB. Installed stickers can be added from their packs. Contact cards can be added and viewed in the shortcut editor. The editor saves anonymous text polls and quizzes with supported TDLib versions and displays their questions and options. Chromium verified creating and reopening a synthetic poll shortcut. An adapter fixture verifies the quiz payload and rejects a stale shortcut ID. Static locations and venue cards can be added and viewed. MP4 and WebM clips can be converted to video notes. Existing albums group consecutive messages in the editor. Photo and video albums can be created, with streaming uploads for video. TDLib excludes paid media, forwarded messages and live locations from quick replies. | Verify Business settings and chatbot access on an eligible account. Create, edit and send a multi-message quick reply, and check the unavailable state on an ineligible account. |
| Bot Mini Apps | Main and named Mini App links and the bot profile app launch in an isolated frame. Inline buttons and bot menu entries in private bot chats use TDLib launch and close. Inline results can also open the bot’s start screen, with an explicit action to send the start command. An inline bot result can expose a Mini App button whose launch is bound to the result’s bot and conversation. Its return action can replace the current chat or topic draft with a reviewed inline query. A return action with chat types can show recent or searched eligible users, bots, groups and channels and open the selected conversation with the query in its draft. Reply keyboard buttons can open an app and return data after user review. The loading indicator clears on the app readiness signal or iframe load. The app bridge reports viewport, theme and safe area insets, and supports main, secondary, back and settings controls. Apps can set the header, frame background, bottom bar and app action button colors. New permission for a bot to send messages and a request to share your own phone number require confirmation in BB. External links and supported Telegram links use explicit review. A reviewed web link can open in Instant View when requested by the Mini App. The app can request a closing confirmation, expanded window, or fullscreen with user consent. App popups show validated text and return the selected button ID. BB accepts one popup at a time and up to three per three seconds, with three-button dialogs stacking their actions. A Mini App can request setting or removing a Premium emoji status after explicit review. The current custom emoji or collectible status appears in profile settings and contact details, with expiry when present. Profile settings can select a featured, recent, default or owned collectible status, choose its duration and remove it. Supergroup and channel details show boost level, progress, current-user slots, unlocked features and the Telegram boost link. Boost links in messages, Instant View and chat search resolve through TDLib and open that chat’s boost information in BB. BB can apply an available slot or transfer it after its cooldown. The reviewed chat and slot state are rechecked before assignment. Eligible channel administrators can enable automatic translation. The channel owner can disable sponsored messages when the boost level allows it. Administrators can page through applied boosts and filter gift codes and giveaways, with source and expiry details. They also show the current emoji status and allow eligible administrators to select a themed or default status when the chat has sufficient boosts. Channels can also use eligible collectible gifts from their received gifts. Ongoing permission to change the emoji status requires a separate review naming the bot. Existing permission is read from Telegram and can be revoked from the bot contact profile. Clipboard requests require a recent interaction and an eligible bot. BB lets the user paste and review plain text before sending it to the isolated frame. File download requests are checked by TDLib and presented for user review before BB hands the URL to the browser. Custom method requests are routed to the bot bound to the current app session, and the isolated frame receives the matching result. DeviceStorage reads, writes, deletes and clears persistent local values scoped to the authenticated account and session bot under a 5 MiB quota. On macOS, SecureStorage saves, reads, removes and clears up to ten entries per bot through Keychain. The namespace includes the BB profile, Telegram account and session bot. Requests can read back accessible Keychain values through the restore event. Locked or unavailable Keychain access returns a failure. SecureStorage in a real Mini App remains unverified. BB and Telegram Desktop both report biometric access and home screen shortcuts as unavailable. A prepared message request shows the result metadata and a bounded thumbnail when Telegram supplies one, lets the user choose one eligible chat or an open forum topic and sends only after explicit confirmation. Telegram’s expired and invalid prepared-message ID errors reach the Mini App. The complete message body and full-size attachments remain unverified in this review. Geolocation is requested in the host browser only after user opt-in. BB remembers the grant or denial by Telegram account and bot, offers a permission panel and revocation from bot contact details, and keeps the coordinates out of persistent storage. A fresh permission check precedes coordinate delivery. QR scanning opens a BB camera dialog with explicit opt-in when the host supports QR detection. The isolated frame receives only newly recognized QR text. The camera stops on close. Other Telegram Web App events are pending. | Open an eligible app and verify initialization, permissions, lifecycle, and the app's supported return actions through an isolated host surface. |
| Gifts | Collectible gift links in chat messages and Instant View open a BB card with the edition number, available attributes and a thumbnail when supplied by Telegram. Profile details list visible gifts and collections for people and channels. Cards show available artwork thumbnails and play TGS animations. Profile cards and resale listings show collectible model, symbol, backdrop, rarity and supply when supplied by Telegram. Profile managers can hide received gifts, show them again, pin or unpin visible collectible gifts, and convert eligible regular gifts to Stars after explicit confirmation of the current amount. Regular gifts can be upgraded to collectibles after a price review showing available example models, with optional original details and a fresh TDLib price check before confirmation. Eligible collectibles can be transferred to a person or channel after reviewing the recipient and the current fee. Original details can be permanently removed from eligible collectibles after review of the current Stars fee. The user can list, reprice or delist eligible personal collectibles in Stars or TON after reviewing the price and proceeds rate. The signed-in user can create, rename, reorder and delete their own collections. The signed-in user can also change which collections contain a visible gift. Channel owners and administrators with posting rights can manage channel collections and their notifications for new gifts. Profile settings expose the gift-button preference and accepted gift types for Premium accounts. Eligible private chats show a composer shortcut to the gift catalog when either participant enables the gift button. The gift catalog displays Stars prices, supply and resale summaries, with an on-demand price and availability check. Basic catalog purchases allow sender and message visibility to be selected, with private sending as the default and explicit Stars confirmation. Gift sending supports optional plain-text messages and upgrade prepayment. Resale listings support sorting, Stars filtering, model, symbol and backdrop filters, and pagination that preserves the active filters. Resale purchasing supports Stars and Gram with explicit price confirmation. The auction view shows live snapshots, round times, bid thresholds and final results. Bids for eligible personal recipients require explicit Stars and recipient confirmation. | Verify profile gift browsing and eligible gift actions, including the costs and confirmation flow, without making an unapproved purchase. |

A Chromium fixture mounted the production chat page, opened a sandboxed Mini App,
and selected a synthetic group returned by its chat picker. BB closed the app
and placed the bot's query in that group's composer. The fixture recorded one
explicit initial search, one eligible-chat lookup, and no sends. This verifies
browser behavior with fixture-backed Telegram actions.

Mini App deep links can request a fresh sticker or custom emoji pack from Telegram.
BB applies the cache bypass to the first preview page after explicit link
review. Ordinary opening and pagination use the usual TDLib cache.
UI and TDLib tests cover review, cancellation, repeated opening and
rejection of a foreign frame or non-Telegram pack URL. In an isolated BB,
Chromium triggered the request from the sandboxed Mini App, verified zero
pack lookups on cancellation, and displayed the result of exactly one
uncached lookup after confirmation. The frame stayed available to resume.

BB opens custom emoji pack links in web and native Telegram format from
messages and in All Chats. Pack previews page through the artwork and
expose the canonical pack link. Installation uses the exact pack ID and
type from the reviewed link. BB reports success after reading back the
installed state. UI and adapter tests cover both link formats, pagination,
wrong pack identity or type, and an unconfirmed install. Chromium with an
isolated BB decoded custom emoji artwork, checked the Mini App refresh
path and observed exactly one installation request after confirmation.
The standard chat and forum topic composers can now browse the
account's installed emoji packs and insert their entries. The pack list
excludes archived, uninstalled and regular sticker packs. Page requests
recheck the selected pack and skip duplicate or mismatched entries. Chat
and forum tests cover pagination, insertion at a UTF-16 cursor position,
draft saving and sending with the exact emoji ID. Chromium with an
isolated BB installed a pack from its link, found it in the chat composer,
inserted the emoji at the cursor, and sent the exact 64-bit custom emoji
entity only after pressing Send. Real Telegram account acceptance remains
open.

Installed emoji packs are available in the message and caption editor,
GIF and album caption fields, and formatted-message text blocks. UI tests
cover retaining the original emoji during an edit, preserving an inserted
emoji when a formatted block changes, sending a GIF caption, and keeping
an individual caption attached to its photo after reordering an album.
Chromium in an isolated BB checked that one explicit edit preserved both
64-bit emoji entities with their exact offsets in the TDLib request.
The editor closed after TDLib confirmed the edit.

The chat and topic emoji picker can manage installed and archived emoji
packs. The user can reorder, archive, restore, or explicitly confirm
removal. TDLib reads and reorder requests use the custom emoji pack type.
The backend checks the current order before saving and reads it back
afterward. Management updates refresh the picker's choices. UI and
adapter tests cover ordering, archiving, restoration, cancelled removal,
and the distinction between regular and custom emoji pack IDs. Chromium
in an isolated BB verified the changed picker order, pack availability
after archiving and restoring, and the exact mutations emitted after
explicit save or confirmation. Cancelling removal emitted no mutation.
Real account acceptance is pending.

The chat and topic picker can discover trending custom emoji packs and
search for them by name. BB paginates by the native TDLib offset,
filters results to custom emoji sets, and checks the returned pack
identity and type before showing an installation action. Installation
refreshes the account's installed choices. Chromium in an isolated BB
loaded the next trending page at the native cursor, filtered a regular
pack, found a set by name, decoded its artwork, and observed one
installation request after a click. The set appeared in the picker.
Real account acceptance is pending.

Selecting a custom emoji in a standard message or media caption opens
its pack as a dialog in the current conversation. TDLib must return the
exact emoji and a custom emoji set that contains it. Later pages are bound
to the original set ID. The preview can copy the pack link and install
the pack on request. Linked or concealed spoiler artwork keeps its
existing behavior. The right-click and Shift+F10 emoji status actions
remain available. Chromium in an isolated BB opened the pack from the
message, decoded the emoji artwork, verified a single explicit install,
and restored focus to the source emoji on close. It also switched from
the status action to the pack via the keyboard. Real account acceptance
is pending.

Formatted messages also support opening an emoji's pack, including emoji
in formatted captions. An active selection over an emoji remains available
for quoting. Linked emoji keep their link, and emoji inside spoilers only
gain their action after the spoiler is opened. Pending or retained messages,
hidden table cells and Thinking placeholders do not expose the action.
UI tests cover opening a pack without changing a verified quote selection.
Chromium in an isolated BB reproduced the rich message through the installed
plugin, retained its active text selection and link, and verified that the
spoiler's pack action appeared only after reveal.

A separate Chromium fixture exercised the clipboard bridge in a cross-origin
sandboxed frame. A page-load request returned only its request ID. A browser
pointer click in the frame opened the review, and the synthetic paste stayed
in BB until the share button was pressed. This run did not access the system
clipboard or a Telegram account.

HTML widgets from bots show their captions in the Telegram timeline. A
client-only RPC retrieves the current widget for the selected message on
request. BB displays static text, lists and tables through the same inert
markup renderer as Instant View. Widget scripts, styling, external
resources, live state and requests to the bot remain outside this preview.
An installed BB Chromium fixture loaded the widget once on click, preserved
caption placement and recorded zero external requests and sends. Verification
with a real bot remains open.
[Telegram widget specification](https://core.telegram.org/bots/widgets).

Bot game messages display their title and instructions. BB rechecks the game
button on the current message, uses Telegram's game callback, and displays
the destination host before opening an isolated viewer. Chromium in an
isolated BB recorded one synthetic TDLib callback, no game requests before the
host review, one game request after approval, and removal of the frame on
close. It recorded no sends. Game cards also show eligible Telegram cover
photos and animations. Game score notices identify the player and link to the
original game message. The card preserves the formatted score text supplied
by the bot. The game viewer can open BB's forwarding review for the original
message from a native share button or a game frame request. The user chooses
the destination and confirms forwarding in BB. TDLib marks its dedicated
high-score methods as bot-only, and its forwarding API has no score flag.
Score sharing, a user-account scoreboard route and live verification remain open.
Chromium in an isolated BB decoded a synthetic game cover through the plugin
RPC and opened the referenced game from a score notice. The fixture recorded
zero sends. Adapter and UI tests cover the animation reference and player.
An installed BB Chromium fixture confirmed that a game load leaves the
forward review closed. A pointer click in the sandboxed game opened the
review with an empty destination. Only the BB Forward button sent one
synthetic forward of the original game to the selected fixture chat.
Official game links open a bot and game preview in All Chats. The user chooses
a private chat, group or open forum topic and confirms sending the game.
Tests cover link validation, a changed bot or destination, and the final
send with the correct game short name.
Chromium in an isolated BB tested the installed plugin from pasted link to
delivery. Synthetic TDLib recorded zero sends before confirmation and one
game send with the reviewed bot and private chat after confirmation.

The following paid-message and Stars notes record the frozen implementation
and its verification gaps.

Mini Apps can review and confirm one-time and recurring Stars invoices issued
by the launch bot. Recurring invoices show the price and billing period.
The server binds each confirmation to the reviewed TDLib form and accepts
it once. Closing the preview reports cancellation and keeps the app open.
Fixtures cover preview, cancellation, payment and confirmation replay. Live
checkout, other invoice types and additional verification flows remain open.
Telegram settings list Stars subscriptions with the price, billing period
and renewal status, and show the Stars balance and the amount needed for
upcoming renewals. Canceling or resuming renewal requires confirmation
against the current subscription details. Live account verification remains open.
Stars settings also show the signed-in account's transaction history, with
direction filters, pagination, refund markers and exact fractional amounts.
Subscription rows open a transaction view scoped to that subscription.
Channel subscription invitations show the Stars price and billing period,
recheck the terms before payment and can reuse a paid period without a new
charge. Live joining and payment remain unverified.
Channel administrators with invite rights can create 30-day subscription
links within Telegram's current Stars price limit. Invite lists show the
recurring price. Subscription links can be renamed while keeping the price
and period. Creation and renaming on a live channel remain unverified.
Subscription invite settings show Telegram's expired-member count and can
page through members whose subscriptions expired.
Channel details can show the channel balance and transaction history when
TDLib grants the account access to Stars revenue statistics. The summary
shows total earned, current balance and Stars available for withdrawal,
including Telegram's withdrawal cooldown. It can display daily revenue,
including asynchronously loaded data. Withdrawal itself remains open.
Transaction details expose the counterparty when resolved and a copyable ID.
They can open the original message for paid media, paid channel reactions and
giveaway credits when Telegram includes its chat and message identifiers.
In private chats, the text composer shows the current per-message Stars
price for the signed-in account. Manual paid text, single photos, documents
and videos require review and a separate price confirmation. BB checks the exact
price with TDLib again before dispatch, including after staging an attachment.
Photo and mixed photo/video albums show the per-item price and the total on
the send action. BB rechecks the current per-item price after staging and
passes the total to TDLib. Other media, incoming-price settings and
signed-in acceptance are pending. [TDLib disallows scheduling in chats with paid messages](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L5750-L5763).

Paid-media messages show captions, locked thumbnails and the price in Stars.
The purchase flow rechecks the locked message and current Stars form before
submitting. Unlocked photos and known-size MP4/WebM videos open in the chat
with photo dimensions, video covers and any video start time supplied by Telegram.
Paid live photos show their still image separately from the motion player.
The album composer can publish one to ten photos or videos in one priced message
in eligible channels. It rechecks the channel and Telegram's price limit before
sending. Sending to a live channel remains unverified.
Stars reaction counts can open the top reactors and the account's own
contribution. Anonymous entries retain their anonymity. The picker can send
a Stars reaction on behalf of the account, anonymously or on behalf of a
chat returned by Telegram after reviewing the amount. BB checks
current eligibility and the Stars limit before submitting. The leaderboard
can change the visibility of the account's existing reaction. Live delivery
and privacy changes remain unverified. Channel reaction settings preserve
Stars when editing a selected reaction list and expose an explicit toggle.
Media routes recheck the attachment against the current message, and paid
attachments do not use document download actions. Live checkout and playback
remain to be verified on a signed-in account.

Instant View offers downloads for documents and non-spoiler audio, video
and animations that have an attachment but cannot be played inline. It
retains captions, including in collages and slideshows. BB resolves the file
again against the cached article before downloading.

The native SecureStorage adapter passed 11 checks using synthetic values in
the macOS Keychain. The checks covered Unicode round trips, bot and account
isolation, ten-item capacity under concurrent writes, replacement, removal,
reuse of a freed slot and clearing. Its temporary Keychain entry was removed.
The native helper serializes operations with a per-profile file lock and
receives all data through stdin. The check used no real bot or Telegram
credentials. Ordinary regression tests use an injected native port.

A separate integration run passed 22 checks through a temporary BB profile,
the plugin's session-scoped RPC handlers and the native macOS Keychain
adapter. A synthetic TDLib fixture supplied the account and two bot
identities. The checks covered round trips, bot isolation, rejection of a
closed Mini App session, a ten-item quota, removal and reuse of a slot,
clearing, and persistence across plugin reload and fixture reconnection.
The cleanup used the native adapter and removed the temporary bot namespaces.
No real Telegram session or credentials were accessed. Real Mini App
acceptance in the signed-in main BB remains pending.

Mini Apps receive Telegram's visibility event on readiness and when the BB
document is hidden or visible again. Repeated unchanged visibility events do
not generate duplicates, and closing the dialog removes the listener.
The event shape follows the [official Telegram Web App SDK](https://telegram.org/js/telegram-web-app.js).

Mini App custom method failures return Telegram's machine-readable RPC error
name with the original request ID while the app session is active. Local
diagnostic error text is kept out of the Mini App response.

The Telegram panel owns Mini App windows opened from chat controls, bot
profiles and links. A user can minimize a running app and resume it from
the panel. When a reviewed Telegram link opens in BB, the source app
minimizes automatically and keeps its iframe and TDLib session. The iframe
receives visibility changes on minimize and resume. A Chromium fixture
verified one launch and one final close across navigation to another chat.

Mini App launches pass BB's palette to TDLib and use the same colors for
subsequent theme events. Direct links preserve Telegram's launch mode.
BB opens full-size apps expanded and offers a fullscreen action when the
browser supports entering fullscreen and the launch requests it.

The composer can launch installed attachment-menu Mini Apps in supported
chats and open forum topics. The confirmation names the destination. BB
rechecks the bot, its installation and chat eligibility before opening a
TDLib session for that destination. A current-chat attachment link can
install the bot with explicit consent and open its Mini App in the captured
chat or forum topic. The dialog shows the destination, terms and any write
permission that Telegram requests. The adapter rechecks the bot and
destination before performing the installation. Links with `choose` offer
recent chats and search filtered by both the link and the bot. The final
review names the selected chat. Links with a fixed public username or phone
number resolve that destination through TDLib. BB shows the resolved chat in
the review and rechecks its ID before launching the app.

The Telegram sidebar lists installed side-menu Mini Apps. BB can open one
without a selected chat and asks for acceptance when Telegram supplies a
third-party disclaimer. The launch uses TDLib's side-menu URL request and
rechecks the entry, bot and disclaimer before opening the frame.
The same panel lists installed apps from both menus and supports account-wide
removal through TDLib after confirmation. BB rechecks the entry and its menu
placement before applying removal and serializes changes for the same bot.

When TDLib reports that a Mini App returned a message, BB retires the
corresponding session and closes its active or minimized window. Duplicate
updates and messages from other launches leave the remaining windows open.

A Chromium run mounted the production Mini App dialog with a cross-origin
sandboxed frame and a CDP geolocation override. Checking availability and
opening the review made zero browser location reads. Allowing made one read
and delivered the synthetic coordinates and accuracy. Denying through Mini App
location settings prevented further reads and returned only unavailable.
The test used fixture-backed permission actions and no Telegram account.

Chromium rendered the static preview of a synthetic HTML-only embed on request.
Formatting was visible, while the embedded script, event handler, image,
frame, active link, and stylesheet were absent. The browser made no requests
for the embed’s resources.

External Instant View embeds support Telegram's `resize_frame` event after
the user loads them. BB applies the height only to the iframe that sent the
event, up to 4096 CSS pixels. Reopening an embed starts with its declared
aspect ratio.

Instant View resolves links to standalone anchors and media-caption references
within collages and slideshows. A link selects the destination slide before
scrolling to its caption. A fixture verifies that this leaves a video spoiler covered.
Links to references inside tables open containing sections and focus the target cell.
Links inside an article can also target a quoted paragraph or its attribution.
Instant View opens a collapsed quote before focusing the reference. Returning
to the source link restores the previous disclosure state. UI fixtures cover
ordinary quotes, expandable quotes, and quotes with nested blocks. Chromium
in an installed isolated BB verified three targets and focus restoration,
including two returns to a collapsed quote's original state. The jumps used
one article request in total.

Instant View preserves the article's kicker, subtitle, footer and centered
pull quotes. Quotes with code or nested quotes retain their original
structure. Code keeps its language label, spoiler handling and Copy action.
Chromium in the isolated BB verified these roles at 1360 and 440 CSS pixels
with no horizontal overflow.

Direct `t.me/iv` links open from messages, from within articles, or when pasted
into chat search. BB passes the selected template hash to TDLib when present.
Links without a template hash request Instant View for the original URL.
The viewer keeps an explicit link to the original even when Telegram cannot
load the article. In Chromium, the plugin installed in an isolated BB passed
the fixture template hash to TDLib and preserved section navigation, scroll
position and focus on return. The signed-in main BB returned 27 blocks and a
JPEG for one public competition template, and rejected another public template
as unavailable.
Article hashtags and cashtags open the Telegram public-post search with the
tag filled in. The search runs when the user submits it. Tags covered by an
article spoiler become actionable when the spoiler is revealed.
Named mentions with a Telegram user ID open the mentioned profile even when
the user has no public username. BB checks the cached article before resolving
the profile, and keeps the article open if the user is unavailable.
Inline profile buttons and button rows use the same cached-article check.
Profile buttons attached to messages reopen the current Telegram message and
verify the original row, column and button revision before opening details.
Inline and reply keyboard buttons preserve Telegram's primary, danger and
success styles and load decorative custom emoji alongside the label.
Inline bot buttons that allow a selected chat can browse recent and matching
chats, filter by the bot’s allowed chat types and recheck posting rights.
Choosing a chat puts the bot query in its composer. Forum destinations list open topics with search
and pagination. BB checks the selected topic again and presents the query for
insertion in that topic’s composer, with a replacement prompt for an existing draft.
Mini Apps launched from inline results use the same topic destination checks.
The app closes only after BB accepts the destination and opens its draft review.
Telegram links on bot buttons and in callback replies use BB navigation
after confirmation. BB accepts supported native links and web aliases.
Copying a code block becomes available after all of its spoilers have been
revealed. Table navigation labels follow the visible caption.
Returning from a linked Instant View page restores the selected slide and
the source link. Separate visits to the same URL keep independent selections.

Pending rich messages retain Telegram's formatted Thinking placeholder.
The viewer exposes it as a status until Telegram replaces it with the completed
reply, and the local layout remains incomplete while the placeholder exists.
Pending placeholders are excluded from the message editor.

Message and conversation translation also support Telegram rich messages.
Translations preserve supported headings, lists, tables, inline formatting
and attachment captions. The original message supplies the media controls.
Chat translation remembers the selected language in the account’s BB session.
An unavailable automatic translation can be retried on the affected message.

Telegram Desktop's changelog lists passkey login on Windows. Check platform
support separately before treating it as a missing macOS login method.

Profile music lists and plays supported audio in private-chat and Saved
Messages details. Saved Messages supports removing and reordering your
profile tracks. Settings also expose music for the signed-in profile.
Supported chat audio can be added to your profile after confirmation.
Account exports can opt into a profile music index and, when attachments
are selected, the corresponding audio files. Live verification remains open.
Chromium used the production profile music panel and its HTTP range route
to start a synthetic MP3 and seek to 01:25 after receiving 786,432 of
4,003,047 bytes. Listing the track alone made no audio request.
The Communities panel lists joined communities and opens chats when TDLib
reports that their history is viewable.
TDLib community updates refresh collapsed chat-list entries and the open
Communities panel. Replayed updates are coalesced, stale responses are
discarded, and loss of access returns the panel to the community list.
In isolated BB, Chromium verified that asynchronous fixture updates unfolded
the sidebar entry and replaced the membership shown in the open panel.
Community message and media search sends a community filter to TDLib and
checks each result against the current viewable community chats. It reuses
date and media filters, and routes an opened result to its original chat or
forum topic. Chromium in isolated BB requested two scoped pages, filtered
out an unrelated result and opened the matching message in context. A UI
fixture checks routing for a forum topic result.
The panel creates a community after
reviewing its name and an eligible owned supergroup or channel returned by
TDLib. Eligible owned bots also appear in the first-chat and add-chat
pickers. BB checks their current ownership and community association before
either action. Isolated Chromium added one synthetic owned bot, then used
another to create a community. The picker excluded bots already attached
elsewhere and neither operation ran before confirmation.
Owners and administrators can rename the community or add and
remove chats when their corresponding rights allow it. Administrators
with chat-list rights can review and decide pending chat requests, including
applying a reviewed decision to the complete queue when it is unchanged.
A community member can remove their own supergroup, channel, or bot
after review. Before removal, BB checks the current title, visibility and
the required ownership or administrator rights. Isolated Chromium canceled
the review without a mutation, then removed one owned fixture channel after
confirmation and kept the other channel. Adapter tests also cover owned bots
and ownership changing after review.
Community details show administrator, community-wide ban and pending chat
request counts to owners and administrators. Eligible moderators can select
a banned user or chat sender from a community chat's banned-member list,
review the community name and confirm a community unban. The adapter
rechecks the exact sender, ban expiry, current community association and
moderator rights before dispatch. Fixtures cover both sender types.
Isolated Chromium confirmed cancellation dispatches no mutation and
confirming the channel sends the exact community and channel IDs with no
chat-level status request. Signed-in acceptance remains open. The published
TDLib API supplies a community-wide count and a mutation for a known
sender. The optional [TDLib extension](tdlib/README.md) queries the
community's banned participants with the filter used by Telegram Desktop.
BB loads pages on request, deduplicates users and chats, and shows ban
expiry. Moderators with ban rights can review and remove a ban directly
from this list. Before dispatch, BB rechecks the rights, sender and expiry
on the reviewed page. A confirmed change reloads the list from its first
page. The adapter and UI fixtures cover administrator access, pagination
and the unavailable state on stock TDLib. The patched arm64 library built
successfully and recognized the JSON request before initialization; an unknown
control request was rejected by the JSON parser. Signed-in acceptance remains open.
[TDLib community methods](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L11212-L11284).
The same banned-member list shows banned chat senders in supergroups and
channels. The chat-level unban checks the actor's rights, sender ID, and
current ban expiry. Live verification of chat-sender moderation remains open.

The forward review can browse chats inside a joined community, including
when its chats are collapsed in the main list. The adapter checks current
community membership and TDLib's history access flag before resolving
each recipient. The existing forward review verifies chat identity and
forum topic at dispatch. Chromium in an isolated BB forwarded one
synthetic message to a channel absent from the ordinary recipient list.
No request resolved the inaccessible chat, and no forward was made
before the explicit action. A UI test covers forum-topic selection.
Signed-in acceptance remains open.
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

A moderator can ban an external chat sender from an incoming message. BB
requires confirmation of the target chat and sender, then rechecks
moderation rights, the message's sender and the sender's current status.
Chat details offers separate confirmations for removing a member and
clearing their messages for everyone. The removal sets the member status
to Left in eligible basic groups, supergroups and channels. Message
deletion uses TDLib's sender-specific deletion only in supergroups
and requires the right to delete messages. Both actions verify the exact
member, the reviewed role and join date, and current moderation rights.
Existing bans retain the duration review and use ban-specific wording.
Chromium in an isolated BB cancelled a removal review, confirmed a
synthetic sender-specific deletion and checked that both members remained.
A changed join date blocked removal with an old review. The refreshed
review removed exactly one member and kept the other. The native fixture
recorded two mutations and no bans or sends.
Chat details lets members with invite rights select and review up to 100
contacts across searches. BB rechecks permissions and membership, uses one
TDLib batch in eligible supergroups and channels, and reports each outcome.
Basic groups use individual additions. Installed Chromium verified that
cancellation issued no invitation and that one confirmed supergroup
request showed an addition and a refusal separately. The adapter fixture
also verified the basic-group path and a rights change before dispatch.
[TDLib addChatMembers](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1add_chat_members.html).
The group and channel member lists support contact and bot filters.
Supergroups and channels use TDLib's native filters. Basic groups filter
their returned roster before paging. Adapter and UI fixtures cover filtering,
contact search, pagination, and moderation capability on filtered results.
Recent actions distinguish the moderator from the affected user or chat,
show before and after membership status and tags, and identify the approver
of a join request. An installed isolated BB build with synthetic TDLib
exercised the members filter, an administrator role transition and join
approval through the registered RPC. Rights changes within the same role
now expand to show individual grants and revocations when Telegram provides
both administrator-right or member-permission snapshots. Fixtures cover
missing flags and overlapping legacy aliases. A later isolated BB install
returned two opposite rights changes for an unchanged administrator role.
Chromium at 360px verified keyboard expansion with Space and no horizontal
overflow. Signed-in verification remains open.
The journal labels explicit joins and departures, removals, bans and
unbans, and member restrictions. Timed bans and restrictions show the
expiry, and changes to an existing expiry show both values. Pagination
advances through short or partially renderable results using the oldest
valid Telegram event ID. It ignores duplicate and non-advancing IDs.
Chromium in an isolated BB verified a changed ban expiry, distinct removal
and voluntary departure entries, and a short page followed by another page.
Deletion events can display text or a caption and the original sender from
the Telegram administrator journal. The server checks the snapshot's chat
and sharing flags and masks spoilers. The panel opens the event snapshot
without loading the deleted message or its attachments. Poll closure events
can navigate to the original topic. An installed isolated BB verified the
preview and omission of protected and foreign-chat snapshots. Chromium at
360px verified keyboard expansion. Signed-in verification remains open.
The journal also renders formatted message snapshots from edit, deletion,
pin and unpin events. The comparison detects formatting-only changes.
Headings, tables and other supported static blocks render without links,
button actions or attachment loading. BB checks the chat and message
identity, sharing flags and expiry restrictions before preparing the snapshot.
Isolated Chromium verified emphasis changes, a deleted table, a pinned
snapshot and omission of the spoiler text and protected snapshot.
Signed-in verification remains open.
Eligible aggressive anti-spam deletions offer a false-positive report with
explicit confirmation. BB rechecks administrator rights and the exact
deletion event before calling TDLib and deduplicates submissions within the
current session. An isolated BB verified one synthetic dispatch and refusal
of a stale event. Chromium verified cancellation and confirmation at 360px.
The settings journal shows before and after values for title, description,
editable and active usernames, auto-delete and slow mode, and individual
changes to default member permissions. The installed isolated BB settings
filter returned a cleared description, a newly enabled auto-delete timer
and a revoked default photo permission. Chromium at 360px exercised
keyboard expansion and the cleared value. Live verification remains open.
Forum events show the recorded title and distinguish renamed, closed,
reopened, hidden, shown, pinned, unpinned and deleted topics. The user can
open current topic history after BB resolves and verifies the chat and
topic IDs. The installed isolated BB verified the forum filter and event
payloads. Chromium at 440px verified the transition from the open journal
to topic history. Signed-in verification remains open.
The invite journal shows name, expiry, member limit and approval mode for
edited, revoked and deleted invites, and identifies joins through folder
links. It compares snapshots for the same invite and omits invite URLs
from the journal RPC. An isolated installed BB verified edit, revoke and
delete events, and Chromium at 360px verified keyboard expansion. Signed-in
verification remains open.
The settings journal compares all, selected and disabled emoji reactions,
including custom emoji and the per-message limit. It ignores changes that
only affect Stars reactions. An isolated installed BB verified both
snapshots and Chromium at 360px verified keyboard expansion and deferred
custom emoji loading. Signed-in verification remains open.
Supergroup details can view, set and remove the regular sticker pack and
custom emoji pack. BB resolves the short name or Telegram link, shows the
reviewed pack, and rechecks its identity, the current setting, administrator
rights and boost eligibility. An isolated installed BB exercised both pack
types, removal, and exact 64-bit sticker set IDs. The sticker picker in groups
and forum topics can browse and send the assigned regular sticker pack,
without using the account's installed set list. The server rejects stale
assignments and foreign stickers. An isolated BB dispatched one synthetic
sticker, and Chromium at 360px verified pagination and explicit send.
The assigned custom emoji pack is available in the standard chat and topic
composer and supported captions. Formatted message text and attachment
captions can also use the assigned pack. The formatted editor preserves
custom emoji IDs when reopening editable text and supported welcome-message
captions. The picker is also available when editing a sent formatted message
from group or topic history and search, and when editing a formatted group
welcome message. Installed Chromium submitted a synthetic formatted message
with the exact 64-bit emoji ID. A second installed run saved one edit to an
existing synthetic group message and verified both the old and new emoji IDs
in the TDLib edit request, with zero sends. A UI test covers the same edit
from a forum topic. Signed-in verification remains open.
Formatted messages display Telegram's six heading sizes and optional code
language labels. Both values are editable and survive saving the message.
Installed Chromium verified the original and updated rendering and the exact
values in one synthetic TDLib edit, with zero sends or uploads.
Standard formatted tables now keep their caption, borders,
alternating row colors and cell density through creation and editing.
Installed Chromium changed a caption and enabled alternate colors while
preserving the compact borderless layout and a trailing empty cell.
Table captions preserve supported styles, links, custom emoji and inline
formulas. Captions and quote attributions accept supported HTML clipboard
formatting. Installed Chromium pasted a bold prefix into a table caption
and verified the original italic run and formula in the resulting edit and
rendering. Structured tables can edit cell contents without changing
row or column spans, headers, alignment or hidden cells. Installed
Chromium verified a formatted cell edit and the preserved structure in
the TDLib request and resulting table. An editable table can merge a cell
with an empty neighbor to the right or below and split a span back into
individual cells. The original contents stay in the top-left cell. The
installed browser run merged, split and saved a synthetic table with all
other contents intact. A fixture covers vertical merges and splits.
Formatted drafts can add and reorder dividers and edit attribution for pull
and expandable quotes. Existing supported inline formatting in the credit
survives edits. Installed Chromium verified the divider order, keyboard focus
and styled attribution in one synthetic edit, with zero sends. Block quotes
with paragraph children can be created and edited, including supported
inline content and attribution. Installed Chromium updated one paragraph
and added another while preserving the first paragraph's italics and the
attribution. Quotes with non-paragraph children remain available for viewing
where the renderer supports the child blocks.
Formatted list items can contain several rich paragraphs and have an
optional checked or unchecked box. Ordered lists support decimal, alphabetic
and Roman markers with explicit values. BB follows TDLib's requirement that
a list contain either bullets or numbered items. Existing items keep their
paragraphs and inline formatting. The editor declines edits to custom labels
or non-paragraph children that the draft cannot reproduce. Chromium in a
separate installed BB changed an explicit Roman numeral and checkbox, edited
a paragraph, and added a list item while retaining the unaffected item and
the first paragraph's italics. The fixture recorded one edit and zero sends.
Formatted messages render standalone and inline LaTeX with the same MathML
renderer as Instant View. The composer can create and edit standalone
formulas with a live preview. Installed Chromium changed a fraction to a
square root, verified the preview and final layout, and reached TDLib with
one synthetic edit and no sends. The editor can mark selected LaTeX as an
inline formula, edit its source and remove the formula annotation. The wire
encoder and editable draft preserve inline formulas in formatted blocks,
attachment captions and supported quote attributions. Installed Chromium
edited an existing inline formula and marked a second one, then verified
both in one synthetic edit and in the updated message.
Channel details can list eligible discussion groups and explicitly confirm
linking, replacing or unlinking a supergroup. Before changing the link, BB
rechecks the channel's administrator rights, the reviewed link, the target
and its history visibility. If Telegram requires visible history, the channel
panel offers a separate confirmation to change that setting in the group.
The server rechecks the channel link, eligible group, reviewed name and
history permissions. A new confirmation is needed to link the group after
history is enabled. An isolated BB and Chromium at 440px verified the
separate history change and link. The group picker also offers an explicit
upgrade review for eligible basic groups. BB verifies ownership, eligibility,
and Telegram's migration mapping, and can recover the already migrated group
without submitting a second upgrade. Chromium and an installed isolated BB
verified the separate upgrade and link steps and the new chat identifier.
The owner can also upgrade an active basic group from its information panel.
The direct action reuses the migration checks and offers to open the verified
new chat. An isolated installed BB verified owner eligibility, stale review
refusal and lookup of the new chat. Chromium at 440px opened the migrated
conversation after the explicit upgrade and navigation actions.
Old basic group information now links to the verified replacement and
removes editing controls. If an upgrade response is lost, BB checks the
old group's Telegram migration mapping before offering the replacement,
without resubmitting the upgrade. The isolated BB fixture committed the
upgrade and returned an error. Both the RPC and the old chat information
still identified the replacement. Chromium verified reload and navigation.
At the start of a migrated supergroup's timeline, BB can open the original
group after verifying the relationship in both directions. Older messages
use the original conversation and message IDs. BB only looks up the
predecessor after exhausting the supergroup pages. An installed isolated BB
verified the boundary and both histories, including overlapping message IDs.
Chromium at 440px verified the link after scrolling up and opened the old chat.
The old conversation displays its migration after the newest message and
offers a return to the verified supergroup. The composer is unavailable
there, including when the migration is known but the destination cannot be
resolved yet. Isolated BB and Chromium fixtures verified both directions,
and the original history remained independently readable.
The settings journal compares the old and new
linked chat names. An isolated installed BB linked a fixture group, confirmed
the returned current link, rejected an out-of-date unlink, and unlinked the
group. Discussion supergroup details also show the linked channel and let
administrators with pin rights unlink it. BB serializes edits across both
participants and rejects an outdated link. A later isolated install exercised
channel-side linking and group-side unlinking via the installed RPC. Chromium
at 440px verified review and confirmation from group details. Signed-in
acceptance remains open.
The [TDLib community details schema](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L2430-L2440)
exposes `banned_count`. The [moderation methods](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L11267-L11284)
can change the ban for a known member ID and show that member's associated
chats. Telegram Desktop starts its removed-users controller for the
community and uses the channel-participants request with the kicked
filter. TDLib holds the community's input channel in CommunityManager
and supplies no public participant-list operation for it. The community
list remains open.
[Desktop community management](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/boxes/peers/manage_community_box.cpp).
[Desktop participant queries](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/boxes/peers/edit_participants_box.cpp).
[TDLib CommunityManager](https://github.com/tdlib/td/blob/master/td/telegram/CommunityManager.cpp).
Moderators can preview a community-wide ban from a member row, see affected
chats and owned chats that would be removed, and confirm the reviewed scope.
Other members can suggest an eligible chat and see their own pending
requests.
Owners can delete their community after confirming the current name.
Community notification controls offer Telegram defaults, unmute and timed
or indefinite mute while preserving other notification settings.
Owners and administrators with change-info rights can replace or remove the
community photo through BB's existing avatar editor. The same editor
accepts MP4 and MOV, previews the video, and saves a reviewed range and
cover frame using TDLib's community-photo animation upload. The adapter
checks the exact community's version and edit rights before and after
preparing the clip. A fixture checks a trimmed landscape source, cover
offset, rejected stale versions and revoked rights. Chromium in an
installed isolated BB decoded a landscape MOV, selected seconds 1–2
and confirmed one upload to the selected community with a 0.5-second
cover offset. The fixture recorded zero avatar writes during review.
Community avatars appear in the list and details. BB loads the full image
on visibility after checking the current community photo reference.
The community details can also play the current animation, including
the smaller variant when Telegram omits the full video. Playback starts
on demand. Each stream range checks the same community, current photo ID
and animation file. Tests cover access loss, a replaced photo, a replaced
file and leaving the community while the player is open. Chromium in an
installed isolated BB decoded the smaller animation, observed no video
request before Play, and rejected a range from the old ticket after
replacing the photo.
The owner and eligible moderators can set whether regular members may
edit the community chat list.
The main, unfiltered chat list folds viewable, non-hidden chats into one
row for a collapsed community. Chat search and type filters keep individual
chat rows. The detail panel can collapse and expand the community. Expansion
requires confirmation because Telegram removes the community from folders.
The optional [TDLib extensions](tdlib/README.md) read explicit community
peers from the selected chat folder. BB displays only those communities and
preserves the mixed order of pinned chats and communities. Folder writes
through the standard chatFolder object preserve stored community peers in the
patched TDLib. Adapter and UI fixtures cover folder boundaries, membership,
pin order and a stock library with no extension. The patched arm64 build
recognizes both community requests before initialization. Signed-in
acceptance, including saving a folder containing communities, remains
open. Community details can add a collapsed community to a folder and
remove an existing membership. The edit checks the reviewed folder and
membership, preserves unrelated peers and enters TDLib's synchronization
queue. The UI refreshes the reviewed values on a conflict. Adapter and UI
fixtures cover adding, removing and a stale folder selection. The patched
arm64 library recognizes the write request before initialization.
[Desktop filter rules](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_chat_filters.cpp).
[TDLib folder export and loading paths](https://github.com/tdlib/td/blob/master/td/telegram/DialogFilterManager.cpp#L777-L900).

Group and channel details load TDLib's welcome-message list and support adding
and editing text with supported formatting and links. Removing an individual
greeting requires confirmation. The adapter relies on TDLib's administrator
permission check and compares the reviewed revision with the available
snapshot before editing or deleting.
The fixture covers permission denial, changes visible in that snapshot, and
unsupported content refusal. The editor retains supported entities and
existing link-preview settings and refuses to overwrite unsupported entities.
Photo greetings support lazy preview, a larger view, creation with an
optional caption, caption edits using the existing Telegram file, and photo
replacement. Edits retain existing spoiler and caption-placement flags.
Preview requests recheck the chat and reviewed revision. Downloading the
photo does not invalidate that revision. Other media show their caption or
type.
Welcome messages display contact cards and static locations with coordinates
and optional place details. The editor can create and update these types and
protects contact bindings, vCards and venue metadata from being overwritten.
Chromium at 1422 and 390 px created and edited a synthetic contact and venue,
kept the save button disabled for an incomplete venue and confirmed deletion.
Sticker greetings use Telegram's installed regular sticker packs. Saving
rechecks the selected pack and file. Existing WebP, TGS and WebM artwork is
loaded on visibility using the reviewed chat, message and revision. An
adapter fixture read all three formats and rejected an uninstalled pack,
another pack's sticker and a stale revision. Chromium at 1422 and 390 px
selected, saved, rendered and replaced synthetic WebP stickers.
GIF greetings can be added or replaced using saved animations, with optional
formatted captions. Caption edits reuse the existing file, and saving keeps
the spoiler and caption-placement settings. Supported existing GIFs, audio,
voice notes, videos and video notes use the private playback route. The
route rechecks the reviewed message before serving each range. Chromium at
1422 and 390 px selected a saved GIF, played a synthetic WebM with looping
after revealing its spoiler, and saved a caption edit.
Supported existing documents, audio, videos and voice notes allow caption
edits using their existing file references and available media settings.
The adapter fixture checks video cover, start time and spoiler settings,
audio title and artist, and voice note waveform. Welcome documents show their
name and size and use a private single-use download ticket tied to the chat,
message and revision. Chromium at 1422 and 390 px requested a document
download, cleared its caption and requested a download using the new revision.
The welcome editor also streams document, MP4/MOV video, MP3/M4A audio,
local GIF, Ogg/Opus voice and MP4/WebM video-note files. The same type can
replace an eligible attachment. BB rechecks permissions and the reviewed
revision after staging and keeps the staged file until TDLib returns a known
result. The upload shows bytes received by BB and an indeterminate wait for
Telegram. Cancellation remains available until dispatch to TDLib. Chromium
at 1422 and 390 px exercised progress, cancellation, retry and replacement.
Chromium added, edited and confirmed deletion of a synthetic greeting in
group details at 1422 px via the details button and at 390 px via Alt+Shift+I.
At both widths it applied bold using Ctrl+B and preserved the formatted range
when editing and saving again. Chromium also prepared a synthetic PNG as a
JPEG, rendered the preview and saved a caption edit without uploading it
again. Structured greetings use the rich-message renderer and editor for
supported text blocks. Creation checks Telegram's current account and block
limits. Edits preserve the original layout direction and require the
reviewed revision. Greetings with unsupported or incomplete blocks are
read-only. Chromium at 1422 and 390 px created a heading and list, reopened
the draft and saved a heading edit. Existing embedded photos, documents,
videos and supported audio use private media paths bound to the chat,
message, revision, block index and file ID. Chromium verified spoiler reveal,
photo rendering, document download initiation and WebM decoding at both
widths. New structured greetings can embed photos, H.264 video and documents
in the order selected in the editor. The shared upload route stages the
files and rechecks the administrator's permission before saving. Chromium
submitted a heading, photo and document in order at both widths. Editing can
update text and move or remove supported existing media blocks while keeping
their file IDs, captions, credits and spoiler flags. BB rejects unknown or
duplicate original block references and disables editing when the native
input cannot preserve properties such as a photo link or video autoplay.
Chromium edited text, moved a document and reopened the retained photo at
both widths. Existing structured greetings can also receive new media or
replace an eligible photo, video or document in one update. The stream sends
only new bytes and keeps the original file references, captions and spoiler
settings where applicable. BB checks the reviewed revision before staging
and again before dispatch. Chromium replaced a photo and added a document
at both widths. Supported embedded captions can be edited or cleared with
formatting and links, including during file replacement. The adapter retains
the media reference, credit and spoiler flags and rejects caption edits with
unsupported entities. Chromium verified
formatted caption edits during photo replacement at both widths. Signed-in
verification remains open. The
[TDLib allowlist](https://github.com/tdlib/td/blob/master/td/telegram/MessageContentType.cpp#L369-L384)
enumerates the accepted content types.

Sent formatted messages can reorder or remove supported embedded media and
edit existing captions without re-uploading the files. The edit revision
includes the retained file IDs and block metadata. The server refuses
changed or duplicate references. Installed Chromium edited and moved a
synthetic photo and kept the document, both file IDs, credit and spoiler
flag in one edit with zero upload requests. Sent formatted messages also
accept new photos, videos and documents and eligible replacements through
the streamed upload route. The adapter rechecks the original revision and
edit permission after staging. Installed Chromium replaced one document,
added another and kept the original photo reference in a single edit with
no new message sent. The transport test exercises a concurrent revision
change before dispatch and checks that only the two new file bodies are
staged.

Dotted folder navigation now reveals the ancestor path when the selected
folder changes, including a move to another child under a manually collapsed
branch. The user can still collapse the selected branch until the selection
changes again.
A selected folder also reveals its ancestor path after a rename moves it.
A collapsed branch indicates how many descendant folders have unread chats.
Its parent folder retains its own unread count. The folder settings selector
and the name editor show the full sidebar path. Chromium in isolated BB
verified the collapse indicator, folder paths and keyboard navigation through
three levels. A regression fixture covers a rename under the same parent.
Chromium in isolated BB received two dotted folders through TDLib. Arrow
keys collapsed and expanded the hierarchy, and Enter opened each folder
with its distinct chat list. In the signed-in main BB, Chromium verified
keyboard selection of an existing folder and its corresponding heading.
The account had only flat folders at the time of the check.

If Telegram orders a custom folder before All Chats, BB opens that first
folder on startup. It waits for TDLib to publish the folder order and
respects navigation that happens during the wait. A resumed conversation
keeps its folder while the order is loading. Isolated Chromium received an
initial empty layout followed by the folder order, opened the first
folder, and kept a manual switch to All Chats through the next refresh.
[Telegram folder defaults](https://telegram.org/tour/chat-folders?setln=en).

The signed-in profile's TDLib 1.8.70 binary recognized the list, detail
and eligible-chat methods in an isolated client. Account verification
requires the updated plugin and a community or eligible chat.
The default Homebrew TDLib is 1.8.0. An isolated, unauthenticated JSON
client using that binary reported both `getUserProfileAudios` and
`isProfileAudio` as unknown methods. Profile music needs a newer TDLib.
The signed-in BB profile reports TDLib 1.8.70. Its loaded plugin build
does not register the `profileAudio` RPC. An isolated client opened the
same TDLib binary without a session, recognized both methods and closed
normally. The default BB profile did not report Makosh Telegram installed.

The chat and forum topic media pickers send local MP3 and M4A files
as Telegram audio tracks and local GIFs as animations. BB streams the
original file through the existing upload route, probes it with FFprobe
and checks the distinct audio or animation posting permission. Both support
formatted captions and silent or scheduled delivery. Local GIFs also
support captions above the media and spoilers. Regular chats and forum topics
also accept two to ten MP3 and M4A tracks in an audio-only album, including
drag and drop, reordering and exchanging the draft. The album uses one
TDLib dispatch after every track passes FFprobe. Shared and individual
captions follow the same rules as other albums. Received tracks are
stacked vertically with title and artist when available. An audio album
has its own playback queue. Pausing keeps the current track, and finishing
advances to the next available track in that album. Previous and Next use
the same order in BB and the host's media controls. Media Session shows
Telegram's track title and artist when the host supports metadata.
The music player stays mounted across chat and topic changes in the Telegram
pane. It can reopen the source message and retains the album queue while
another conversation is visible.
Installed Chromium in an isolated BB streamed two synthetic MP3 files,
skipped a protected track, stopped at the end of the selected album and
restarted the first track using Previous. Browser Media Session metadata
matched the active track.
The player can shuffle the selected album from the current track and repeat
the current track or the selected album. Changing a mode preserves the
active audio element. Installed Chromium with synthetic TDLib streamed
three available tracks in shuffled order, looped a track at its natural
end, and wrapped the album to its first track. It also verified the active
track's Media Session title and the panel at a width of 500 CSS pixels.
[Telegram Desktop changelog](https://github.com/telegramdesktop/tdesktop/blob/dev/changelog.txt).

Shared audio also starts a persistent queue from the conversation or
topic's audio search results. It requests an older page at the queue
edge and retains the original scope and filters after navigation.
Installed Chromium in an isolated BB continued streaming three tracks from
the source chat after navigation. It retried one synthetic TDLib search
error, skipped a duplicate and a protected result, and stopped after the
last available track.
Interface tests check that closing the player discards a late page.
The player exposes its ordered queue, marks the active track, and supports
choosing a track directly. The shared-audio queue also loads older search
results on request without starting an audio transfer. An isolated
Chromium run opened and closed the queue with the keyboard, retried a
failed lookup, played an older track after leaving the source chat, and
checked the layout at 440 CSS pixels. The interface test verifies that
natural playback can continue through an already pending page request.
[Telegram Desktop playlist source](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/media/player/media_player_instance.cpp).

GIF search results with a TDLib animation file support formatted captions,
caption placement and spoilers before sending. Unedited selections use the
original inline result. The edited path binds the file to a single-use token
for the specific chat and topic. Selections without an accessible animation
file keep the direct inline action.

Instant View music shows the title, performer and cover from TDLib for
standalone audio blocks and gallery items. When a sender cover is unavailable,
BB accepts the first supported TDLib-provided alternative. The article's
existing photo route verifies the selected cover belongs to the current
article. Starting playback supplies the title and performer to Media Session.
Chromium at 440 CSS pixels in an installed isolated BB decoded both covers
as each slide opened, requested no audio before opening the player, played
the second track, and read the correct metadata from Media Session.


Web articles in Instant View preserve the displayed labels and nested
formatting of bank-card, TON-address and bot-command entities. These
recognized entities do not mark the article partial. The web article
path in Telegram Desktop opens without a session-window or message
target. Its bank-card and TON handlers require a session window. Its
bot-command handler requires a conversation target. The separate rich
message viewer supplies a session window and exact message ID. The
bank-card menu can copy the number and resolve issuer links. TON opens
Telegram's wallet transfer screen for the supplied address. A bot command
uses the source conversation. BB exposes supported commands as actions in
rich message history. The action re-reads the source before dispatch and
routes to its current chat and supported forum topic or message thread.
For an unqualified command issued by an identifiable bot in a group, BB
adds the current bot username. Fixtures verify refusal after a command or
topic change, forum routing and bot username qualification. Chromium in an
installed isolated BB sent one command from a direct chat even with a
double click, and sent zero when revealing the spoiler. Channel inbox
commands use the selected channel, inbox and topic. BB checks management
rights and re-reads the source command in the exact topic before sending.
Fixtures verify refusal when rights, the channel backlink, the source
message, topic or command fail validation. Chromium in an installed
isolated BB verified one exact dispatch on a double click and preserved
the unsent inbox draft. Selecting a bank-card entity in a formatted
message opens copy and issuer actions. BB verifies the current message
and its sharing restrictions before returning the number or requesting
issuer information. Copy works while the Telegram lookup is pending.
Fixtures cover the stale and protected cases. Chromium in an isolated
installed BB confirmed one issuer lookup, one copy into a fixture
clipboard, HTTPS links and focus restoration on Escape. In formatted
messages BB validates TON raw and friendly addresses and links them to
the system Telegram client’s wallet transfer screen. Friendly addresses
keep their bounce and network flags and must pass checksum validation.
The handoff includes only the recipient. Wallet sign-in, amount and
confirmation belong to the system client. Chromium in an isolated BB
verified the exact link after spoiler reveal and intercepted the click
before the operating system opened Telegram. Signed-in wallet acceptance
remains open.
Chromium in an installed isolated BB verified all three labels, nested
formatting and the absence of a partial-content notice.
[Desktop web article and rich message viewers](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/iv/iv_instance.cpp).
[Desktop card handler](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/core/bank_card_click_handler.cpp).
[Desktop bot command routing](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/chat_helpers/bot_command.cpp).
[Desktop command and TON handlers](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/core/click_handler_types.cpp).
[Desktop wallet entry point](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/wallet/wallet_panel.cpp#L176-L185).
[Desktop send link handler](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/core/local_url_handlers.cpp#L1759-L1779).
[TON address formats](https://docs.ton.org/foundations/addresses/formats).
[TDLib rich text schema](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl).


## Live verification pending on the main BB build

The signed-in main BB reported TDLib 1.8.70 with Premium inactive and exposed
the folder layout and cache retention RPCs. It did not register the latest
story stealth RPC. Read-only history checks returned 4 and 50 messages in
two Saved Messages pages, with an advancing cursor and zero duplicate IDs.
In Chromium, the installed build showed 50 initial rows in Saved Messages.
Scrolling in the middle made no history request. Near the top it made one
older-page request, added 50 unique rows and moved the anchor by 0.47 CSS pixels.
A repeat with cache measurement reported 65,466,368 bytes before and after.
A later Chromium run on the installed main BB opened 4 Saved Messages rows,
made 1 earlier-page request near the top, added 50 unique rows and measured
0.05 CSS pixels of anchor movement.
On the installed main BB, the forum list had four topics. A read-only RPC
check in one of them loaded 50 initial and 50 older rows, with an advancing
cursor and no duplicate IDs. It did not send read receipts.
The designated test direct chat had zero unread and AI access disabled.
The check did not mark messages read, send messages, or change permissions.

Agent tool discovery offers per-chat history and search without a read
confirmation, even when legacy reviewed-note settings are present. The
Agents panel points to Chat details for read access. Existing settings and
the reviewed-note handler remain available for older threads. Agent sending
keeps the BB confirmation flow.
An installed isolated BB verified the revised Agents panel and persisted
then revoked access from a synthetic chat's details. The approval and agent
tool fixtures separately cover confirmation, reads across senders, and
revocation.
History pagination accepts a cursor issued for the same BB thread, session,
chat, forum topic, date range, and grant generation. Search cursors also
expire on a grant generation change. Tests continue through an empty first
page and reject mismatched or revoked cursors before requesting history.
Agent tool discovery now offers message search inside one AI-enabled chat,
optionally limited to one forum topic and an inclusive UTC date range.
Search returns excerpts, dates and authors from all senders. The adapter
omits protected, ephemeral, scheduled and out-of-scope results and checks
chat protection again before returning excerpts. Topic-name search follows
TDLib's pages and omits hidden topics, draft text and previews.
A registered-tool fixture used synthetic TDLib pages with a first page of
unshareable hits and returned two authors from the requested topic on the
next page. Cursor tests reject a different chat, topic, query, date range,
BB thread, account session or permission generation. The fixture also
revoked access during search and received no excerpts.
Chat discovery, message search and date-range history now exclude scheduled
and ephemeral records consistently. Discovery checks protection again
before returning a match. The registered-tool fixture covers unpublished
records at the date boundary, a change in protection during search, and
published messages from both sides of a conversation. It confirms that
reading requires no form and a disabled chat is never queried. The tool
also withholds its result if the session leaves the ready state during the
final permission check.
The registered read tools recheck Telegram content protection after grant
and reply metadata lookups. They publish data and issue continuation cursors
or reply tokens only after that check. A regression fixture enables chat
protection during reply metadata resolution and gets no page or continuation.
An offline run through the registered history tool returned two local speech
transcripts from the requested topic, withheld one protected record and
excluded the other topic. Repeating the read used the cached transcripts.
The run sent no messages and issued no read receipts.
Installed Chromium also verified the per-chat permission switch on the
new build in an isolated BB. The registered-tool checks used synthetic
data. Search with a signed-in Telegram account remains unverified.
The main BB permission preflight resolved the three approved verification
scopes. The forum grant was enabled and both the saved and direct chat
grants were disabled. The check did not change grants or request messages.
Agent send approvals support an exact group forum topic and an exact topic
in a private bot chat. BB shows the topic name and ID, verifies that the
chat still supports topics and that the selected topic is open, and checks
the reviewed reply during dispatch. The approval form fixture
shows the originating account and topic and checks an account switch.
Synthetic TDLib tests cancel and approve sends, then change the forum
mode, rename or close the topic, or edit the parent between approval and
dispatch. Only the unchanged, approved destination receives a send.
Chromium with the production approval component displayed the bot
topic name and ID, accepted one decision via Space, and disabled confirm
after expiry. That browser fixture did not send any Telegram messages.

Received rich messages render supported link and copy buttons in rows and
inline. URL buttons show the destination on hover and keyboard focus, and
external URLs from rich messages require review before opening. Copy actions
run on activation. Unsupported button actions cannot run. Chromium in an
isolated BB verified the URL on keyboard focus, cancellation and activation,
and the exact text passed to the clipboard interface.

The formatted-message editor can create a row of link and copy buttons with
alignment and per-button styles, and reopen supported rows in sent messages.
BB checks the message revision before editing and refuses to recreate a row
when doing so would discard an unsupported action or label content. Tests
verify the TDLib input for both actions, with alignment and style. Chromium
in an isolated BB sent a synthetic two-button row and edited the copy text
in the same message while preserving the URL button. Row labels support
pasted formatting and keyboard formatting on selected text. Chromium in an
isolated BB verified a bold substring in the editor preview, delivered button
and reopened editor. Editing the adjacent copy action preserved the formatted
label in the outgoing TDLib request. Nested label links are outside the
editable label format.

In a formatted paragraph, the editor converts selected text into a link or
copy button. Its controls can update the action, label and style or convert
the button back to text. BB stores its exact UTF-16 range and shifts it when
surrounding text is edited. Tests cover editing the label, offset shifts,
rejection of overlapping URLs and round-trip TDLib serialization. Chromium
in an isolated BB sent a paragraph with an inline copy button and edited
its copy text in the same message, preserving the surrounding words.

Typing a slash in an empty formatted paragraph opens a searchable block
picker. It offers the same available block types as the editor, respects
media and table limits, and supports pointer and keyboard selection.
Escape dismisses the picker while retaining the literal text.
Chromium in an isolated BB verified arrow navigation, Enter, Escape,
pointer selection and focus in the resulting editor.
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

Message selection downloads shareable formatted text as a local HTML file
using the same verified content and spoiler handling as Copy selected text.
The formatted composer can import local HTML as editable text blocks. It
supports headings, paragraphs, links, quotes, lists, tables, dividers and
code. The file is parsed in an inert template, and BB only inserts validated
draft data. Chromium in an isolated BB downloaded the selected message and
reimported the same file, retaining its heading, bold text and masked
spoiler. BB HTML downloads can also restore validated link and copy
buttons in rows and paragraphs, formulas and code language labels.
The HTML file stores buttons as inert metadata and the clipboard action
keeps the presentation-only HTML. Chromium in an isolated BB restored a
button row, an inline button and formulas from the same downloaded file.
Tests cover invalid action URLs and masking button metadata inside a spoiler.
Selected formatted messages with attachments can be saved as a TAR archive
with portable HTML and original files. The archive verifies the exact
message and embedded file reference and omits spoiler media. The local HTTP
test extracted the exact file bytes and checked the HTML links. Chromium in
an isolated BB downloaded the archive and verified the relative link, caption
and original bytes. The formatted editor accepts that TAR and restores its
local files and captions in draft order. Import reads archive headers and
uses file slices for attachments. It rejects invalid checksums, non-regular
entries and unsafe paths. Chromium in isolated BB imported the downloaded
archive, verified the restored document and caption before sending, and
confirmed the original bytes reached the synthetic TDLib upload. Cross-client
and signed-in verification remain open.
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

**Message channel** in channel details opens the subscriber’s channel
direct conversation. BB checks the link in both directions and uses the
ordinary paginated history. The composer checks TDLib’s permissions and
requires a zero message price again before dispatch. **Open channel inbox**
lets administrators browse the incoming topics and read one conversation
at a time. BB verifies the inbox association and filters history by the
exact topic. Administrators with the channel’s direct-message permission
can send text in the selected topic and reply to a specific message.
Drafts survive a failed or unconfirmed send, switching conversations and
closing and reopening Chat details within the same BB session. Long text can
send as a UTF-8 document or as a series of Telegram messages from a regular
chat, forum topic or channel inbox. BB keeps only the unconfirmed portion
of a split draft and asks the user to check the conversation before retrying
an uncertain part. The installed isolated BB verified a file byte for byte
after a declined first attempt, then sent a second draft as three text
messages to the same inbox topic. UI fixtures exercise partial confirmation
in all three composers.
BB can quote a selected passage from a message
or caption in that topic. The adapter verifies the source message and
offsets at dispatch and preserves the applicable Telegram formatting.
Chromium in an isolated BB verified the exact quote on a text reply, a
file and an album, retention after a refused send, and the delivered quote
in the history. A delivered reply opens the original inside the same inbox
topic, highlights the verified excerpt, and restores the draft, scroll
position and focus on return. The adapter recovers the original from an
exact lookup when the nearby page omits it. The installed fixture also
returned an unrelated topic row and BB excluded it from the context.
The same quote jump works in inbox search results. Installed Chromium
opened the original in the selected topic, highlighted the excerpt and
restored focus to the quote in the existing results on Escape.
The composer supports styled text and links in replies, single-file
captions and shared album captions. BB previews the formatting and
adjusts entity offsets when trimming whitespace. Chromium in an isolated
BB verified a formatted reply, a styled file caption, and a linked album
caption with their exact reply targets. A refused reply kept its
formatting for retry.
The same composer sends documents, photos, streaming video, audio and GIFs
with an optional caption and reply target. Recognized media can also be sent
as a document. Chromium in an isolated BB verified one synthetic dispatch of
each type to the selected topic, with the exact reply target and caption in
history. An interface test covers a chat details refresh during the upload.
The inbox also sends photo and video albums, audio albums and document
albums of two to ten items. BB checks all returned members before showing
delivery and renders the shared caption once. Chromium in an isolated BB
verified mixed photo and video, photo-only, audio and document albums with
the exact reply target. Adapter tests cover revoked rights, a mismatched
topic and partial delivery.
The inbox voice editor can record from the microphone, import a file,
preview and trim it, and send it as a reply. Chromium in an isolated BB
verified recording from a virtual microphone and one dispatch after explicit
send. A second isolated run imported synthetic speech and matched its
transcript from the offline local model. An interface test checks that
closing the recorder releases the microphone without sending.
The inbox video editor records from the camera with sound and can import
WebM or MP4. The existing normalizer produces a 384-pixel square video
note. Chromium in an isolated BB verified a circular preview, release of
both capture tracks on discard, and one dispatch each for a recorded and
an imported clip with the reviewed reply target. A regression test checks
encoding when the media type includes both video and audio codecs.
The inbox picker loads recent and favorite stickers, sticker search,
installed packs and saved GIFs. Sending rechecks the selected source and
the target conversation. The inbox also exposes the existing favorite
sticker and saved GIF controls in history. Chromium in an isolated BB
verified four synthetic sends across recent stickers, sticker search,
installed packs and saved GIFs. The GIF preserved its caption, spoiler
and placement. Each send preserved the text draft and exact reply target.
The browser test also removed and saved a synthetic GIF from history.
The inbox supports message reactions in history and search. BB checks the
exact inbox topic, message and administrator access before changing a
reaction. Chromium in an isolated BB verified adding and removing a reaction,
a live count update, and opening the filtered list with Shift+F10. The
reactor's avatar, reaction time and profile resolved through the scoped actions.
Adapter tests cover revoked rights, a different topic, and participant
details Telegram no longer exposes.
The inbox can forward individual messages from history or search and
complete albums from history. The destination picker supports forum topics
and the existing delivery and attribution options. BB checks the exact inbox
topic and current administrator rights before dispatch. Album membership
comes from TDLib's history for that topic. Tests cover protected content,
foreign topics, changed rights, copy permissions and ordered album delivery.
Chromium in an isolated BB verified zero sends when closing the recipient
picker and one confirmed forward each from history and search, with the
exact source message and recipient. Signed-in inbox forwarding remains to
be verified.
History and search also support forwarding a selection of two to 100
messages from one inbox topic. BB verifies each selected message and sends
them together in chronological order. Chromium in an isolated BB selected
two messages in reverse order, verified zero sends on cancel, and checked
one ordered dispatch each from history and search. Adapter tests exercise
duplicate IDs, messages from another topic, revoked rights, protected
content and partial delivery.
Inbox history and search also copy selected text and captions in message
order using the existing clipboard controls. BB checks each message's
topic and current permissions and masks spoilers. An isolated Chromium
run verified clipboard contents from both views and confirmed that a
protected selection left the clipboard intact. The adapter fixture
checks revoked rights and a message from another topic.
Inbox history and search support deleting a selection for everyone after
review. BB rechecks the inbox association, administrator rights, and each
message's topic and deletion permission before a single TDLib request.
Two isolated BB runs confirmed zero requests on cancellation and one
request for two selected messages in each view. An unselected message
remained visible. Adapter tests cover a different topic, changed rights,
concurrent deletion and a missing acknowledgement.
Inbox history and search can save selected attachments together in a TAR.
The download ticket binds the selected IDs to one inbox topic. BB checks
the current permission and file reference before opening the downloaded
bytes. Chromium in an isolated BB downloaded a history archive containing
two original files and a search archive containing one original file and
one unavailable entry for a protected attachment. Tests verify that the
archive excludes messages from another topic and withholds bytes if
protection changes during download.
The inbox can review and confirm a permanent channel ban or lift the
current ban. BB resolves the sender from the selected inbox topic,
rechecks the linked channel, moderation rights and reviewed membership,
and verifies the resulting status in Telegram.
The inbox list can mark a single conversation read or unread. A read
request uses the latest verified message from that topic. BB then
re-reads the topic’s unread count and manual unread mark.

The empty chat search shows recently found chats on focus. Selecting a
search result records the chat with TDLib. The list supports removing one
entry and clearing after confirmation. BB uses the current offline method
and falls back to the documented empty search on older TDLib.
The same view shows frequent personal chats in Telegram’s ranking via
`getTopChats`. The frequent and recent lists load independently.

Right-clicking an eligible outgoing group message opens the read receipt
dialog. The same action is available via **Who viewed this message** in
history, forum topics and search. The dialog shows avatars and supplied
read times outside the history layout. Text selection and controls inside
the message keep their own context menu.
Selecting a reader opens their profile after a fresh check of the exact
sent message and its viewer list. Closing the dialog cancels navigation.

**Who reacted** opens a dialog with the reaction counts and a paginated
participant list. A reaction chip's context menu key or right-click
opens the same dialog filtered to that chip. Closing returns focus to
the control that opened it. The adapter still checks that Telegram
exposes participant identities for that message before requesting them.
Rows show the sender’s avatar and the reported reaction time. Avatar files
load as rows become visible and use the existing avatar checks for user and
chat senders. A sender with several reactions is looked up once per page.
Participant names open the corresponding profile or chat details. BB
rechecks the original message, filter and pagination cursor before
resolving the sender, and cancels navigation when the dialog closes or the
user switches filters during the lookup.

**Manage sticker packs → My packs** can rename packs owned by the current
account and reorder the stickers within them, including uninstalled packs.
BB checks the current title or order before making the change and re-reads
the pack to confirm the result. An installed BB Chromium fixture moved one
sticker, renamed the same pack, and verified both changes after reopening
the library. The fixture recorded no message sends.
The same screen can remove an individual sticker after a confirmation
showing its position, label and pack. The adapter checks ownership and
compares the reviewed pack title and sticker order before removing the
selected file. Installed Chromium verified that cancellation made no
request, confirmation removed exactly one sticker, and reopening the
pack kept the remaining sticker available.
Owners can also permanently delete an entire pack. The review identifies
its Telegram name, title and sticker count. BB fetches the pack from
Telegram before deleting and confirms that a fresh lookup can no longer
find it. Installed Chromium cancelled once, then deleted only the reviewed
fixture pack. The other pack remained in the list, and the sticker picker
refreshed.
From a shareable regular sticker message, BB can add the existing sticker
to an eligible owned pack. It rechecks the message, the destination and
capacity before adding and verifies the updated pack. The installed
Chromium fixture cancelled once, added one sticker after explicit
selection, recognized the same remote file on a second attempt and showed
the added sticker in the pack editor. Transport tests cover a protected
source, changed source and destination, and ineligible packs.
The message sticker picker can create a regular pack when there are no
owned packs or when the user chooses a new pack. It checks the chosen
Telegram short name, re-verifies the source message, and confirms the
new owned pack with a fresh lookup. Installed Chromium verified
cancellation, a name collision, one successful creation, and the first
sticker opening in the pack editor. The transport fixture covers source
protection and Telegram taking the name between review and creation.
In an eligible owned pack, the editor can change the emoji associated
with an individual sticker. BB compares the loaded emoji against a fresh
pack before saving and verifies the result after the update. Installed
Chromium rejected text, cancelled without submitting, and reopened the
sticker with both a multi-code-point emoji and a flag. The transport test
also covers reordered emoji, presentation selectors and stale edits.
**New pack from image** creates a regular pack from a locally selected
PNG, WebP or JPEG. An installed Chromium fixture converted a transparent
160×80 PNG to a 512×256 WebP, checked that the preview retained
transparency, and confirmed that the opened pack contained the uploaded
sticker. The transport fixture rejects invalid dimensions and emoji and
checks staging cleanup after a confirmed creation.
The same image preparation is available when adding a sticker to an
existing owned regular pack. BB compares the reviewed pack with a fresh
lookup before uploading and verifies that its prior stickers are still
present afterward. Installed Chromium cancelled once, added one
transparent PNG as a WebP sticker, and reopened the pack with both the
original and new stickers. The transport test rejects a stale snapshot
before it can upload the same image again.
**Replace sticker from image** shows the original position and prefilled
emoji when available. BB uses a single Telegram replacement operation
and checks that the new sticker occupies the reviewed position with the
remaining order unchanged. Installed Chromium cancelled once, then
replaced the second sticker with a transparent image and verified the
position after reopening. The transport fixture also rejects stale
snapshots and detects an unexpected order after the replacement.
The same file picker accepts TGS animations for pack creation, addition
and replacement. BB validates the bounded animation before preview and
uses TDLib's sticker upload before passing the resulting file ID to the
pack operation. Installed Chromium rejected a malformed TGS, rendered a
valid fixture, verified upload before pack creation and found the new
pack in the library. The transport fixture checks the staged file and
returned file ID.
The file picker also accepts locally selected VP9 WebM stickers. FFprobe
checks the video stream, dimensions, duration, frame rate and absence of
audio before preview and before the original file is staged for Telegram.
Installed Chromium rejected a corrupt WebM, decoded a 512×256 preview
and created a pack with the original video. The transport fixture also
rejects WebM with audio, 60 fps, smaller dimensions and Matroska files.
The editor can set the cover of an owned custom emoji pack to one of its
entries or restore the default. It compares the reviewed cover with a
fresh lookup and verifies the resulting Telegram thumbnail file.
Installed Chromium set the second emoji as the cover, reopened the pack
and restored the default. The transport fixture checks stale covers,
foreign file IDs, regular packs and exact 64-bit custom emoji IDs.
The regular sticker pack editor can upload a local static cover or reset
it to the default. Installed Chromium letterboxed a transparent image
into a 100×100 WebP, cancelled once, saved one cover, decoded the saved
cover on reopening, and restored the default. The transport test covers
malformed images, stale covers, ownership and temporary-file cleanup.

Swipe-to-reply is available on eligible chat and forum history rows. An
installed BB Chromium fixture dispatched horizontal wheel and touch gestures
and observed the original message attached to the focused composer. Vertical
scroll input and momentum after activation did not open another reply. It
recorded no sends. A UI fixture covers the same gesture in a forum topic.

Double-clicking the free area of an eligible message uses the browser's
**Chat gestures** preference. The default prepares a reply. The other
choices apply the current Telegram quick reaction or disable the action.
BB reuses the existing reply and quick-reaction actions, preserving their
eligibility and availability checks. Installed Chromium verified word
selection, reply focus, one synthetic quick reaction, and the disabled
setting after reload. The forum UI test verified reply focus in the topic
composer. No message was sent.

The composer and history also support Ctrl+Up/Down to step through
eligible loaded reply targets in the chat or selected topic. Stepping
forward past the newest target clears the reply. Cmd+Up/Down works from
the history and from an empty composer. Tests cover preserving nonempty
drafts, skipping pending and retained rows, and ignoring IME composition
and held keys. Separate installed Chromium runs verified the chat and
forum topic actions and focus, with zero sends and no cross-topic fetch.

Telegram settings now include a searchable Keyboard shortcuts section for
navigation, composing, formatting and media controls. Pressing ? outside
text fields opens the same reference. Typing ? in a composer keeps it in
the draft, and Escape from the guide restores the previous focus.
Installed Chromium verified the shortcut, literal question mark, search
in Settings and focus restoration at 1422 px and 440 px.

The Telegram rail opens the download queue directly and shows unfinished or
recently completed counts. The installed BB fixture checked the initial badge,
opened the queue, and used TDLib callbacks to switch the fixture file through
downloading, paused and completed states. The rail and open queue updated,
and closing the dialog returned focus to its button. No messages were sent.
The rail also displays aggregate transfer bytes from TDLib. An installed BB
run verified that progress increased from 128 to 256 KiB of 512 KiB while
the queue was closed and hid when the only transfer was paused. The app
fixture covers stale events from a different connection, an older initial
snapshot, and an open queue that stays untouched by byte-only updates.
The queue also offers **Clear completed downloads**. An installed BB run
removed a completed fixture record and left the paused row and its badge
intact. The TDLib request was scoped to completed entries and left the cache
untouched. The UI regression covers a failed attempt and resetting pagination
after a successful retry.
Visible download rows can show a bounded Telegram thumbnail. Chromium in an
installed BB decoded one fixture JPEG and rendered a file icon for the entry
without a thumbnail. The fixture recorded one bounded preview request and no
original downloads. Tests cover stale file IDs, spoilers, and removal of a
displayed preview when the updated queue row no longer offers one.

Automatic media downloads are off by default. In an isolated BB, Chromium
saved a 1 MiB video limit for private chats through Settings. The installed
plugin issued two low-priority downloads of 512 KiB fixture videos. The second
started only after scrolling its message into view. The check recorded no sends.
Adapter tests cover cache cleanup coordination, oversized files, protected
content, spoilers and disabling the policy before a download. Limits are
independent for private chats, groups and channels. A later isolated BB
saved 1 MiB for private-chat videos and 3 MiB for channel videos in Settings.
Groups stayed at zero. The installed RPC returned all three limits and
Chromium verified the visible-video downloads in the private chat. The host
fixture also covers reading stored settings in the previous format.
Chat details support inheriting the chat-type policy, disabling automatic
downloads in that chat, or saving its own limits. A later isolated BB run
verified that a disabled exception blocked a visible video, a custom limit
enabled two visible downloads, and restoring inheritance removed the
exception. The account-switch fixture verifies that an override for the same
chat ID stays with the Telegram account that set it.
Automatic playback has separate limits for videos, GIFs and round video
messages in each chat type. An isolated BB run saved the private-chat video
limit through Settings and decoded a synthetic MP4 through the installed
streaming route. Chromium verified mute on entry, pause offscreen, and resume
on return. The later video made no request while it was offscreen. The UI
fixture verifies that a muted round-video preview leaves the note unplayed
until the user takes control. Chat details also support overriding playback
limits independently of automatic downloads. Installed BB runs exercised
muted video, a looping GIF, and a round video message. They verified that a disabled exception blocks
the stream, that a custom limit starts playback, that disabling pauses it,
and that restoring inheritance removes the exception. The account-switch
fixture verifies playback and download overrides stay separate and follow
the signed-in Telegram account. The installed round-video fixture recorded
one playback receipt after a pointer click on **Play with sound** and zero
receipts from the muted preview. Signed-in acceptance remains open.
[Telegram Desktop's auto-download policy](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_auto_download.cpp)
defines chat-type limits, peer overrides and separate autoplay rules.

In an isolated BB, Chromium key events opened chat details with Ctrl+Backslash
and opened and focused Contacts with Ctrl+J on a Cyrillic layout. The fixture
confirmed that the shortcuts do not take over the composer or an open details
dialog. It recorded one contacts request and zero sends.
From the unfiltered contact list, **Browse by letter** indexes known contacts
in bounded TDLib batches. The initial picker includes letters on later pages,
groups accented Latin names with their base letters, and preserves Cyrillic
initials. Name and username searches still use Telegram's contact search.
An isolated BB opened a contact past the first 30 entries using the index.
The main BB showed the index and returned results for a selected letter.
The same host fixture pattern exercised Ctrl+BracketRight with focus on a
different unread chat. The preview requested one latest history page without
switching the active conversation or issuing any read updates. Closing it
restored focus to the original row and preserved the unread badge.

Telegram settings search accepts English and Russian terms. Arrow keys
move between results, and Enter opens and focuses the selected section.
The recent list stores up to six section IDs in the browser and can be cleared.

QR codes for public usernames, temporary profile links and eligible invites
offer four high-contrast colors and a 768×768 PNG download. A supported
browser can receive the same PNG through its Clipboard API. In an isolated
BB, Chromium downloaded a recolored public profile code and passed the same
bytes to a fixture Clipboard API. macOS Vision decoded the expected public
profile link from the downloaded file.

The chat photo viewer supports touch pinch, trackpad pinch, panning a zoomed
photo with one finger, and touch swipe between loaded photos at fit size.
Chromium in an isolated BB used two touch points to zoom to 200%, then
swiped to a covered album photo without revealing it. UI tests also cover
wheel zoom, panning, diagonal movement and touch cancellation.
The chat photo viewer can recognize selectable text through macOS Vision.
The adapter verifies the current message, file and sharing permissions
before recognition and again before returning the result. An isolated BB
recognized English and Russian on a synthetic photo. Chromium verified
that copying required its own action and that an unrevealed spoiler offered
no recognition action. Adapter tests cover protected chats, protected
messages and disappearing photos.
Vision's line bounds highlight the recognized text on the displayed photo.
Clicking a highlight selects that line in the text field. BB verifies the
displayed image digest before recognizing it. An isolated BB checked the
line positions at fit size and 150% zoom, and selected the expected line.
In the signed-in main BB, Chromium opened an existing photo through Saved
Messages' shared media. Vision found four lines. Clicking a highlight
selected the matching text and focused the text field. The four highlights
remained visible at 150% zoom. Eight other photos returned no recognized
text. The check recorded no sends and exported no photo or text.

An exportable chat photo can be prepared for a file drag from the photo
viewer, including when opened from shared media. The drag uses a short-lived,
single-use download for the selected original file. BB rechecks the file ID
and export permissions before and after the transfer preparation. A covered
spoiler does not offer the drag control. An isolated Chromium run verified
the drag payload, zero downloads during preparation, delivery of the JPEG,
and rejection of a second request. A native Finder drop remains unverified.

For an ordinary streamable MP4, the **Video quality** selector offers exact
size H.264 alternatives supplied by TDLib. Each range request revalidates
the selected variant against the current message. The player keeps its
position, playback speed, volume and pause state on a switch. Chromium in
an isolated BB decoded a synthetic 640×360 stream and a 320×180 alternate,
kept a paused seek at seven seconds and resumed playing when switching back.
If the alternate stream fails before metadata loads, the original-quality
fallback restores the saved position, rate, volume and mute state. An audible
track started while the stream was unavailable takes playback priority.
The voice player also stays open when pausing interrupts a pending play.
Installed Chromium sought to seven seconds in the synthetic original,
encountered a corrupt alternate stream and restored the original with its
position, speed, volume and mute state. Playback resumed and the fixture
recorded no sends.
The quality selector stays available when the original or an alternate
stream fails. Selecting a different variant after failure uses a fresh
stream request and preserves the last known position and playback settings
even if the decoder has reset its clock. A timestamp deep link keeps its
requested position when the original stream cannot open. UI fixtures cover
both a late decode error and the original stream failing on open.
Chromium in an installed isolated BB switched from the alternate to the
original after an injected late error, recovered at eleven seconds with
the previous speed and volume, then switched back after an original
stream error.
Runs on the same isolated bundle also decoded a WebP sticker and selected
it from an installed pack, sent a test GIF with a formatted spoiler caption,
retried an ordered photo and video album with its caption, and transcribed a
synthetic voice note with the local model.
For visible automatic previews, BB selects a verified alternate within the
chat's configured byte limit. It prefers the least expensive variant that
covers the estimated inline display size, or the closest lower resolution
within the limit. Opening the player manually can still use the original.
In Chromium on an isolated BB, a fixture channel with a 1 MiB limit played
the 320×180 alternate muted, made zero requests for the oversized original,
and paused when scrolled out of view.
Acceptance on an actual Telegram video with alternate qualities remains open.
Playback history uses the original TDLib file ID alongside the chat and
message IDs. A caption edit keeps the same player and position for an
ordinary video; a replacement has its own position and starts from zero.
Original, alternate and buffered playback requests check the file shown in
history. Range tickets reject a changed file before reading bytes from it.
Installed Chromium kept the original player at seven seconds after a
synthetic caption update. After a replacement update, the old range URL
returned 409 and the new video decoded from the beginning.



Manually opened streaming videos offer a seek slider with a frame preview.
BB requests a frame from the current authorized stream after the pointer
settles and releases the preview stream when the gesture ends. Dragging
changes the preview time without moving the main player until release.
Keyboard changes seek directly. In the installed isolated BB, Chromium
decoded a red frame at the hovered timestamp while the primary player
stayed on a blue frame. The primary player showed the red frame after
the pointer released the slider.

In the signed-in main BB, Chromium sent a 30-second synthetic H.264 video
to Saved Messages. With a throttled browser connection, the initial blue
frame decoded while the video transfer was still incomplete. Seeking with
the visible slider requested a nonzero byte range with HTTP 206 and decoded
the expected red frame. Chromium removed the test message. This verifies
streaming and seeking with real Telegram storage and TDLib.

The Telegram player registers browser Media Session actions for audible media.
A Chromium fixture played two synthetic Opus notes and drove the registered
callbacks. Pause and resume affected the first note, Next played the second,
and Stop rewound it and released the actions. This fixture used Chromium's
Media Session API without issuing operating-system media key events.

The app omits absent optional properties from BB RPC input, including inside
session payloads. App tests cover both the scoped and legacy date-jump calls.
In an isolated BB, Chromium jumped from the chat timeline to a date in
synthetic history. TDLib received one date lookup and the reader focused the
target message. No send requests were made.

The signed-in main BB reported TDLib 1.8.70 and Premium inactive. Its loaded
plugin did not register `folderLayout` or report a cache retention period.
Read-only RPCs retrieved two 50-message pages each in Saved Messages and one
forum topic. Both cursors advanced with zero duplicate IDs. TDLib reported no
change in cache size. The run made no attachment or send requests.

The 1205-test candidate loaded in a temporary BB and exposed `folderLayout`.
With synthetic TDLib history, Chromium opened both a direct chat and Saved
Messages. Each requested one initial page and one older page only after
scrolling up. Each displayed 99 unique rows after excluding the overlapping
cursor message. The original row moved by less than one CSS pixel during the
prepend. A second temporary BB verified a 64 MiB cache limit, seven-day
retention and manual cache clearing while authorization stayed ready.

The 1148-test build installed in a fresh isolated BB profile with synthetic
TDLib. The installed RPC returned a structured welcome, rejected a stale
revision, saved an embedded caption edit and read it back with the same photo
and spoiler settings. The installed HTTP upload route staged one synthetic
document and saved a structured welcome. The fixture recorded two welcome
mutations and zero ordinary Telegram send calls.
The existing signed-in BB reported a ready Telegram session and returned
an unknown-method error for the welcome-list RPC. Signed-in welcome
acceptance therefore remains pending on the current build.

An earlier candidate installed in an isolated BB with synthetic TDLib.
Through the installed RPC, the eligible private chat received one shortcut
and the bot chat received none. The fixture rejected a stale shortcut ID,
saved one quiz, read back its two options and recorded zero send requests.
A separate read-only probe found one existing BB with a ready Telegram
session. Its loaded build returned cache size, omitted the retention field
and returned an unknown-method error for the new quick-reply poll RPC.
Signed-in acceptance of the candidate remains open.

Private bot chats with TDLib's `userTypeBot.has_topics` flag expose their
topic list, scoped history, read actions and topic links. Chromium opened a
synthetic bot topic directly and from its notification, then returned to the
containing topic. A TDLib fixture rejects normal private peers and bots
without topics. Bot topics can be renamed and pinned. Creation and deletion
require the bot's current permission. Chromium verified the permission-gated
controls and exact-name deletion confirmation on synthetic topics. Pinned
forum and bot topics can be moved after BB reads the full pinned order. An
adapter fixture covers multiple pages, and Chromium verifies that a
conflict refreshes the order and requires a new click. Signed-in acceptance
remains open.

Chats and topics that allow documents can attach a folder or file set as a
single ZIP. Chromium staged a dropped directory with an empty subfolder in
a direct chat, and a file set in a forum topic. It verified paths and exact
bytes with an independent unzip tool. Each archive entered the corresponding
document upload only after the user-facing Send action. Signed-in delivery
remains open.
Chromium also delayed a directory read and confirmed that Enter and form
submission leave the draft intact until it can accompany the ZIP. The
chat and topic fixtures verify that cancelling retains the draft.

Instant View shows the declared duration of playable video and audio.
Chromium decoded a synthetic inline WebP in the article after one
article-scoped load. Adapter fixtures verify that inline icons must be
referenced by the article and their bytes must match the declared format.
Fixtures cover the legacy and current TDLib footnote formats. In Chromium a
legacy footnote link opened its collapsed section and focused the text while
preserving the original italics.
Chromium verified alignment of tables with row spans, column spans and
invisible cells. **Copy table** writes their column positions to the clipboard
as tab-separated text. A fixture verifies spoiler masking inside copied cells.
**Copy selected text** in chat or topic history and search includes formatted
quotes, list markers, LaTeX and aligned table text. The server checks sharing
permissions and masks spoilers. Installed Chromium accessed one synthetic
formatted message through the selection toolbar and verified LaTeX and the
aligned table in one write to the test clipboard.
The same copy action writes HTML alongside plain text for supported rich
messages. HTML keeps block structure, supported inline styles and links,
and table spans. Both formats mask spoilers. Links overlapping a spoiler
are excluded from the HTML. Installed Chromium verified a single clipboard
write with both formats and preserved table spans, using synthetic content.
Mixed lists keep each item's alphabetic, Roman, decimal, bullet or explicit
marker in Instant View and formatted messages. Chromium checked the computed
markers and opened an article link to a nested checked item.
Chromium verified that two excerpts can load their full versions independently.
Returning to the first article restores its scroll position, expanded section
and link focus, and keeps the default state of a new section.
Voice notes retain their waveform and support the same seek control as
chat voice notes. Chromium played a synthetic Opus blob inside an article
slideshow and sought from the waveform. The live Telegram stream remains
unverified for this scenario.

Reopening a minimized Mini App from an equivalent HTTPS or native Telegram
link restores its existing frame. Chromium verified preserved script state
and the visible/hidden/visible lifecycle while moving between two chats.
Links with different launch parameters still open distinct windows.
The same bot profile, unchanged bot menu, and sidebar entry resume their
minimized windows. Chromium verified that returning through the bot menu
preserved frame state. Fixtures cover both the profile and sidebar entry
and confirm that a changed menu presents a fresh launch review.
With multiple minimized apps, a single disclosure opens their window list.
Chromium verified that the list fits a 390 px viewport and that both apps
retain independent state. A fixture covers Escape, duplicate names, and
closing one app without ending the other session.

Reloading a Mini App replaces its isolated frame and keeps its TDLib session.
Chromium verified a second handshake and discarded a delayed location status
from the previous frame. A fixture covers unsaved-change confirmation and
defers reload during a pending custom method request.

Exiting Mini App fullscreen during a pending browser entry cancels the entry
and reports the exit without a late fullscreen success. UI fixtures and a
sandboxed Chromium Mini App cover a simulated delayed browser transition.
Verification in the signed-in BB is open.

Fullscreen measures the app frame in the space left by the header, controls
and review panels. A sandboxed Chromium fixture verified native fullscreen,
resizing the frame for stacked buttons, and restoring the default header
after an empty header-color request.

Instant View collages and slideshows retain maps and their captions. UI
fixtures verify on-demand previews, and the adapter matches preview
requests against the maps in the article. Chromium confirmed that advancing
to the next slide makes no preview request, and clicking its preview button
requests that slide's map. Signed-in verification is open.

Chats and forum topics can stage 2–10 originals in a document album and
send them together. Chromium dropped a JPEG and a text file into a forum
topic, reordered them, and preserved the bytes up to the app upload call.
Adapter fixtures streamed two originals into a single TDLib album for both
the legacy and nested document constructors. Signed-in delivery is open.

In the signed-in main BB, Chromium sent two synthetic JPEGs with one shared
caption to Saved Messages. Both records appeared in the same album and the
viewer decoded the blue and red photos in the submitted order. The viewer
uses the chat's photo sequence for its position indicator. Chromium deleted
both test messages.

In the signed-in main BB, Chromium searched for stickers by emoji and sent
one result to Saved Messages. BB received a sticker message from Telegram,
rendered its media, and deleted the exact test message.

A signed-in BB check found that the old local GIF upload could return a
regular document from Telegram. The chat and forum upload now transcodes
local GIF and QuickTime MOV files to silent H.264 MP4 and submits them as
animations, keeping the caption and existing delivery options. The adapter
regression verified the codec, dimensions, and removal of the QuickTime
audio track. Isolated Chromium submitted a synthetic ProRes MOV with audio
and verified that replacing an invalid source preserved the caption.
The upload checks that the confirmed message is an animation. A document
in the immediate response or final send update leaves delivery unconfirmed
and keeps the draft available for review. Live verification of the
corrected build remains open.
A repeat on the installed main BB still returned a downloadable document
with no playback MIME type or animation player. Chromium deleted the
exact synthetic GIF test message.
On the current candidate in an installed isolated BB, Chromium selected a
local GIF, added a caption and sent it. The TDLib fixture accepted an
animation and BB displayed the confirmation. A probe of the transferred
file verified one H.264 video track, no audio and a two-second duration.
[Telegram GIF format](https://core.telegram.org/api/gifs).
The local GIF file draft also supports trim start and end, range playback
and retaining a formatted caption. WebCodecs provides the GIF frame preview,
and QuickTime uses the browser's video player. Both send paths validate the
range against the probed animation. The TDLib fixture checked GIF and MOV
duration, caption, topic and silent H.264 conversion. Chromium in an
isolated BB previewed an animated GIF and uploaded exactly one selected
0.7-second range with its caption. The GIF file picker also accepts MP4.
An ordinary attached MP4 or MOV can be switched to Send as GIF in a chat
or forum topic without replacing the file. The caption and delivery
settings remain in the draft. Switching back restores video options.
Isolated Chromium switched an MP4 with audio to GIF, trimmed it and
verified the caption and a 0.7-second H.264 output with no audio track.
GIF encoding tone-maps supported BT.2020 PQ and HLG inputs to BT.709 SDR
and checks the output tags before dispatch. Adapter fixtures verified both
transfers and rejected ambiguous HDR metadata. A separate Chromium fixture
sent an HDR source through Send as GIF and checked SDR tags, retained
luminance levels, caption, range and absence of audio.
Signed-in acceptance remains open.

When a draft exceeds the Telegram text limit, the chat and forum composers
offer to send its complete contents as a UTF-8 text document. The composer
fixtures cover both destinations, including replies and draft retention
after a rejected upload. In the signed-in main BB, Chromium sent a
synthetic Unicode draft as a document in Saved Messages, verified that
the download matched the original bytes, and removed the test message.
Signed-in acceptance of the forum-topic variant remains open.
[Telegram Desktop changelog](https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/changelog.txt).

Scheduled albums offer individual document downloads and one TAR for
eligible attachments. Chats and topics with file-only permissions expose
the scheduled list without text scheduling controls. Chromium verified the
archive flow through the production adapter and download route with two
synthetic files and excluded a protected attachment. Signed-in downloads
from scheduled albums remain unverified.

Instant View offers manual playback when TDLib reports an unknown media
size. BB checks the current file record and supports a bounded full download
for files up to 32 MiB when it still needs an exact size. Chromium played and sought a
synthetic WebM through the production TDLib adapter and HTTP range route.
The fixture observed no requests for video bytes before the click and one
preparation afterwards. The adapter tests cover larger files with a known
size, an oversized estimate, and an incomplete download.

Mini App chat requests can create a group, forum or channel. The adapter
rereads the prepared button before creating and checks the result with
TDLib before adding it to the selection. If a public username is required,
BB checks availability before creating the chat. A retry after an occupied
username assigns a new name to the same chat. Chromium exercised a private
forum from a sandboxed fixture and observed a sharing event only after
separate confirmation. The TDLib fixture verified that an occupied username
blocks creation and a conflict following creation is retried on the same
channel. Live Telegram verification remains open.
Chromium also exercised the public username retry with a sandboxed
Mini App and issued the sharing action only after separate confirmation.

Active devices shows sign-ins awaiting confirmation with their reported
time and location. Chromium checked that cancel sends no request and that
a changed session is reloaded for another review. TDLib fixtures verified
that the current session and a password-pending session cannot be confirmed,
and that confirming an eligible session preserves its exact int64 ID.
An in-app notice opens the Active devices section directly. Chromium checked
that message and sign-in notices stack without overlap and that the device
section receives focus. The app fixture confirmed a session after a simulated
realtime update and removed the sign-in notice after the next update.
A new device sign-in on the main account remains unverified.

Business bot settings can review and confirm a pending connection reported
for the current bot by TDLib. The review shows the request time, device,
location and current access. Chromium exercised cancel and confirm using
synthetic data. Request fixtures rejected changed permissions, a different
bot and a replacement request, and emitted one confirmation for concurrent
submissions. A real connection from another device remains unverified.

Telegram Business settings list owned chat links with their view counts and
prepared messages. Eligible accounts can create and edit them with formatted
drafts. Links can be copied and deleted after review. Chromium exercised
create, rename, and confirmed deletion using synthetic data. TDLib request
fixtures verified formatting preservation on rename, rejection of stale edits,
and subscription gating. Incoming links open the verified private chat from
message text or from chat search after a click. Chromium appended an incoming
draft, preserving formatting from both the link and the existing Telegram
draft, and issued no send or draft-sync calls. Unsupported draft entities
fall back to their text. Signed-in verification remains open.

Instant View retains named anchors at the end of a block sequence. Chromium
opened a collapsed section and moved focus and scroll to its final anchor,
then jumped to the end of the synthetic article in the same dialog.
Anchor lookup prefers an exact match and also accepts canonically equivalent
Unicode spellings. The section back action restores the source link, scroll,
open disclosures and the selected slide. Chromium in an isolated BB verified
the accent match, original scroll offset, focus and disclosure on return.

When a full article replaces its excerpt, Instant View restores the visible
text block by its content and keeps its offset relative to the toolbar. If
there is no unique matching block, the previous scroll offset is used.
Chromium verified the same paragraph stayed in place after 35 introductory
blocks were inserted.

The message selection toolbar queues multiple eligible attachments through
the existing download queue. Chromium selected three synthetic messages,
skipped the restricted file, and retried only the attachment whose first
request failed. A component test verified that switching chats stops the
batch after the already submitted request. Live queue behavior after a
partial failure remains to be verified.

Conversation and topic search combine text, message type or author with a
local-calendar date range. Chromium submitted a document search and loaded
its next page with the same topic and date range. The TDLib adapter fixture
looked up an anchor at the last second of the selected end date, searched
within the requested topic, and stopped after the start date. Live topic
search with dates remains to be verified.

Chromium used real keyboard events to submit one public-post search with
Enter, move through its result and pagination control with Arrow Down,
return focus with Escape, then open the correct message with Enter. The
test used synthetic search responses.

Global Messages, Media and Public posts can return from message context
to the same result. The sidebar keeps its loaded pages, query and filters.
Back to search results, Escape and the compact layout's back button restore
the original search row and the sidebar scroll position. Topic context also
offers a separate action to open the containing forum topic. Component
tests exercise all three search modes and the forum transition. The
message context RPC and TDLib adapter share the 21-message initial page
limit, so a full response reaches the viewer and can include an entire
album beside the selected message. Chromium in an installed isolated BB
verified a deep second-page media result and identical focus and scroll
position after returning in wide and compact plugin layouts. The fixture
recorded only the two original search calls. Signed-in acceptance remains
open.

Global Messages and Media search accept a local-calendar date interval and
keep it on later pages. Chromium in the Europe/Madrid time zone passed both
selected days spanning the autumn clock change as a 49-hour interval.
The adapter sends inclusive limits to TDLib and filters responses that fall
outside the requested interval. Signed-in search is still to be verified.
The same searches can restrict results to private chats, groups or channels
and to the main list or archive. Chromium kept the combined archive, group,
document and date filters on the next page. A TDLib fixture returned mixed
chat types and both lists, and the adapter kept only archived groups.

History export follows verified basic-group predecessors of supergroups.
The TDLib adapter checks the link in both directions, the migration boundary,
the chosen date range, and whether both chats can be exported. An integrated
fixture ran the production adapter and TAR HTTP handler. It exported one
current message and two legacy rows, withheld one protected row, and verified
both files byte-for-byte despite matching message IDs and filenames. Live
export from a migrated Telegram group remains open.

An isolated BB with a synthetic TDLib media file displayed 96 MiB in
Telegram settings. Saving a 64 MiB limit and seven-day retention issued
`optimizeStorage` with a 60-second immunity delay, and the fixture reported
16 MiB. After the fixture grew again, the BB cache timer reapplied the policy.
Clear cache issued a zero-size media cleanup and the fixture removed its
file. The same connection then opened the expected 50-message history.
This verified the settings, RPC and timer together. Real TDLib disk
reclamation and expiry of real media remain open.

Profile music and Instant View galleries accept FLAC with an exact size.
Chromium played the same synthetic FLAC from both panels through their
production range routes with a fixture file source. Together, the two
playback starts transferred 2,097,152 of 57,917,374 bytes. Account export
keeps the FLAC bytes and records the `.flac` filename in its music index.

Retry playback covers ordinary attachments that load a whole file as well as
streamed attachments. Chromium played a synthetic Opus note after a first
HTTP 503 and preserved its caption without loading the adjacent note. Stream
fixtures restore the last position after a native playback error, including
when the file was initially opened from a timestamp.

An offline test invoked the production agent history tool and forum adapter
with synthetic TDLib messages and the Mac's real MLX Whisper model. Before
granting access, the tool returned an access error and requested no files.
After granting access, one synthetic voice note and one video note returned
local transcripts with the expected spoken words. The protected row was
withheld, and the other topic's row was excluded. A repeat read reused the
transcripts without new downloads. No message was sent or marked played.
The same flow remains to be checked through the signed-in BB interface.

The 1057-test build was installed in a temporary BB profile using synthetic
TDLib history. Chromium at 1422 × 800 opened a private chat and Saved Messages.
Each opened with 50 messages and exactly one initial history request. Scrolling
up issued one request with cursor 151 and limit 50. The combined history
contained 99 unique messages after excluding the overlapping cursor. The
previous oldest message moved by 0.3125 CSS pixels relative to the top of
the reading pane in each view.

The same build passed the forum check in a fresh temporary BB. The topic
list did not request topic history. Opening either of two synthetic topics
made one 50-message request scoped to that topic. Moving within the page
at 400 px from the top issued no request. Reaching 8 px from the top requested
one earlier page in that topic. Both views contained 99 unique messages, and
the old first row moved by 0.421875 CSS pixels. Escape from the focused
history returned to the topic list. These runs cover the installed BB
package. The same flows remain to be verified against signed-in Telegram.

A delayed thumbnail test in a fresh BB profile used synthetic TDLib
history with a 320 × 240 photo and a 1 GiB document. Chromium made no file
requests before scrolling to the attachments. Once the placeholder entered
the viewport, BB requested the small photo only. After the delayed JPEG
decoded, the caption remained visible and the photo's frame, neighboring
row position, and history scroll offset were unchanged. There was no
document download or additional history request during this test.

Supported audio attachments with an exact size stream on request in chat
history, including FLAC and audio embedded in rich messages. The ordinary
message player in Chromium opened a synthetic 57,917,374-byte FLAC through
the production range handler and reached 04:05 after receiving 1,851,326
bytes. Browsing made no audio request. Adapter fixtures also reject playback
tickets for protected audio and audio without an exact size. Live transfer
with TDLib in the main BB remains open.

Playable audio tracks in one rich message form a playlist in block order.
Chromium played two synthetic Opus tracks and verified that only natural
completion starts the next track, the last track does not cross into another
message, and the previous-track control returns to the first. Unavailable
tracks are omitted. Verification with real rich messages in BB is open.

Instant View can share the currently open article through the same chat and
topic draft flow as a Telegram share link. Chromium opened a linked article,
returned focus to chat selection, and preserved the page's query and fragment
when inserting its URL in the selected chat's draft. No send was called.

In-app message notices dismiss when TDLib removes the matching notification.
Adapter fixtures verify that removals from other notification groups are
ignored and that removal is published before any replacement from the same
update. A BB SDK app fixture received notices via the realtime channel and
verified that removing an earlier notice leaves its replacement visible.
Reading a message on another signed-in device remains to be verified live.

The Mini App QR scanner falls back to local frame decoding when
`BarcodeDetector` is missing or fails. Chromium used a synthetic camera
stream with the native API disabled. The isolated app received one decoded
text event while the code remained in view, and closing the scanner stopped
the video track. The scanner also accepts a selected PNG, JPEG or WebP through
the host file picker. Chromium selected a blank PNG and then a QR image. Only
the QR text reached the isolated frame, with zero camera requests on that
path. A UI test verifies file validation and disposal when the scanner closes
during decoding. Verification with a physical camera in the signed-in BB
remains open.

Group history, forum topics and conversation search share the open viewer-list
state. Opening another list closes the previous one, including while TDLib is
responding. Chromium exercised the production conversation UI with a synthetic
group and kept one control per message and one open panel through three
history refreshes. A late response did not reopen a closed panel.

Instant View supports article zoom from 80% to 200% through its toolbar or
keyboard shortcuts. Chromium verified reflow at 175% on a 420-pixel-wide
viewport, with the same relative point in the visible text block and no
horizontal scrolling. Cmd+0 restored 100%.
Instant View opened from a conversation uses the panel's article dialog.
The article stack, zoom and scroll remain in the dialog when the original
message preview unmounts. When BB remounts the whole panel during resize,
the open article stack stays in memory briefly and is restored only for the
same connection and tab. The regression fixture covers the article stack,
scroll, zoom, connection isolation, and explicit close. In isolated BB,
Chromium crossed from 480 to 1360 pixels and back with the article open at
125%. The main BB build remains to be verified.
Article photos use their larger variant's layout width, bounded by the
article column. BB starts with the preview and fetches the larger variant
only if the visible photo outgrows the preview at the current scale and
pixel density. The photo viewer reuses the loaded variant. The fixture
covers viewport resizing, offscreen photos and concealed spoilers.

Ordinary chat history displays bounded static video and animation thumbnails
when the message becomes visible. BB reserves the thumbnail dimensions to
keep the history position stable. Browsing does not open the player or fetch
the full media. The thumbnail route rechecks message and chat protection.
Chromium decoded synthetic thumbnails on scroll, measured the same preview
size before and after decoding, and first requested the video stream after
the player control was clicked.
Video notes use circular thumbnails in the conversation and expose an eligible
preview in the global voice and video message filter. The player shows a
duration supplied by TDLib before opening playback. Chromium confirmed the
circular preview and both short and hour-long duration labels on synthetic media.
Playable voice and video notes render a seekable waveform when TDLib supplies
one. The player keeps the native audio controls for voice notes. Chromium
verified keyboard and pointer seeking and played bars on a synthetic Opus note.
Outgoing voice notes compute a waveform locally when FFmpeg is available,
including for quick-reply voice uploads. Tests send synthetic Ogg, WebM and
MP4 fixtures through the adapter and check the waveform submitted to TDLib.
The note player shows the TDLib listened/viewed state. For an incoming
ordinary note, the first playback sends the content-opened receipt. Loading,
seeking and local transcription do not send a playback receipt. Chromium
recorded one receipt on actual playback of a synthetic Opus note and none on
preload or replay.
When a voice or video note finishes, the player can continue to the next
eligible note in the loaded history of the active chat or forum topic.
With its standard autoplay policy, Chromium started the second synthetic
Opus note after natural completion of the first and skipped an intervening
text message. Pausing the first note beyond its running time left the second
unloaded. Resuming the first confirmed that continuation still worked.

Recorded or imported voice drafts have a local waveform and editable
start and end times. The preview plays the selected interval. When sending
or scheduling, BB encodes that interval as mono Opus, verifies the result's
duration, and generates its Telegram waveform from the trimmed audio.
Adapter fixtures remove synthetic leading silence in Ogg, WebM and MP4
and reject ranges beyond the recording before dispatch.
Chromium in a temporary BB recorded from a synthetic microphone,
previewed a selected 900 ms clip, and submitted one voice note to the
TDLib fixture after an explicit send.

For a video with Telegram timestamp entities in its caption, select a timestamp
to open the player at that position. A concealed video's timestamps are
interactive after the video spoiler is revealed. The player lists the
available chapters. Alt+Left and Alt+Right jump between chapters while the
video has focus. Timestamps inside text spoilers are excluded. The same controls
work for a playable video in the message's link preview when TDLib assigns the
timestamps to that message. A timestamp that points to available media in the
original message opens that message and seeks to the selected position. This
uses the existing same-chat reply navigation and respects forum topic scope.
Chromium verified keyboard navigation, chapter selection, and jumps
from the caption, link preview and reply with a synthetic video over the
streaming route. The concealed video stayed unloaded until the user selected
a timestamp and revealed the spoiler.

A short Space press on the focused video toggles play and pause. Holding
Space during playback temporarily applies 2× playback, with the selected
speed restored on release, focus loss, or pause. Comma and period step
backward and forward on pause using the observed frame duration. Before
a frame cadence is available, the step uses a 30 FPS estimate. Videos
with varying frame durations use a recent median cadence.
Chromium verified the boost and its cleanup on a streamed fixture and
observed adjacent presented video frames in both directions at 25 and 60 FPS.

The player applies a linked position once per media load, including when the
browser first reports an unknown duration. Chromium streamed a synthetic MP4
through the BB range route, delayed the visible duration, and sought to the
linked position before downloading the whole file. A later duration change
did not rewind after a subsequent manual seek.

Message links inside a forum keep the exact message and playback timestamp
and offer navigation into the containing topic. TDLib fixtures verify the
topic belongs to the linked chat. UI fixtures open that topic even when it
is absent from the first topic list. Signed-in verification is open.

Returning from a forum topic focuses its row and restores its position
relative to the topic list viewport, including when rows above it grow.
The saved scroll position remains available as a fallback if the row disappears. Chromium exercised a row from the
second page of an 80-topic fixture and observed only the initial list and
explicit next-page requests. A newer live revision can refresh the list.

Scrolling to the actual end clears the saved reading position in chats and
topics. The end of a page with newer history still waiting does not clear
it. Chromium exercised switching away and reopening both a direct chat
and a forum topic after scrolling to the end.

Focused attachment players support Cmd/Ctrl+S when the original is
available to download. This uses the same download action as the button
in chat, rich-message and Instant View playback. Chromium verified the
shortcut on a synthetic streamed MP4 and suppressed concurrent attempts.
UI fixtures cover a concealed video, a failed download, and article audio.

Focused regular videos support J and L for ten-second jumps, K for playback
or pause, and 0 through 9 in fullscreen to seek to each tenth of the video.
Alt, Control or Command with Enter toggles native fullscreen when available.
The letter shortcuts also work on the Russian layout.
Chromium exercised these shortcuts on a synthetic MP4 served through the
streaming route. It sought to ten and twenty seconds using key events,
opened fullscreen, jumped to 70%, and returned to the beginning.

The photo viewer supports Command+S on macOS and Control+S, including
Russian keyboard layout. It saves the displayed album item through the
existing save action. Concealed spoilers, protected photos, and repeated
key presses do not issue a save.
Chromium confirmed with synthetic media that focus stays in the viewer
when selecting the last album item and revealing its spoiler. A physical
KeyS event with the Russian character and Meta modifier saved that item once.

The Media search scope browses photos, videos, documents, audio, voice and
video messages, GIFs and links across chats. It supports a blank query or
typed text, preserves the selected filter while typing, and uses Telegram's
pagination cursor. Results mask spoiler captions and open the source message.
Visible results can show a bounded photo thumbnail or a static video or
animation poster supplied by TDLib. The preview request rechecks the current
message and chat, including spoilers and protected content.
Chromium in an isolated BB profile decoded synthetic thumbnails from a
30-item search page. The last thumbnail was requested after scrolling it
into view, and the visible spoiler never requested its file.
When a user opens a search result, the target message highlights matching
terms in text, rich message blocks, captions and filenames. Search inside a
conversation highlights the matching rows and carries the terms into nearby
history. Spoiler content only gets highlighted after it is revealed.

All Chats provides separate Mini Apps and Public channels search scopes.
TDLib searches public chat names and usernames with a bot or channel filter.
BB verifies channel results and shows bots that expose a main Mini App.
The user can open the bot conversation or launch its app through BB's
existing review. Public channel search opens the selected conversation.
At a 900-pixel viewport, Chromium in an isolated BB profile displayed the
synthetic results without horizontal overflow, excluded an ordinary bot
and a forum from these scopes, and opened app review and channel history.

Mini Apps can request existing users, groups and channels through a prepared
keyboard button. BB previews the bot and requested fields, shows only
Telegram-eligible selections, and shares them after explicit confirmation.
An unauthenticated TDLib 1.8.70 probe recognized the prepared button method
and both sharing methods with a Mini App button source.
Requests involving bot membership or administrator access show the potential
change and the requested rights before confirmation. BB rechecks the button,
the selected chat and the bot's eligibility before dispatch. A Mini App can
also request managed bot creation. BB shows the managing bot and lets the user
edit the proposed name and username. It checks username availability with
TDLib and sends the created bot back through the prepared button. A successful
creation is reported separately if sharing fails or remains unconfirmed.
The unauthenticated TDLib 1.8.70 probe recognized the username and creation
methods. The same confirmation form opens standalone managed-bot Telegram
links from messages and links pasted into All Chats. TDLib re-resolves the
manager at confirmation and creates through the link-specific flow.
Chromium exercised that link in the plugin installed on an isolated BB
profile backed by synthetic TDLib. Cancelling the form and submitting an
occupied username made zero creation calls. After editing both fields and
confirming, the fixture received exactly one creation with the reviewed
manager, name and username and `via_link: true`.

Instant View maps retain the article's dimensions, scaled proportionally when
needed to fit TDLib's thumbnail limits. BB only requests a preview when opened,
and checks the coordinates, zoom and supplied dimensions against the article.

UI regressions verify that the reader's visible row stays at the same viewport
offset when an earlier message disappears in a forum topic or Saved Messages
by chat. The tests also verify that the adjustment doesn't request another page.

History regressions cover a reply from an older-page request arriving after
a disconnected live refresh replaces the displayed range. Both regular chat
history, which also backs Saved Messages, and forum topics discard that reply
and keep the replacement range's pagination cursor.

An isolated BB obtained a synthetic temporary profile link with its expiry
through the installed plugin RPC. TDLib fixtures verified the ordinary link
request flags. The UI test verified that both copy and QR controls disappear
after expiry.

An isolated BB resolved an ordinary temporary contact token through the
installed plugin RPC with synthetic TDLib. UI tests opened the resulting
contact profile from a message and from a reviewed link in All Chats.

An isolated BB returned distinct whole-album and single-item links through the
installed plugin RPC with synthetic TDLib. The UI regression checks that a
linked item in a ten-item album remains highlighted in nearby messages and
that the shared caption appears once.

An isolated BB resolved a legacy Telegram link to the General forum topic
through the installed plugin RPC. Synthetic TDLib returned the chat ID with
both the linked message and topic reference absent, then confirmed the
General topic in a separate lookup.

Instant View loads available static video and animation posters when visible,
including inside galleries. A spoiler poster loads after reveal. Poster downloads
reuse the article photo RPC, which resolves their IDs against the cached article.
The preview reserves space using valid video and GIF dimensions from TDLib
before a poster loads. Tests cover the reserved frame, hidden spoiler
media and fallback for invalid dimensions. Chromium in an isolated BB
measured the same landscape frame before and after poster image decoding.
It verified the proportions of the video and a portrait GIF in a
360 CSS-pixel-wide reader and observed no poster request below the fold.

In an isolated BB browser session, synthetic TDLib returned a PNG with a valid
signature but invalid image data for a visible chat avatar. The browser rejected
it, BB retried once, and the replacement decoded at 16×16 in the chat list
without opening the conversation. Real Telegram avatars on the main BB remain
to be verified with this build.

An isolated Instant View RPC initially failed because an author block with
no publication date contained an undefined property. The normalized response
passed BB's JSON check. The same fixture verified that the article retained
its author, static embed and caption for an unavailable video.
The server now omits absent optional object fields at the common RPC boundary.
The host regression covers direct requests and requests tied to a connection.

An isolated BB exercised the shortcut list, message list, retry and send RPCs
with synthetic TDLib responses. The first run exposed a BB serialization
error on an undefined optional field in the message list. After normalization
at the RPC boundary, the fixture blocked a shortcut with a failed message,
retried the message, read the replacement, rejected a stale retry, and
dispatched one synthetic send after recovery.

A read-only check of the main BB confirmed a ready Telegram session on TDLib
1.8.70 with Premium inactive. Its loaded plugin exposes cache usage but does
not return the retention policy field, and the quick-reply list RPC returns
`unknown_method`. This host cannot verify the current cache policy or the
quick-reply changes until it loads the candidate. The live 4 GB upload check
remains deferred until an eligible account is available.

An isolated unauthenticated client using the same TDLib 1.8.70 binary
recognized six quick-reply methods, including loading templates and their
messages, creating an album, editing, re-adding a failed message, and sending
a shortcut. The probe supplied no application configuration or account
session. This establishes method recognition, not account-level acceptance.

An isolated BB with synthetic TDLib responses exercised the actual plugin RPCs
for cache usage, policy changes and clearing. Saving 64 MiB and 7 days sent
both limits in the same optimization request and reduced the reported usage
from 900 to 64 MiB. Clearing returned zero bytes, a fresh cache read retained
the policy, and the Telegram adapter still reported ready. In a follow-up run,
the synthetic cache grew to 192 MiB after saving the policy. The normal
one-minute background timer sent an optimization request with the 64 MiB and
7-day limits without a cleanup RPC, and the next cache read returned 64 MiB.
An age-only policy change also sent an optimization request with a 7-day TTL
when usage was 32 MiB and the existing 512 MiB limit stayed the same. The
fixture returned 16 MiB and BB displayed that result through the cache RPC.
Physical disk reclamation and age-based expiry of real files remain unverified.
BB requests fresh storage statistics after optimization. TDLib's optimizer
can count a file as removed when the filesystem refuses the unlink.
An isolated BB displayed the remaining 80 MiB of a synthetic cache file
despite a zero-byte optimization response. The browser fixture verified the
allocated disk blocks before cleanup and checked that the retry removed the
file. The session stayed ready and the same 50 history rows were available.
[TDLib cache cleanup implementation](https://github.com/tdlib/td/blob/master/td/telegram/files/FileGcWorker.cpp).
Cache statistics classify story photos, story videos, Live Photo motion
files and wallpapers when TDLib reports them. Cleanup includes the
reported story and motion types and offers a separate wallpaper action.
Manual and automatic optimization check the current native download
counts in addition to the direct transfers BB already tracks. An active
unpaused queue defers cleanup. Starting or resuming a queued download
waits for cleanup already in progress.
Chromium in an isolated BB saved a 64 MiB limit and seven days of retention
while the native queue was active. Neither the policy change nor manual
cleanup sent an optimization request. After pausing the queue, a wallpaper
cleanup reduced the fixture file from 96 to 80 MiB. Clearing all managed
media included the story and Live Photo types, removed the remaining
fixture file and preserved the policy, authorization and 50 history rows.

The current plugin ran in an isolated BB browser session with a synthetic
private chat. Alt+Shift+I opened Chat details, and Escape returned focus to
the details button. Opening Shared media focused the search field. Ctrl+F
switched to conversation-wide search, and Escape returned focus to the chat
heading. This check used the installed candidate and synthetic TDLib responses.

Grid and List in Shared media use the same photo navigation. Load more
photos appends and deduplicates the next page while retaining the selected
photo. Go to photo message opens the selected item's context. Returning
to results restores the opener and the original scroll position. Synthetic
topic tests exercise the exact cursor, a failed page and its retry,
deduplication, and context and focus restoration in both layouts. Chromium
in an installed isolated BB verified a single next-page request from List,
opened the selected older message and returned focus to the original result.
Signed-in verification remains open.

Instant View retains inline rich-text buttons as well as button rows. URL
buttons use article link routing, and copy buttons write only after a click.
Named mentions and profile buttons open Telegram user details even when the
profile has no public username. BB checks that the cached article still
references the exact user before looking up the profile. Deleted or unavailable
profiles leave the article open. Disabled actions keep their labels and cannot
be activated. Unsupported or unsafe row actions appear disabled and mark the
article partial. Unsupported inline actions retain their text. Callback
payloads stay out of the article response. Adapter and UI fixtures cover
reference checks, profile opening, disabled actions, copy and unsafe URLs.
Chromium in an installed isolated BB verified three disabled actions with no
profile opening and one private-chat resolution on opening the active profile
button.
Signed-in article verification remains pending.

When TDLib provides rich-text revisions, Instant View renders the current
article and offers a separate comparison of up to 32 before and after
excerpts. Comparison keeps spoilers concealed and shows links as plain text.
Adapter and UI fixtures verify insertion, removal and replacement. Chromium
at 440px and 1280px verified comparison focus, restoration of the previous
scroll position and no horizontal overflow on a synthetic article.

Instant View offers original-file downloads for playable unspoiled video, GIF,
audio and voice blocks, including gallery items. Download uses the existing
article file route, which resolves IDs against the cached article. Chromium
saved a synthetic MP4 through that route and its bytes matched the original.

Open a standalone photo or photo in an Instant View gallery to save its
largest eligible JPEG through the article download route. The button and
Cmd/Ctrl+S save the selected item. The adapter resolves the current cached
article and checks the selected image again before streaming the file.
Spoiler photos and embedded posters are excluded. Tests verify the exact
gallery selection and cover both TDLib block array field names. A download
ticket test compared the original bytes and verified that removing the
photo during the download prevents delivery. Chromium in an installed
isolated BB saved the selected gallery item with Ctrl+S and matched all
37,802 fixture bytes. The spoiler item issued no download. Signed-in
verification remains pending.

Selecting a linked Instant View photo opens the destination supplied by
Telegram. The photo viewer remains available through its own action and can
close independently of the article. A spoiler keeps the linked image hidden until revealed. If a photo cannot load, BB can
still offer its validated destination.

Instant View galleries, nested list entries and quotes share the 200-block
article limit. Article media lookup follows the same limit. An anchor at the
end of a gallery opens its final item. When the full article changes the
number of slides, the reader displays a valid slide. Chromium in isolated BB
rendered the twenty-fifth entries of a list and a quote, jumped to the
twenty-fifth slide from a link, decoded its poster and returned to the
original slide. Signed-in Instant View verification remains pending.

An AST-based inspection of 145 UI files found additional matching sibling
keys in forum topic controls, community settings, story controls and message
attachments. These controls now include their component identity in the key.
An attachment regression reproduced a stale transcription control after the
message stopped being a voice note. It also checks that repeated capability
changes keep one transcription and one download-queue control and trigger
neither action by themselves. A second scan found no further matching
sibling keys in these changed files. One analogous potential conflict remains
between paid-reaction components in the frozen Stars area.


A browser check of the production chat page in a temporary BB with synthetic
TDLib history found repeated Quick replies controls that reduced the history
viewport to 32 pixels. The chat's optional controls reused the same React key.
A regression fixture with bot keyboard, quick replies and gift-shortcut
capabilities reproduced multiple Quick replies controls. The chat components
now use keys that include both the component and chat identity, preserving
per-chat state resets while separating adjacent controls.

The fixed 946-test candidate was reinstalled in a fresh temporary BB with the
same synthetic TDLib history. At a 1422 × 800 browser viewport, the conversation
showed one Quick replies control and a 340-pixel history area at the latest
messages. Scrolling up produced 99 unique messages and retained one Quick
replies control. The older-reading history area was 297 pixels high.
The log recorded exactly two history requests, with cursors 0 and 151 and
limits of 50. TDLib's fixture included the cursor message, which the adapter
excluded from the older page. The prepend increased content height by 6,606
pixels and compensated scrollTop to 6,607 pixels after rounding. This verifies
bounded pagination and the control-identity fix in an actual BB browser with
synthetic data. It is not signed-in main-build or delayed-media acceptance.



The 944-test candidate installed and activated under the bundled BB launcher
in a fresh temporary profile. The in-app browser opened Telegram through BB
sidebar navigation and rendered the Connect Telegram screen. Authorization
remained idle. The new SecureStorage and community-unban preview and commit
RPCs rejected malformed inputs at schema validation. This establishes
registration and startup for that candidate. It does not establish signed-in
Mini App or community behavior. The temporary profile contained no Telegram
session or credentials.


A subsequent read-only main-BB RPC check confirmed ready authorization before
and after reading Saved Messages. The initial and earlier pages each contained
50 messages, had zero overlapping IDs, and advanced the older cursor.
Searching Saved Messages for the authorized bb-read-check marker returned two
messages. The cache stayed at 57,470,976 bytes, with a configured 512 MiB size
limit. Its response omitted retentionDays, confirming the installed build's
age-policy gap. The run emitted counts only, sent zero messages and changed
zero settings. These are installed-build checks, not current-candidate
acceptance.

A further read-only check used the existing signed-in BB browser tab.
The running plugin was enabled without an activation error and referenced
this checkout. Its settings UI showed cache usage and the size limit but
omitted the age control, confirming that the loaded build predates the
current source. Saved Messages initially rendered 64 list rows. Scrolling
to the top automatically increased that count to 114 without clicking
Load earlier messages. The scroll height grew from 16,863 to 51,114 pixels,
and the resulting scroll position was 34,251 pixels, matching the prepended
height. This observes pagination and position compensation for that
installed build. It does not verify the current candidate, cold-cache
behavior, or all message and preview sizes. No messages were sent, files
downloaded manually, settings changed, or session restarted in this check.

The later signed-in main BB rendered 50 initial rows in Saved Messages.
Scrolling within the page issued no additional history request. Scrolling
to the earlier edge issued one request, added 50 rows without overlapping
IDs, and changed the anchored row's viewport offset by 0.47 CSS pixels.
Chromium measured the same row before and after the prepend.

The 931-test candidate activated under the bundled BB launcher in a fresh
temporary profile. Chromium opened Telegram from BB navigation and showed
an enabled **Connect Telegram** button. The authorization state stayed idle.
Seventeen RPCs for story reports, Stars invoices and payments, subscriptions,
channel revenue, paid media, paid reactions and invite management rejected
malformed requests at schema validation. Signed-in behavior remains unverified.

A separate native TDLib 1.8.70 client recognized 17 story, Stars, paid-media,
reaction and subscription-invite requests, including the nested paid-media
and subscription invoice constructors. Each request stopped at the native
initialization gate. The Homebrew TDLib fallback rejected 13 of the same
requests as unknown. Neither client was initialized or authorized.

The 897-test candidate installed and activated in a fresh profile using the
bundled BB launcher. It served the web application, and Chromium opened the
Telegram panel from BB navigation and rendered an enabled **Connect Telegram**
button. Authorization stayed idle. Six RPCs rejected malformed inputs
(`resolveCollectibleGift`, `resolveMessageLink`, `messageLink`,
`messagePreviewPlayback`, `messagePreviewCover`, `instantView`).
The lower-level server entry point served the API but returned 404 for the
application route, so only the launcher-backed result verifies rendering.

The default BB profile did not list Makosh Telegram. The separate running
profile with an authorized Telegram session points to this checkout and returns
cache statistics. Its loaded backend lacks the Instant View and quick-reply
document download RPCs, and its cache response lacks the current retention
policy field. A separate running profile also points to the checkout.

A read-only RPC check against that signed-in build requested the first page of
Saved Messages and then requested one older page using the returned cursor.
The pages contained 1 and 50 messages respectively. There were no duplicate
IDs or ordering violations, and the older cursor advanced. The run emitted
only counters. This establishes TDLib pagination for the installed build.
Chromium then opened Saved Messages in that same signed-in build and sent an
upward scroll gesture. The visible history grew from 1 to 51 message rows
without duplicates or use of the earlier-history button. The TDLib cache
reported 56,909,824 bytes before and after that run. No attachment download
was requested, and Telegram remained authorized. This is a single warm-cache
observation on the installed build. A second run repeated the same gesture
and counted files under TDLib's directory before and after. The media
directories stayed at 365 files, 217,729,640 logical bytes and 56,909,824
allocated bytes. The four service files grew by 904 logical bytes while
their allocated size stayed constant. Live verification of the current build
and browsing with a cold cache remains pending.

A separate temporary BB profile with idle Telegram authorization accepted
a DeviceStorage RPC containing a 5,242,879-byte ASCII value plus a one-byte
key. The request reached the handler, which returned the expected connect
refusal. A 5,242,881-byte value was rejected by RPC schema validation.
A second temporary BB run used synthetic TDLib responses for account
authorization and two Mini App launches. The real plugin saved and read back
the 5,242,879-byte value through BB RPC with exact equality. A second bot received
no value for the same key, and clearing storage removed the value for the
original bot. SQLite tests also cover account isolation and quota overflow.
Verification with a real Mini App in the main BB remains open.

The updated build installed and activated in another temporary BB profile
without Telegram authorization. The eight gift-management RPCs and four
Mini App RPCs for location permissions and prepared messages rejected
malformed inputs at schema validation. An independent TDLib 1.8.70 client
recognized eight native methods, including received-gift lookup, upgrade
preview and execution, transfer, removal of original details, resale
pricing, prepared-message lookup and bot emoji-status permission. All native
requests stopped with an error before authorization. This verifies method
recognition and RPC registration. Live gift operations remain unverified.

A fresh temporary BB profile accepted and loaded the current local build.
The Telegram app route returned HTTP 200, the authorization RPC reported idle,
and Instant View, quick-reply document download and quick-reply document upload
preparation RPCs rejected malformed input with schema-validation errors.
The smoke test closed the temporary BB process after the checks. Confirm the
intended signed-in profile before deploying this build and running the
account-dependent checks below.

The later candidate with 811 passing tests also installed and activated in
a clean temporary BB instance. Its authorization state was idle and the
`chatGiftButton`, `instantView`, and `launchMiniApp` RPCs each rejected a
malformed payload. The temporary service and isolated profile were removed
after the check. Account-dependent behavior was outside this smoke test.

The 852-test build also installed and activated in an isolated BB profile.
Its authorization state was idle. BB rejected malformed payloads for 12 RPCs
covering Instant View, gifts, Mini App launch and chat selection, clipboard
eligibility, emoji status, boosts, channel settings and translation. The
isolated profile and process were removed after the check.

An unauthenticated probe of the TDLib 1.8.70 dylib used by the signed-in service
recognized the four tested boost methods, both tested emoji status catalogs,
getAttachmentMenuBot and translateMessageRichMessage. The default Homebrew
1.8.0 dylib reported each as an unknown method. Neither probe received an
application configuration before its deadline. Both native clients closed
normally. This establishes method recognition without testing account results.

A fresh BB profile initially opened its first-run screen. A second Chromium
run used BB's supported `BB_SKIP_ONBOARDING=true` setting on the temporary
instance. It rendered the Telegram sign-in heading and an enabled
**Connect Telegram** button. The check stopped before initiating sign-in.
The temporary BB instance was stopped after each run.

A synthetic Mini App passed a Chromium check using two intercepted HTTPS
origins. The browser reported an opaque frame origin and sent no referrer.
The fixture received theme and main-button events and returned data only after
confirmation in the host UI. This check used the plugin component with fixture
actions; it did not exercise BB host CSP or Telegram authentication.

A separate Chromium fixture sent a file download request from the isolated
Mini App frame. The browser made no file request before confirmation or after
cancellation. After a second request and a click on **Download file**, it made
one request and saved the expected bytes from a synthetic attachment response.
The Telegram validation RPC was simulated in the fixture.
The **Save file as…** path passes the reviewed filename to the host file
picker and streams the response into the chosen file. Chromium blocked a
response without CORS permission, then wrote the allowed retry to a browser
file and emitted one downloading event. The fixture supplied the picker
result. A UI test also verifies that cancelling the picker issues no GET.

A local Chromium fixture exercised the production history-scroll helper with
real layout and ResizeObserver. A 90 px media expansion in a clipped row and
a subsequent 90 px prepend with replacement of the anchor DOM node both left
the next visible message at the original 40 px viewport offset. At the latest
messages, media expansion kept the viewport at the bottom. This fixture did
not exercise TDLib pagination or the signed-in host.

The production local transcription adapter ran offline on this Mac with the
cached MLX Whisper large-v3-turbo model and a synthetic Opus voice note. The
transcript contained both reference phrases, and a repeated request returned
the cached result without reading the audio again. This check did not use
Telegram or exercise transcript delivery to an agent in the signed-in BB.
UI and host fixtures verified cancellation and that a cancelled request
cannot display a late transcript or be started again with the same ticket.
In a separate offline run, cancelling after staging synthetic audio returned
an abort error and removed the temporary work directory. A new request on
the same adapter recognized all three reference words in the retry audio.
Chromium also exercised the installed build in an isolated BB with a synthetic
TDLib voice note and the local model. Clicking **Cancel transcription** after
the input was staged removed the work directory and restored the retry button.
The retry downloaded the note again and displayed the expected transcript.
The fixture recorded two downloads and zero sends.

In the signed-in main BB, Chromium sent a synthetic Opus voice note to
Saved Messages and selected **Transcribe locally** on the returned message.
The Mac's model displayed both expected spoken markers. Chromium then
removed the test message. This run exercised the manual composer and
transcription control. Agent delivery on a real chat is still pending.

The agent-history regression exercises the registered agent tool with a
synthetic forum voice note. It verifies that the agent receives the local
transcript and its source marker only with AI access enabled. Revoking that
access during transcription returns no messages, and enabling protected content
during transcription also withholds the result. This uses a fixture transcription
engine; signed-in BB delivery remains pending.

Transcription from a chat or by an authorized agent uses the same cache
transfer guard. It waits for existing cleanup, re-verifies the source and
copies the bounded Telegram file before releasing the guard for local
conversion and inference. Cancellation while waiting skips the download.
The agent regression delays cleanup and then the TDLib download, verifies
that the two operations do not overlap, and confirms that cleanup becomes
available before the model returns its transcript.
Installed Chromium in an isolated BB cancelled a speech request while
the native cleanup response was held. The fixture recorded no download
from the cancelled request. On retry, a held TDLib transfer deferred a
new clear request. The offline model then transcribed the synthetic
note, removed its temporary input and sent no Telegram messages.

The cache transfer guard also covers thumbnail reads for photos, avatars,
sticker and GIF pickers and search results, plus sticker artwork, maps,
wallpaper patterns and article icons. An installed isolated BB fixture
held cleanup open, verified that the visible photo waited, then held the
photo download and verified that a new cleanup was deferred. Chromium
displayed the photo and caption and kept the photo visible after cleanup
resumed. The adapter fixture covers photos, avatars, and both pickers.

A Chromium smoke test used the production video player and streaming HTTP
handler with an in-memory synthetic MP4 in place of TDLib. The browser opened
the first frame, issued a nonzero byte-range request and decoded a frame at
00:20. By that point the handler had delivered 524,288 of 5,590,268 bytes.
On the signed-in main BB, Chromium sent one synthetic 30-second video to
Saved Messages. It decoded the opening frame, moved the player slider
while the HTTP response had delivered fewer bytes than the full file,
received a nonzero byte range through the TDLib-backed stream, and decoded
the target frame. The test deleted that exact message afterward.
The circular video note player also sought to 00:20 using its position
slider after receiving 524,288 of 3,375,646 bytes. Notes with an exact size
use the streaming route. Notes with only an estimated size use the existing
full-file player.

Native Chromium playback of a synthetic Instant View MP4 made no HTTP media
request while the video was below the fold. Scrolling to the video started
playback muted. Scrolling away paused it. This used the production article UI
and range handler with a synthetic file source.

The active and archived story feeds support Left and Right navigation across
authors while the viewer has focus. Forward navigation selects the next
author's first unread story when available. The viewer shows the position
within the current author and returns focus to that author in the list.
The feed can load another page from the viewer, recover from a failed page,
and keep the same story and acknowledged read state during the refresh.
TDLib updates refresh the open feed from the current snapshot. Repeated
identical TDLib updates are ignored, and a refresh supersedes an older
in-flight page result. Updating the feed leaves the current story and
its view lifecycle intact as long as it remains available in the list.
An installed isolated BB received duplicate fixture updates from TDLib while
a story was open. Chromium kept the photo mounted with one media download,
showed a new author and their read state, and moved the original author to
Archived after a second update. Only opening the two tabs requested pages.
Video playback pauses when
the browser tab becomes hidden. A story that loads in a hidden tab starts
its Telegram viewing lifecycle only when that tab becomes visible.
When an active or archived video finishes, the viewer advances to the
next available story if the tab is visible and there is no open
reply or edit.
Photos in the active and archived feeds show an eight-second progress bar
before advancing to the next available story. The timer starts after
the image loads and pauses on request, when the tab is hidden, or while
replying or editing.
A Chromium fixture using the production story viewer and CSS held the
animation at the same progress after 8.2 seconds of manual pause. Resuming
advanced to the second photo and emitted one close for the first story and
one open for the second. The Telegram viewing calls used fixture actions.
A second Chromium run paused and resumed the timer across authors, loaded
another author from the viewer, opened that story with Right, and returned
focus to its row. Fixture actions recorded three matching open and close
pairs and no story media request before navigation.
Profile stories and the personal story archive support manual navigation
between loaded stories and can fetch earlier pages from inside the viewer.
Stories and linked story viewers show the account's Premium stealth mode
controls on request. BB reads Telegram's active and cooldown deadlines,
reviews the past and future view windows before enabling the mode, and
requires fresh state from TDLib to show activation. Realtime updates keep
the active and cooldown countdowns current.
Installed Chromium in an isolated BB verified cancellation, an unconfirmed
acknowledgement, a confirmed activation from a TDLib event, and expiry of
the active timer while cooldown continued. The fixture recorded no story views.
Profile details can pin and unpin published stories, reorder pinned stories,
reorder story albums, and move stories among the loaded entries in an album.
BB checks current account ownership or chat editing rights, the reviewed
order, and Telegram's pin limit before writing. It checks the resulting
order again after Telegram acknowledges the request. Album story moves
preserve entries beyond the loaded prefix. Tests cover missing editing rights,
stale orders, a story outside the profile, the pin limit, and a paged album.
Chromium in an isolated BB pinned and unpinned a synthetic channel story,
moved an album, and reordered the stories inside it. The fixture confirmed
the four writes to their exact channel and album and recorded no story views.
Profile and chat details can create and rename story albums, add existing
published or archived stories, remove a selected member, and delete an
album after review. BB checks editing rights and the current album title.
For additions, it reads the album membership through the last page and
uses Telegram's limit before dispatch, because TDLib can drop tail entries
when an album overflows. Removing a member or deleting an album changes
only the album. The adapter fixture covers a stale album title, a foreign
story, an already-present story, and a page count that understates the
members in the album.
Installed Chromium in an isolated BB used a synthetic channel to create
an album from its profile, rename the album, add an archived story, remove
another member, and confirm deletion. The fixture recorded the five album
mutations and no story views.
The story player loads Telegram's reaction catalog on demand. It shows
ordinary reactions and eligible Premium custom emoji, rechecks eligibility
before applying a choice, and can remove the active reaction. The activity
panel can search and filter personal-story viewers by contacts, and sort by
date, reactions or forwards. Chat story activity supports sorting by date
or forwards. Pagination preserves the applied filter, and reaction rows
display the custom emoji when Telegram provides it.
Chromium with an installed isolated BB verified that opening the catalog
made no reaction mutation, selecting and removing a reaction targeted the
same story, and a channel's forwards-first request used its filtered cursor
on the next page. Personal filters and Premium eligibility have UI and
adapter fixture coverage.
The story viewer can request Telegram's report reasons, review the selected
reason and collect any requested details before submitting. UI and TDLib
fixtures cover the review and submission flow. The adapter fixture also
checks that a missing story cannot be reported. Live verification remains open.

### Grouped acceptance on the signed-in BB

The November 19 main BB update preserved Telegram authorization. The
verified local backup retained the session, plugin database and previous
TDLib. The installed plugin used the patched library. The folder endpoint
returned native responses for ten folders. The signed-in account had one
joined community and no community administrator fixture.

On the updated main BB, Saved Messages added 50 older rows to 50 initial
rows with no duplicate IDs, no request in the middle of the list, one
request near the top, and 0.03125 CSS pixels of anchor movement. The disk
cache stayed the same during that browse. A forum topic returned two
50-message pages with distinct IDs. Cache cleanup scoped to Saved Messages
reduced reported bytes from 96,018,432 to 44,937,216. Authorization and
history stayed available. Chromium opened the keyboard guide and the
Show 18+ Content control, including at 740 CSS pixels. The preference was
read without changing it.

Chromium sent a synthetic voice note, produced a local transcript and
deleted the test. It also verified the album caption and viewer order, a
sticker, two distinct decoded GIF frames, and a streamed seek that fetched
a nonzero byte range before the video finished downloading. The media
fixtures and one manual text fixture were removed from Saved Messages.

The existing agent fixtures were retried after releasing their idle
runtimes. The read fixture reported the Telegram tools unavailable and
the send fixture produced no BB approval form or Telegram delivery. The
installed plugin reported agent access enabled. This run leaves live
agent-tool discovery, physical device consent, and privileged community
mutations unverified.

An isolated BB profile installed the current plugin, connected to a
synthetic TDLib transport and set a 192 MiB cache limit with 14-day
retention. The plugin closed the fixture worker, reloaded, reconnected and
read back both settings before closing the worker again. The isolated test
does not verify migration or renewal of a live Telegram authorization.

Reopen the existing Telegram session after updating the plugin. Use Saved
Messages and the designated test chat for test messages. Keep real message
bodies and media out of test logs and reports.

1. **Reading, history and notifications.** Open at the last read position and
   confirm the unread count changes as unread messages enter view. Scroll up
   to load older pages without moving the current message on screen. Repeat
   in Saved Messages and forum topics. Check that a notification opens its
   message in the right topic and that marking it read updates that scope.
2. **Media and transcription.** Verify photos and captions, stickers, GIFs,
   albums, and seeking before a video has fully downloaded. Play a voice
   message, transcribe it locally, and check the authorized agent result.
3. **Navigation, communities and Mini Apps.** Open a dotted Telegram folder
   from its nested position. Check chat, group and channel settings at wide
   and narrow sizes and verify keyboard shortcuts. In a test community,
   check the ban list and verify adding and removing a test folder membership.
   In a test Mini App, verify independent camera and microphone consent and
   confirm that closing the app ends its session. Check Show 18+ Content in
   Telegram privacy settings and confirm the preference readback.
4. **Agent search, reading and sending.** Search and read across senders in
   an AI-enabled chat using the requested filter. Verify a disabled chat is
   excluded. Confirm the BB dialog for agent sending and direct submission
   for manual sending. Use only authorized test destinations.
5. **Cache and session continuity.** Compare disk usage while browsing and
   after clearing media. Check the reported size, size and age limits, and
   continued access to the signed-in session.

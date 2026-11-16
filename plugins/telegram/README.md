# Makosh Telegram

Voice calls and video calls are currently out of scope. Open the player in a
conversation to listen to voice messages or stream supported MP4 and WebM
videos with seeking. Video streaming uses partial TDLib downloads for media
with a known file size. Audio and images opened through the standard media
player retain the 32 MiB limit.

Use **Voice** to record up to two minutes or choose an Ogg Opus, WebM, or
M4A/MP4 voice file, then select **Send voice note**. WebM and M4A/MP4 voice
recordings require Homebrew FFmpeg on the BB server. **Stickers** offers recent
and favorite stickers, browses and reorders installed sticker packs, and searches public stickers by word or emoji. **GIFs** offers saved animations and searches Telegram’s configured GIF bot. Both pickers provide a separate
send button. Use the media picker in chats and forum topics to send stickers, GIFs, voice notes, video notes and photo albums, including as replies. **Video note** records a clip with the camera or opens an MP4 or WebM file up to 8 MiB. Received video notes open in a round player with play, seek and speed controls. The player offers playback speed for ordinary audio and video as well as voice and video notes. BB remembers recent playback positions when you close the player or switch chats. Positions last while the Telegram panel stays open. Use **Transcribe locally** on a voice or video note to run MLX Whisper on this Mac. Agents can receive that text in chats you have allowed them to read. BB uses Homebrew FFmpeg on the server to crop the video to a square and limits it to 60 seconds. Open **Media delivery options** to send without sound or choose a future send time. In **Send options**, select **Preview scheduled media** under a queued message to inspect the attachment before sending. On eligible messages, use **Sticker favorites** or **Saved GIFs collection** to add or remove that item from the Telegram collection. The same actions are available in search results, message context and channel comments. On a sticker from a regular pack, use **Open sticker pack** to preview its stickers, copy the pack link, or install the pack. Paste a Telegram sticker-pack link into **All chats** to open the same preview directly. WebP and TGS stickers can show an available static thumbnail.
**Photo album** sends 2–10 photos as one Telegram album, with options to hide all photos under spoilers or place the caption above the group. Add or remove photos before sending, and use the arrows next to each photo to change the send order. Albums are grouped in conversation and topic history. A shared caption appears above or below the entire group. In the photo viewer, use the arrow buttons or Left and Right keys to move between photos. **Chat details → Shared media** opens the photo and video grid, with a **List** view for message details. The grid viewer can move between loaded photos.

Select **Transcribe locally** on a voice message to run MLX Whisper on the
Mac running BB. This uses cached `mlx-whisper` via `uv` and the local
`mlx-community/whisper-large-v3-turbo` model. It runs offline and the transcript
cache lasts for the connected session. On chats with AI history access,
the history tool returns recognized voice text as `text` with
`voiceTranscript: "local"` and paginates after at most two voice notes per
request. It marks unavailable transcripts without sharing the original audio.

Create an anonymous poll in a group, channel, or forum topic when your Telegram permissions and installed TDLib support publishing it.
Answer Telegram polls from the conversation, a forum topic, or a search result. BB shows results and
allows changes to your vote when Telegram permits them. Use **End poll** on a poll you can edit to close voting for everyone. You can pin and delete
messages inside a forum topic when your Telegram permissions allow it. You can
also attach a photo or a document to the open topic. Paste a screenshot into a conversation or topic to attach it, or use **Attach photo** for JPEG, PNG, or WebP. BB encodes photo attachments as JPEG. Use **Attach document** to keep the original format. Select a reply’s
quote to view the original and surrounding messages from that topic. Use the
search icon in the topic to find text or media within it.

Run the BB server on a Mac with Apple command-line tools (`/usr/bin/python3`)
and TDLib (`brew install tdlib`). For a nonstandard TDLib installation, set
`MAKOSH_TDJSON_PATH` in the BB **server** environment to its dylib path.
Open **Agents** in BB to see the loaded version. TDLib 1.8.0 uses 32-bit file
sizes and predates forum topics. For those features, use a current build of
TDLib and restart the BB server with `MAKOSH_TDJSON_PATH` set.
Telegram upload limits are 2000 MiB for standard accounts and 4000 MiB
with Premium and a compatible TDLib. TDLib 1.8.0 caps uploads at 2000 MiB. Use a separate
BB profile to evaluate a new version before migrating an existing TDLib database.

Set `MAKOSH_TELEGRAM_CREDENTIALS_FILE` in the server environment to the absolute
path of the private Makosh Telegram app configuration. It must be a regular
file owned by the server user, with mode 0600. It contains two settings:

```dotenv
MAKOSH_TELEGRAM_API_ID=<app ID>
MAKOSH_TELEGRAM_API_HASH=<app hash>
```

The native Makosh project keeps this input at `.local/telegram-build.env`.
The runtime reads the pair without copying the file or reusing Makosh's
account session. BB stores a separate TDLib database for each BB profile
with a generated encryption key in BB secret settings.

Open the **Telegram** pane, select **Connect Telegram**, and confirm from a
phone already signed in to the desired account. On a BB server restart,
**Connect Telegram** first opens the existing local session if one is available.
The plugin reads the main chat list, archive and Telegram folders, plus recent message text and captions. Forwarded messages show their source when Telegram makes it available. Visible chat rows load the Telegram avatar. A small preview or initials are shown while it loads. BB retries a failed avatar download while the avatar is visible. Incoming messages display the sender name and avatar where available. BB displays reaction counts when TDLib provides them. Use **Add reaction** to choose a standard emoji that Telegram allows for that message, or select your reaction to remove it. The People, Groups and Channels filters apply to the loaded list.
Use **Attach video** in a chat or **Attach topic video** in a forum topic to send an MP4 as a Telegram video. BB uses local FFprobe to read video metadata and the same upload limits as documents.

Use **Edit caption** on your editable photos, videos, GIFs, audio and documents to change or clear the caption. On photos, videos and GIFs, **Show caption above media** moves an existing caption above or below the media.

In All Chats, search finds known chats by name. Enter an exact public `@username` or `https://t.me/username` link to open a public chat, group, or channel. Use **Join** or **Request to join** when Telegram offers the option. Paste a Telegram message link in **All chats** and select the result to open that message and its context. Private invite links show the group or channel before you choose whether to join. Open paid invitations in Telegram to review the subscription. Paste a Telegram shared-folder link in **All chats** to preview it and choose which chats to add. Telegram joins selected chats if needed. In folders and Archive, search shows only results that belong to the selected list. BB displays dotted Telegram folder names as a tree. For example, `itq.evoca` appears as `itq → evoca` and still opens the original Telegram folder. Open **Manage folders** in the sidebar to create, rename, change rules, or remove a Telegram folder. In an existing folder, use **Folder invite links** to create, view, copy, rename, or revoke its invitations. Telegram determines which chats can be shared, and you choose which ones to include. Use **Edit shared chats** to update the selection for an existing link. Shared folders have a **New chats from the owner** section where you can check for new chats, add selected chats, or hide the suggestions. Use **Folder icon** when editing an existing folder to choose its sidebar symbol or let Telegram select it automatically. BB displays folder colors in the sidebar and colored labels on member chats when Telegram folder tags are enabled. Use **Folder tags** to turn them on or off with Premium. With Premium and folder tags enabled, use **Folder color** when editing an existing folder. Under **Folder order**, move folders up or down and save their order in Telegram. Under **Recommended folders**, load and add Telegram’s suggested folders. Removing a folder leaves its chats in your account. Use **Chat folders** in **Chat details** to include or exclude that chat or let the folder rules decide. Open **Chat details** to pin or unpin the chat in the current list or folder, mute notifications for 1 hour, 8 hours, 1 day, or 7 days, or restore Telegram notification defaults. For temporary mutes, BB shows when notifications resume. In a chat or forum topic, use **Notification sound** to inherit the sound, use the default sound, turn the sound off, or select a saved Telegram sound. Open **Notifications** in a forum topic to change its mute, preview, pin and mention settings or inherit the group defaults. Use **Message preview in notifications** to show or hide message text for the chat. Override notifications for pinned messages, mentions, and stories in the same section. You can also hide the story author and choose a separate sound for story notifications. **Saved** opens the signed-in account’s Saved Messages. **Refresh** fetches
updated chats. The **Open demo** button loads an independent fictional view.

In the Telegram pane, **Send message** posts text directly to the open chat. Use **Forward message** to choose another chat or a specific forum topic and forward a Telegram message while retaining its original attribution. Use **Reply** on a message to send text, a photo, or a document as a reply. BB verifies the original message before accepting a document upload and again before sending it. **Edit** is available for your editable plain-text messages in chats and forum topics. BB refuses to overwrite a message that changed after you opened the editor.
Open **Send options** to send a text draft silently or schedule it at a local
date and time. Scheduling in Saved Messages creates a reminder. The panel
lists scheduled messages for the conversation and lets you cancel them.
Use **Use Telegram draft** to load a plain-text Telegram draft. Choose **Save draft to Telegram** to sync the current text, or empty an opened draft and choose **Clear Telegram draft**. BB checks the last seen draft before saving.
If Telegram does not confirm delivery or returns a reply that does not match the selected message, check the history before retrying.

Use a local, trusted BB server profile. BB's SDK distinguishes other plugins
from BB clients, but does not distinguish the browser UI from local clients
that can call plugin RPC. The plugin refuses calls from other plugins, keeps its manual RPC out of
BB discovery, and does not register CLI commands or mentions. A process with the owner’s BB
credentials can still call the manual client RPC directly. Agent approvals
trust the decision supplied by BB. Give agents access only to the tools and
credentials appropriate for their role.

The **Allow agents to request Telegram sends** setting is off by default. When
enabled, `makosh_telegram_request_send` opens a BB confirmation with the exact
draft and chat picker. A single recipient is selected by default. BB checks
the destination name and chat type again after the user confirms. The tool receives delivery status
only. It does not return Telegram messages or recipient names. The picker uses the main list by default. A recipient query can show matching chats or Saved Messages. A public @username or t.me username link resolves one chat for review. Use **Copy chat reference** in the header to pass the exact recipient ID to the tool.

**Allow agents to request my original Telegram messages** is off by
default. `makosh_telegram_request_read` defaults to Saved Messages and accepts **Saved Messages** or **Избранное** as an explicit chat name. With an
exact chat name, public @username or t.me username link it searches for text sent by the signed-in account in that
chat. BB can check up to four pages of matching messages from that sender. Set `textQuery` to restrict the review to eligible messages containing
that phrase. Include `dateFrom` and/or `dateTo` (YYYY-MM-DD, UTC, inclusive) to
filter candidates within the pages searched by the tool. The approval form lists
candidate dates and loads just the selected preview on demand. By default, one chosen message is shared. With `maxMessages` set to 2–5, you can
preview and confirm authorship for each message individually, then approve the batch in BB.
If a selected message changed after review, BB withholds the entire batch. The plugin rechecks the reviewed text and the source conversation
before sharing. Forwarded, imported, bot, and non-text messages are excluded. For a reply, BB shares only the text you wrote, without the quoted message or the other participant’s text.
Identity is verified using the sender's user ID. When you manually publish
a text post from BB as a channel, BB records the account, chat and message
IDs and a keyed digest of the original text in local plugin storage. An
exact reference or Telegram message link to that unedited post can be reviewed if the account and
content still match. A request by exact channel name also checks the 25 most
recent posts BB recorded for that account and channel. Confirm authorship only for text you wrote
yourself. Pasted third-party text cannot be detected reliably. The approved
messages go to the model provider running that BB thread.

Open **Chat details** in the conversation header and select **Allow AI to
search and read this chat**. Access starts off for every conversation. BB
stores permissions for the signed-in Telegram account. Old profile-wide
settings grant access to no conversations. Turning the switch off cancels
pending agent reads. Signing out clears all chat permissions for the profile.
BB checks conversation permissions when `makosh_telegram_read_history` or
`makosh_telegram_find_chats` is called, including in threads opened before
the permission was granted. Threads started on versions that omitted the tools
may need to be reopened in a new BB thread once. Find granted chats by name or mentions of the search
phrase within inclusive UTC dates. Search returns chat references and matching
indicators without message snippets. Follow its `next` cursor while it is present.
Read history separately with the exact chat ID and the same dates. It returns a page of
results across all authors, including available text and captions. Pass the
returned `before` cursor with the same chat and dates until it is null.
Use a message's `replyToken` to propose an exact reply in the same BB thread.
BB confirms the reply in its sending dialog and checks the original before dispatch.
Secret chats and protected content are withheld. Telegram's content licensing
terms specify consent of all relevant users for a limited AI exception.
See https://telegram.org/tos/content-licensing.

Scroll to the oldest visible message to load more history automatically. Older messages are inserted above the current view without losing your reading position. Use **Jump to latest** to return to the newest message. When new messages span multiple pages, BB loads the intervening pages before updating the open conversation.

While a conversation is open, new Telegram messages refresh its recent history
and the selected chat list. Earlier pages and local drafts stay in place. Use
**Refresh** when the BB connection was interrupted.

After an approved read, the agent receives a reply token for that message.
It can propose a reply with the token. The approval shows the source message
and locks the destination to the original chat. The token works for at most
ten minutes in the same BB thread and Telegram session, and can be used once.
The plugin verifies the original text immediately before sending. When
TDLib identifies the source as a forum message, BB shows the topic in the
approval and sends the reply to that same topic. Manual replies also use
the original forum topic.

Scroll to the bottom of the chat list to load up to 40 more chats in the
selected folder. The open chat and its draft stay in place. Agent recipient
search is separate.

In **All Chats**, use **Contacts** to list or search Telegram contacts and open a private conversation. In a private chat, **Contact** in **Chat details** lets you add, rename, or remove the contact.

In **All Chats**, use **Messages** for global search across your chats or
**Public posts** for Telegram's free public channel search, including hashtags. Select a result
to open the message and its context, including forum topics. Public post
search requires a TDLib version that supports it and uses no Telegram Stars.

Use the search icon in a conversation to find older matches on Telegram. In a group or forum topic, select a message author to search their messages and optionally narrow the results by text or type. **Jump to date** opens the nearest message on or before the selected local calendar date, with nearby messages for context. In that view, load earlier or newer messages without losing your place. Copy a
message reference directly from the conversation, a forum topic, or search. In
supported groups and channels, the link button copies a Telegram message URL
for an exact agent read request.
The **@** badge counts unread mentions and replies. Select **@** in the chat header to browse them. Conversation and topic search also offer **Mentions and replies** and **Unread mentions and replies** filters. Opening the list does not mark mentions as read. The heart badge opens messages with unread reactions. The same filter is available in conversation and topic search. Use **Mark all mentions and replies read** or **Mark all reactions read** to clear that activity in the current chat or topic.

Use **All pinned messages** on the chat’s pinned message banner, or **Pinned topic messages** inside a forum topic, to browse all pins and open their context.

From **Chat details**, open shared photos and videos, files, links, audio, voice and video notes, or GIFs. Switch categories inside the shared-items view to browse without entering a search phrase. Search loads up to 40 matches at a time. Use **Load more matches** to continue. Closing the search returns
to the open conversation and its draft.

**Send when online** is available in private chats when Telegram shares the recipient’s exact online status. In chats and forum topics, use **Send options** for silent and scheduled text messages. The schedule inside a topic only contains that topic’s messages. Telegram Premium accounts can set a repeat interval for a scheduled text message. Rescheduling an existing message keeps its interval. Use **Reschedule** or **Send now** on an existing scheduled message. Telegram applies the change to messages scheduled together with it.

In a forum topic, use **Use Telegram draft** to load its plain-text draft. **Save draft to Telegram** and **Clear Telegram draft** apply to that topic on your other Telegram devices. BB checks the latest remote draft before writing.

In chats and forum topics, use **Reply → Choose quote** to select a passage from a text message for a text reply. The quoted passage appears in the reply preview. In chats, forum topics, and channel discussions, **Shift+Enter** inserts a new line and **Enter** sends. In chats and forum topics, use **Format message** and select text to apply bold, italic, underline, strikethrough, monospace, or spoiler formatting before sending. BB keeps formatting in the local composer. When editing a sent text message with those styles, the editor previews which formatting will be preserved. Use **Aa** in the edit form to apply or clear styles, including edits that change formatting alone. Text messages show link cards supplied by Telegram. When composing in a chat or forum topic, select **Include Telegram link preview** to attach a card to a message with an HTTP(S) link, then choose whether the card appears above or below the text. If the draft contains several links, select the one to preview. Text edits keep the existing link card when its original URL remains in the message. In the editor, select **Remove link preview** to remove just the card.

Before sending a single photo or an MP4 as video in a chat or topic, use the attachment preview to hide the media under a spoiler or show its caption above it. The saved GIF picker offers the same controls and a caption field. GIF search sends the inline result supplied by Telegram. Photo previews load from TDLib when they enter the visible part of the conversation. Clicking the preview loads a larger version when available. Use **Zoom in**, **Zoom out** and **Fit** in the photo viewer. **Save photo** downloads the largest eligible image when Telegram allows saving. BB keeps the caption above or below the media as set in Telegram. Photos under a spoiler load when you select **Show photo spoiler**. For a video or GIF under a spoiler, reveal it before playback or download. The conversation preserves bold, italic, underline, strikethrough and monospace formatting in messages and captions. BB hides spoilers in chat previews and quotes. Select **Show spoiler** in the message to reveal it.
Previews are limited to JPEG, PNG or WebP files of up to 512 KiB. Files and
self-destructing media are outside this preview feature.
Use **Download** on a document, video, audio file, animation, or voice or video note
to save it. BB shows the file size reported by TDLib and marks estimates with ≈. Telegram's content protection and self-destruct settings limit which
files can be downloaded.

In a group or channel, **Chat details → Group or channel information** shows its name and description. Members with Telegram’s permission to change chat information can edit them or select and preview a square-cropped photo before saving it. The photo editor also lets them remove the current photo.

In a supergroup, **Chat details → Slow mode** shows the delay between messages. Administrators with permission to restrict members can change it.

Channel posts show the author signature and view count when Telegram provides them. Administrators with permission to change channel info can manage signatures and sender profile links under **Chat details → Post signatures**. Hover over **edited** to see when a message was last edited. On an outgoing message in a group or forum topic, use **Who viewed this message**. Telegram provides this list for recent messages in eligible groups.

In a private chat, select the double checkmark on an outgoing message to see its read time when Telegram provides it.

In a private chat, open **Chat details → Blocking** to check the current Telegram block status and confirm blocking or unblocking the user. Use **Hide stories from user** or **Show stories to user** to change the stories-only block.

In **Settings → Profile**, preview, set, or remove your main profile photo, or edit your first name, last name, plain-text bio, public username, or birthday. The birth year is optional. Change who can see your birthday in **Settings → Privacy**. Use **Check username** to see whether a new username is available. BB checks the current Telegram value before each save.

In **Settings → Privacy → Blocked users and chats**, browse your Telegram block list, open a conversation by selecting its name, or confirm unblocking. Choose **Hidden from stories** to manage the separate list for stories. In **Settings → Privacy**, inspect and change the default audience for phone number visibility and lookup, last seen, profile photos, bio, birthday, profile audio, links in forwarded messages, and invitations. Use **Read time in private chats** to control whether Telegram shares the time you read messages. People who can see your online status can still see read times. Existing exception rules are carried forward when the setting has a supported audience.

In **Settings → Privacy → Archive behavior**, choose which chats stay archived when new messages arrive. If Telegram enables automatic archiving for your account, BB can also archive and mute new chats from non-contacts.

In **Settings → Privacy → Auto-delete in new chats**, set the default Telegram message timer from 1 to 365 days or enter 0 to turn it off. Confirm the change before saving. In **Chat details → Auto-delete messages**, view or change the timer for an individual chat. Telegram controls who can edit it. Chat and forum histories group messages by local calendar date. Select a date divider in a chat or forum topic to open **Jump to date** with that day prefilled. Timer changes appear as service notices in the conversation, along with events such as renamed chats, changed chat photos, and closed forum topics. Select **Message pinned** in the timeline to open the referenced message when it is available.

In **Settings → Notification defaults**, set mute, notification sound, message previews, pinned-message notifications, and mention notifications separately for private chats, groups, and channels. For private chats, the same panel also controls whose stories trigger notifications, whether to show their author, and which sound to play. Per-chat overrides take precedence. While the Telegram tab is open, BB shows in-app notices for new incoming messages reported by TDLib and respects Telegram’s preview setting. Select **Open message** on a notice to open its conversation and message context, including forum topics. Open **Saved notification sounds** to preview a sound, add a short MP3 (up to 300 KiB), or remove a saved sound from your Telegram account. Use **Reaction and poll notifications** to choose whose reactions and votes trigger notifications, whether to show previews, and which sound to play.

In **Settings → Active devices**, see the current BB session and other Telegram devices. Confirm an individual sign-out to terminate that session.

In the Telegram sidebar, open **Settings** to see media cache usage, save a
limit in MiB, or choose **Clear cache**. BB checks the limit every minute
while Telegram is connected and asks TDLib to remove older cached media
first. Automatic cleanup gives recent files a short grace period. The
default limit is 512 MiB. Clearing cached media preserves the session and
message history. Photos and avatars continue to load when they enter view.

**Mark read** and **Mark unread** in **Chat details** sync the read state with
Telegram. Opening a conversation does not by itself send a read receipt. With focus in the conversation, use **Alt+Shift+I** for Chat details and **Alt+Shift+F** for conversation search. These shortcuts leave text inputs and open dialogs alone. Press **Escape** to close Chat details.

BB keeps an encrypted local record of incoming messages it has received in
ordinary private chats. When Telegram reports deletion, BB leaves the message
in the conversation with a local-retention label. For a supported incoming
one-view photo or MP4/WebM video up to 32 MiB, choose **View and save** in the
conversation. BB saves an encrypted copy on this Mac and marks the media viewed
in Telegram. Use **Open saved photo** or **Open saved video** after it expires.
The copies survive **Clear cache**. Other disappearing or protected media keep a
placeholder. Signing out removes the local records and their saved media.

Open **Agents** in the Telegram sidebar to manage optional reviews of
owner-authored text and message sending. Sending always requires its own
BB dialog. Turning off a permission cancels requests still awaiting approval.
It cannot recall a message already submitted to Telegram.

A BB thread can have one pending Telegram approval at a time across both
tools.

Use **Attach photo** to choose a JPEG of up to 64 MiB and add a caption. BB
resizes and compresses the photo locally to fit 512 KiB and 1600 × 1600 pixels.
The composer previews the result before sending. Use **Attach document** to
preserve the original file. Photo replies are not available in this version.

Use the trash button next to a sent or received message to see which
deletion options Telegram allows for that message. Select **Delete for me**
or **Delete for everyone** to apply the chosen option.

Use the pin button next to a message to pin or unpin it in the chat. Pinning
does not send a notification. Telegram checks whether you have permission to
manage pinned messages in that chat.

Use **New topic** or **Topic settings** to create, rename, close, reopen, pin or unpin a forum topic when Telegram grants that permission.

When TDLib reports a forum group, **Topics** shows recent topics and searches
them by name. Use **Load more topics** to continue through the list or search results. Open a topic to see live updates and scroll up to load older messages. Use **Send to topic**
to post text or an attached document directly. **Copy topic reference** copies the arguments
`recipientId` and `forumTopicId` for an agent draft. The approval form
shows the selected topic before sending. Use **Reply** on a message to reply inside the topic, or copy its individual reference for an agent read request. For an agent read request, use
the same IDs as `chatId` and `forumTopicId`. BB lists eligible messages
from all senders in that topic through `makosh_telegram_read_history` after
you enable AI read access in the group's properties. Pass the same topic ID
and dates when following the `before` cursor, including after an empty page.
The agent can also find a topic by name with `makosh_telegram_find_topics`
using the ID of a group with AI read access.

Open **Members** in **Chat details** to browse or search group and channel members where Telegram permits access. BB displays the role and any available member tag.

Use **Invite links** in **Chat details** to list, copy, create, and revoke your own invite links when Telegram grants access. A new link can expire, limit uses, or require approval. **Join requests** lists pending applicants and lets an authorized administrator approve or decline a request.

Open **Member permissions** in group **Chat details** to see default permissions or change them with the required Telegram administrator rights.

Open **Recent actions** in **Chat details** for the administrator journal in a supergroup or channel. Search or load more actions from the Telegram event log.

Select **Comments** under a channel post with a linked discussion to open replies, load older comments, or post a text comment when Telegram grants permission in the linked group.

Channels can always be browsed. The composer and agent recipient picker only
offer posting where TDLib reports channel ownership or administrator posting
rights. The server checks those rights again before sending.

### Live approval check

In a test BB profile, connect Telegram and enable agent sending from
**Agents**. In a new BB thread, ask the agent to call
`makosh_telegram_request_send` with `recipientQuery: "Saved Messages"` and a
unique synthetic message. Check the exact recipient and text in the BB form
before selecting **Confirm send**. Confirm
that the synthetic message appears exactly once in Saved Messages. To test
cancellation, use a different synthetic marker and cancel the form. The message must remain absent. Pending BB approval forms
expire after two minutes.

For a live read check, write two short synthetic notes with a shared unique
marker in Saved Messages. In **Agents**, enable **Allow agents to request my
original Telegram messages**. In a test BB thread, ask the agent to call
`makosh_telegram_request_read` with that marker as `textQuery` and
`maxMessages: 2`. Preview and confirm authorship for both notes, then
approve the batch in BB. Verify that the tool returned exactly those
two synthetic notes. Repeat and cancel the review to verify that it returns
no notes. Ask the agent to report only the count from each test.

Use a group and a channel created for testing to check posting outside
Saved Messages. The local `createPrivateChatSpace` client RPC creates an
empty private group or channel from a title and a kind of `Group` or `Channel`.
The local `deleteOwnedChatSpace` client RPC permanently deletes a group or
channel and its history after checking its exact ID, title, kind and ownership.
Connect with an account that can post in both. In separate
requests, pass each destination's copied chat reference and a distinct
synthetic marker to the send tool. Review the destination and text, approve,
then check each destination for exactly one copy of its marker. For forum
topics, connect a test profile using a TDLib build that supports topics,
and verify that the marker appears in the reviewed topic.

In **Agents**, **Disconnect Telegram** closes the local client so you can
reconnect to the same session. **Sign out of Telegram** ends this session,
clears the TDLib cache and turns off agent access. Scan a new QR to sign in again.
Pending agent requests are cancelled and the TDLib session is closed.
**Connect Telegram** reopens the saved session without signing in again.

**Chat details** can move a chat from the main list to Archive or restore it.
Telegram checks whether the move is allowed, and the current conversation
remains open while its list updates.

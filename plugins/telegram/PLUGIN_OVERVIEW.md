Telegram via TDLib on macOS. QR sign-in, chats and media. AI reads enabled chats. Agent sends require BB confirmation.

Open **Telegram** in BB and choose **Connect Telegram**. Scan the QR code from
**Settings → Devices → Link Desktop Device** in Telegram. Enter the Telegram
two-step verification password in BB if requested. The plugin keeps an
encrypted TDLib session in the BB data directory.

Browse the main chat list, archive and Telegram folders. Dotted folder names
form a nested tree. Conversations initially load up to 50 recent messages.
Scroll toward the top to load earlier history. Search can open a matching
message with its surrounding history. Group and channel settings, forum topics
and member controls are available through their details.

Read text, captions, sender names, photos, albums, stickers, GIFs and voice
notes. Supported videos stream with seeking. Voice notes can be transcribed
locally, and permitted agent reads include the transcript. The owner can send
messages and attachments directly from the composer. File uploads stream through
the Mac with progress and cancellation. Telegram's account and TDLib limits
apply, including Premium requirements for larger uploads.

In **Chat details**, select **Allow AI to search and read this chat** to enable
agent search and reading of messages from all senders in that conversation.
Those reads use the granted access without an approval dialog. Other chats
remain excluded from agent history tools. Telegram content protection applies.

In **Agents**, the optional send tool opens a BB dialog with the draft and
recipient for confirmation. The plugin rechecks the destination before
dispatch. The optional original-message review tool separately lets the owner
approve sharing their own eligible text. Approvals use the BB dialog.

Messages already received by BB in private chats can remain locally with a
deleted marker after Telegram reports removal. Supported one-view photos and
videos can be saved locally while viewing and opened after expiry. Local
retention and Telegram's media restrictions are described in the README.

**Telegram settings** shows media cache usage, size and age limits, and
**Clear cache**. Cleaning downloaded media preserves the Telegram session.
Mini Apps open in an isolated frame and review requested sharing or sending
actions. Their macOS SecureStorage uses Keychain, scoped to the BB profile,
Telegram account and bot.

The Mac running BB needs TDLib and Python 3 at /usr/bin/python3. The plugin
looks for libtdjson.dylib in the standard Apple Silicon and Intel Homebrew
locations. Set MAKOSH_TDJSON_PATH for another installation. Set
MAKOSH_TELEGRAM_CREDENTIALS_FILE to a private file owned by the BB server user
containing MAKOSH_TELEGRAM_API_ID and MAKOSH_TELEGRAM_API_HASH. Restart the BB
server after changing its environment.

Voice and video calls and story creation and publication are outside the
current development scope. Story viewing is supported. Paid-message and Stars
development is frozen at the current implementation. See README.md for setup
and individual features, and DESKTOP_PARITY.md for verification gaps.

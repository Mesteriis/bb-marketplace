Sign in with a QR code, read chats, and send text in BB through TDLib on macOS. Agent requests require approval.

Open **Telegram** in BB and choose **Connect Telegram**. Scan the code from
**Settings → Devices → Link Desktop Device** in Telegram on your phone.
If prompted, enter your Telegram two-step verification password in BB.

The page loads chats in batches from the main list, archive or selected Telegram folder and up to 50 recent
messages per conversation on first open. Scroll up to load older history automatically. It displays text, media captions, web links, sender names and the latest pinned message. Deletions from another Telegram client are reflected in the open conversation. Direct conversations show the read status of outgoing messages.
Chat search combines known local chats with Telegram server results. In a conversation search, open a result to see the messages around it. Click the pinned message banner or a reply quote to open the surrounding messages. Photos load when visible in history, search results, and the surrounding messages. Click a photo to enlarge it. BB streams document downloads from the Mac to the browser. The download route accepts files up to 4 GiB when the installed TDLib exposes their size and supports downloading them. TDLib 1.8.0 uses 32-bit file sizes, so upgrade it for larger Telegram files. Use **Attach document** to stream a file to the Mac for sending. BB shows how much data has reached the Mac, then waits separately for Telegram to confirm delivery. You can cancel while BB is still receiving the file. Uploads support up to 2000 MiB for standard accounts and up to 4000 MiB with Telegram Premium and a compatible TDLib. There is also a separate demo with fictional data.

On the Mac running the BB server, install TDLib and make sure `/usr/bin/python3` runs. The plugin looks for
`libtdjson.dylib` in the standard Apple Silicon and Intel Homebrew TDLib directories.
For another installation, set `MAKOSH_TDJSON_PATH` in the BB server environment to the library path.
Set `MAKOSH_TELEGRAM_CREDENTIALS_FILE` in that same environment to the path of your Makosh credentials file.
The file must be owned by the user running BB, readable only by that user, and contain two lines,
`MAKOSH_TELEGRAM_API_ID=<decimal ID>` and `MAKOSH_TELEGRAM_API_HASH=<32-character hex hash>`.
Restart the BB server after changing its environment. The plugin stores an encrypted TDLib session in its BB data directory. The owner can send text and reply directly. The composer checks text, photo, and file permissions separately in groups and channels. The optional agent send tool displays the
exact draft and asks the owner to pick a recipient and verify with macOS. The form displays the Telegram sender identity for the selected recipient. An exact recipient ID can be supplied from a copied message reference. Use a trusted BB profile because BB client RPC can read the data.

An optional reading tool can share one of the owner’s original text notes
from Saved Messages or a matched chat after explicit approval and macOS
verification. Only messages sent as the signed-in user are eligible. Telegram content protection prevents sharing. Use **Copy message reference** in the conversation to copy the chat and message IDs for a request about a specific message.

Agent tools are off by default. Changes to which tools BB advertises apply when its provider session is next started or resumed. Disabling access also cancels pending requests.

Agents can propose a reply to a message previously shared in the same BB
thread. The reply has a separate owner approval.

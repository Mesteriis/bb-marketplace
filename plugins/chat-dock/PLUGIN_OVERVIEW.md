BB Chat Dock adds a **ChatGPT** page to BB for handing text from a thread to
ChatGPT. You always send the message yourself.

## What you get

- **Вставить в ChatGPT…** in the text-selection menu of assistant messages:
  it stages the exact text you highlighted.
- A **ChatGPT** page in the sidebar with the staged text, its source, a field
  to edit it, and **Скопировать контекст**. This manual mode is the default.
- An opt-in embedded mode, kept in memory until the plugin is disabled or BB restarts. With it on, Browser tabs on `https://chatgpt.com`
  get a toolbar control that shows the text and the open conversation and
  appends the text to that conversation's draft.

## Limits you should know

- The embedded mode is off by default. BB's Browser keeps one sign-in for all
  tabs, and BB's agent browser tools can open, drive and capture tabs with it.
  If you sign in to ChatGPT inside BB, agents on that computer can technically
  read your conversations. The plugin cannot prevent this.
- Insertion works only in BB Desktop, in an existing conversation. A changed
  conversation, a reload, a redirect or an unknown editor cancels it; nothing
  is written and the clipboard is left alone.
- The plugin does not read the draft, so it reports "handed to the editor",
  never "inserted". Insertion is verified on a test page, not on the live site.

No agent tools, CLI, RPC, settings or storage. Staged text stays in memory.

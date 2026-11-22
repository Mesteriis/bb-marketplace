BB Chat Dock adds a **ChatGPT** page to BB with chatgpt.com inside it, shown
by a window of the plugin's own that is glued to the page and keeps you signed
in. You hand text from a thread to the window and confirm the insert
there. You always send the message yourself.

## What you get

- **Вставить в ChatGPT…** in the text-selection menu of assistant messages:
  it stages the exact text you highlighted.
- A **ChatGPT** page in the sidebar: chatgpt.com on the left, and on the
  right the staged text, its source, a field to edit it, **Скопировать
  контекст**, and **Передать в ChatGPT**.
- The ChatGPT window has no address bar, frame or Dock icon, is fixed to
  `https://chatgpt.com`, sits exactly on the page's area, follows BB's window
  and hides when the page does. Its sign-in persists and is kept apart from
  BB's Browser. A
  panel at its bottom shows the text and the open conversation; **Вставить в
  черновик** appends the text to that conversation's draft.

## Limits you should know

- Works in BB Desktop only; in BB's web UI in a browser the window is not
  glued to the page. BB menus that open over the ChatGPT area appear under it. Browser chrome
  is assumed to be above and left of the page.
- macOS 14+ with Xcode or the Command Line Tools: the window is compiled on
  your Mac the first time you open it.
- BB's agent browser tools cannot reach the window, but apps with full macOS
  rights (UI automation) can, like any window. Agents can open the window or
  show a text in its panel through the plugin's RPC; only your press in the
  window inserts it.
- A changed conversation, a reload or an unknown editor cancels the insert;
  nothing is written. The plugin does not read the draft, so it reports
  "handed to the editor", never "inserted". Verified on synthetic pages in
  WebKit and Chromium, not on the live site.

No settings, CLI commands, agent tools or storage. Staged text stays in memory.

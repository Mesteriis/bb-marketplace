Makosh Commander is an experimental two-pane file manager for BB. It works
with files on every connected BB host and on SFTP servers reached through
Remote Hub, where your SSH profiles and secrets stay.

## What you get

- Two panes with tabs, keyboard control (F3 view, F4 edit, F5 copy, F6
  move, F7 directory, F8 delete) and a virtual list that shows the first
  page of a large directory at once and keeps the cursor while the rest
  loads.
- Plans before changes: copy, move, delete, rename and directory creation
  show a plan you confirm. Jobs run in a queue that survives a reload or a
  BB restart, asks you about conflicts, and can retry unfinished items.
- Compare directories by size and time or by SHA-256, and compute a file's
  SHA-256.
- Sync two directories left to right, right to left or both ways. Newer
  files on the target are kept; deletions are a separate plan you confirm
  on its own.
- Search by name, mask, a safe regex subset, metadata or content.
- Batch rename by template and counter or by find and replace.
- View text, hex and images (F3). Edit a file (F4) and write it back; a
  file changed meanwhile is a conflict you can resolve by saving beside it.
- Open ZIP and TAR archives as a panel and extract them, including
  encrypted ZIP with a password you enter. Creating archives is not
  available yet.
- SFTP through Remote Hub: you grant Commander read or write access per
  profile in Remote Hub. Remote reads that cost a lot ask you to confirm
  the size first.
- A thread tab, a `bb makosh-commander` CLI (endpoints, ls, plan, run,
  jobs, cancel) and agent tools. An agent works only within the paths and
  rights you grant to its thread, sees text or hex rather than images, and
  has no access to archives.

## Limits

- Experimental. The archive helper ships for macOS on Apple silicon only.
- Symbolic links are listed, never followed when writing.

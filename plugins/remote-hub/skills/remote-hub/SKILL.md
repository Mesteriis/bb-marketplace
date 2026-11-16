---
name: remote-hub
description: Inspect the Remote Hub helper status and the echo round trip. SSH and RDP connections do not exist in this stage.
---

# Remote Hub

Remote Hub is an experimental SSH/RDP connection manager for BB. This stage
ships only the scaffold: a Rust helper with a verified stdio protocol and an
echo session on a real PTY.

## What works now

- The Rust helper (helper/) owns sessions and reaps every child on close,
  stdin EOF or SIGTERM.
- Open the Remote Hub tab to see the helper status and try the echo console.

## Not yet

No SSH, RDP, saved profiles, credentials, agent tools or CLI. Do not claim a
remote connection works until a later stage ships it.

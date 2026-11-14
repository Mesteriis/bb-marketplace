This release is groundwork. It installs, opens, and shows that no mail account
is connected. Reading and sending mail come in later releases.

## What you get

- A **Mail** page in the left sidebar.
- The page lists the mail accounts connected to this BB. It stays empty,
  because this version has no way to connect one.

## What it does not do yet

It cannot connect an account, and it cannot read, search, or send mail. It
adds no agent tools, no skills, and no `bb` command.

## How it works

The plugin runs inside your BB server and keeps its state in its own plugin
storage. It contacts no mail server and no other external service.

## Requirements

BB 0.49 or later. No account, API key, or separate install.

## Source

The code is MIT licensed at https://github.com/Mesteriis/makosh-bb.

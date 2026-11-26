# Third-party notices

## BB components

The components/ui/ directory and lib/utils.ts vendor UI component source
generated from the [BB component registry](https://github.com/get-bb/bb). BB
and that component source are distributed under the MIT License; the copies
here are the ones already shipped in the Makosh Zoom plugin.

## GitWand

The patches in `patches/` modify, and `bridge-src/` and the generated
`dispatch.rs` call into, GitWand by Laurent Guitton:
https://github.com/devlint/GitWand (pinned in `upstream.lock.json`).
`patches/0001-bridge-crate.patch` adds `watch_repo_start_for_label`, adapted
from GitWand's `watch_repo_start` (`apps/desktop/src-tauri/src/commands/watcher.rs`).

MIT License

Copyright (c) 2026 Laurent Guitton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The runtime archive built by `scripts/build-runtime.ts` carries GitWand's
`LICENSE` and a `NOTICES` file listing the Rust crates and JavaScript packages
it contains.

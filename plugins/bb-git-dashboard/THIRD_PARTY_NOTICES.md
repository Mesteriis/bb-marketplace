# Third-party notices

## bb-github-actions

- Source: https://github.com/pers0na2dev/bb-github-actions, revision 337890140c9503fedde7dd7da8e8ea4ed24c7f0b (vendored in this repository as `plugins/github-actions`).
- Used in: `src/core/ci/dispatch.ts` (reading `workflow_dispatch` inputs; adapted to take a parsed document).
- License: MIT

```
MIT License

Copyright (c) 2026 pers0na2dev

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
```

## bb-git-history

- Source: https://github.com/yusuf8834/bb-git-history, revision 816bc8c329bcea6276cd9be5fd19dec1926aa584 (vendored in this repository as `plugins/git-history`).
- Used in: `src/core/history/graph.ts` (lane layout, as is), `src/ui/history/graph-cell.tsx` (row geometry of the graph), `src/core/history/parse.ts` (parsing of Git output, adapted), `tests/history-graph.test.ts` (tests, moved to node:test).
- License: MIT

```
MIT License

Copyright (c) 2026 Yusuf Akbulut

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
```

## bb-github-pr-dashboard

- Source: https://github.com/ahsan7162/bb-github-pr-dashboard, upstream revision e1e1881a6beddb7419bf117c9bd1743ada73a22e (vendored in this repository as `plugins/bb-github-pr-dashboard`; ported from that directory as of repository commit 898660bcd3b467d73b5d879d1185f5be06191264).
- Used in: `src/core/pulls/model.ts` (inbox row, blockers and search; adapted to every forge), `src/core/pulls/github.ts` (GitHub GraphQL mapping, checks and stacks), `src/core/pulls/watch.ts` (alert diffing and push text), `src/core/pulls/queries.ts` (GraphQL text of the tabs and the watcher), `src/core/pulls/{detail,github-detail,diff,review,prompt,agent-target}.ts` (pull request detail, its GitHub mapping, files and line anchors, review rules, agent prompts and thread target), `tests/pulls-ported.test.ts` and `tests/pulls-detail-ported.test.ts` (tests).
- License: MIT

```
MIT License

Copyright (c) 2026 Muhammad Ahsan

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
```

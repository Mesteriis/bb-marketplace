## What changed

<!-- One or two sentences on the outcome, and why. -->

## How it was checked

<!-- Commands you ran and what they printed; what you tried in a running BB. -->

## Checklist

- [ ] `npm run check` and `npm run build` pass in every plugin I touched
- [ ] `node scripts/check-manifests.mjs` passes
- [ ] New behavior has a test
- [ ] `src/core` and `src/ui` import no host code
- [ ] Store text (`bb.description`, `PLUGIN_OVERVIEW.md`, `marketplace.json`) and docs match the behavior
- [ ] The plugin's `CHANGELOG.md` has a line under `Unreleased`
- [ ] No real addresses, message text, tokens, or passwords anywhere in the change
- [ ] Ported or vendored code is listed in `THIRD_PARTY_NOTICES.md`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectPlugins, usesBun} from './ci-matrix.mjs';
const dirs=['plugins/mail','plugins/telegram'];
test('a dependency PR selects only its package',()=>assert.deepEqual(selectPlugins(dirs,['plugins/mail/package-lock.json']),['plugins/mail']));
test('renames select both packages',()=>assert.deepEqual(selectPlugins(dirs,['plugins/mail/a.ts','plugins/telegram/a.ts']),dirs));
test('catalog and workflow edits do not fan out 91 jobs',()=>assert.deepEqual(selectPlugins(dirs,['marketplace.json','.github/workflows/ci.yml']),[]));
test('full audit selects all packages',()=>assert.deepEqual(selectPlugins(dirs,[],true),dirs));
test('a package whose scripts call bun needs Bun on the runner',()=>{
 assert.equal(usesBun({test:'bun test tests',check:'npm run typecheck && npm test'}),true);
 assert.equal(usesBun({check:'npm run typecheck&&bun run test'}),true);
 assert.equal(usesBun({test:'node a.mjs && bunx tsc'}),true);
});
test('a package that never calls bun does not get it',()=>{
 assert.equal(usesBun({build:'bb plugin build',test:'vitest run',bundle:'node scripts/bundle.mjs --bun-types'}),false);
 assert.equal(usesBun({test:'node scripts/bun.mjs'}),false);
 assert.equal(usesBun(undefined),false);
});

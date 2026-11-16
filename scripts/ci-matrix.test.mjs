import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectPlugins} from './ci-matrix.mjs';
const dirs=['plugins/mail','plugins/telegram'];
test('a dependency PR selects only its package',()=>assert.deepEqual(selectPlugins(dirs,['plugins/mail/package-lock.json']),['plugins/mail']));
test('renames select both packages',()=>assert.deepEqual(selectPlugins(dirs,['plugins/mail/a.ts','plugins/telegram/a.ts']),dirs));
test('catalog and workflow edits do not fan out 91 jobs',()=>assert.deepEqual(selectPlugins(dirs,['marketplace.json','.github/workflows/ci.yml']),[]));
test('full audit selects all packages',()=>assert.deepEqual(selectPlugins(dirs,[],true),dirs));

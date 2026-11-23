// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';
import app from '../app';

test('Makosh Sidebar registers its thread list without progress banners above the composer',async()=>{
 const definition=await loadPluginApp(()=>Promise.resolve({default:app}));
 expect(definition.threadLists.map(list=>list.id)).toContain('tree');
 expect(definition.composerCustomizations.flatMap(customization=>customization.banners??[])).toEqual([]);
});

import {expect,test} from 'vitest';
import {activeThreads} from '../src/core/active';
const thread=(id:string,status='idle',parentThreadId:string|null=null)=>({id,status,parentThreadId,projectId:'p',title:id,titleFallback:null,isArchived:false,isHidden:false,isPinned:false,isUnread:false,latestAttentionAt:100});
test('includes work and unread results, removes results when read',()=>{
 const rows=[thread('busy','active'),{...thread('unread'),isUnread:true},thread('read'),thread('start','starting'),thread('stop','stopping')];
 expect(activeThreads(rows).map(n=>n.thread.id)).toEqual(['busy','start','stop','unread']);
 expect(activeThreads([{...thread('unread'),isUnread:false}])).toEqual([]);
});
test('keeps full subtrees under qualifying parents and only ancestry for a qualifying child',()=>{
 const rows=[thread('parent','active'),thread('child','idle','parent'),thread('grandchild','idle','child'),thread('context'),thread('worker','active','context'),thread('unrelated-sibling','idle','context')];
 const view=activeThreads(rows);
 expect(view.map(n=>n.thread.id)).toEqual(['context','parent']);
 expect(view[0]?.children.map(n=>n.thread.id)).toEqual(['worker']);
 expect(view[1]?.children[0]?.children.map(n=>n.thread.id)).toEqual(['grandchild']);
});
test('excludes archived and internal helper threads, deduplicates shared ancestry',()=>{
 const rows=[thread('parent'),thread('one','active','parent'),thread('two','active','parent'),{...thread('helper','active'),isHidden:true},{...thread('archived','active'),isArchived:true}];
 expect(activeThreads(rows).map(n=>n.thread.id)).toEqual(['parent']);
 expect(activeThreads(rows)[0]?.children.map(n=>n.thread.id)).toEqual(['one','two']);
});
test('filters keep ancestry while excluding unrelated siblings and include pending questions',()=>{
 const rows=[thread('parent'),thread('worker','active','parent'),{...thread('result','idle','parent'),isUnread:true},{...thread('question'),hasPendingInteraction:true}];
 expect(activeThreads(rows,'running')[0]?.children.map(n=>n.thread.id)).toEqual(['worker']);
 expect(activeThreads(rows,'unread')[0]?.children.map(n=>n.thread.id)).toEqual(['result']);
 expect(activeThreads(rows).map(n=>n.thread.id)).toContain('question');
 expect(activeThreads([{...thread('failed-plan'),planAttention:'error' as const}]).map(n=>n.thread.id)).toEqual(['failed-plan']);
});

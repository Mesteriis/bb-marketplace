import {expect,test} from 'vitest';
import {todayThreads} from '../src/core/active';
const thread=(id:string,status='idle',parentThreadId:string|null=null)=>({id,status,parentThreadId,projectId:'p',title:id,titleFallback:null,isArchived:false,isHidden:false,isPinned:false,isUnread:false,latestAttentionAt:100});
test('All includes idle and read threads; unread only includes unread results',()=>{
 const rows=[thread('busy','active'),{...thread('unread'),isUnread:true},thread('read'),thread('start','starting'),thread('stop','stopping')];
 expect(todayThreads(rows).map(n=>n.thread.id)).toEqual(['busy','read','start','stop','unread']);
 expect(todayThreads([{...thread('unread'),isUnread:false}],'unread')).toEqual([]);
});
test('All includes complete eligible subtrees',()=>{
 const rows=[thread('parent','active'),thread('child','idle','parent'),thread('grandchild','idle','child'),thread('context'),thread('worker','active','context'),thread('unrelated-sibling','idle','context')];
 const view=todayThreads(rows);
 expect(view.map(n=>n.thread.id)).toEqual(['context','parent']);
 expect(view[0]?.children.map(n=>n.thread.id)).toEqual(['unrelated-sibling','worker']);
 expect(view[1]?.children[0]?.children.map(n=>n.thread.id)).toEqual(['grandchild']);
});
test('excludes archived and internal helper threads, deduplicates shared ancestry',()=>{
 const rows=[thread('parent'),thread('one','active','parent'),thread('two','active','parent'),{...thread('helper','active'),isHidden:true},{...thread('archived','active'),isArchived:true}];
 expect(todayThreads(rows).map(n=>n.thread.id)).toEqual(['parent']);
 expect(todayThreads(rows)[0]?.children.map(n=>n.thread.id)).toEqual(['one','two']);
});
test('filters keep ancestry while excluding unrelated siblings and include pending questions',()=>{
 const rows=[thread('parent'),thread('worker','active','parent'),{...thread('result','idle','parent'),isUnread:true},{...thread('question'),hasPendingInteraction:true}];
 expect(todayThreads(rows,'running')[0]?.children.map(n=>n.thread.id)).toEqual(['worker']);
 expect(todayThreads(rows,'unread')[0]?.children.map(n=>n.thread.id)).toEqual(['result']);
 expect(todayThreads(rows).map(n=>n.thread.id)).toContain('question');
 expect(todayThreads([{...thread('failed-plan'),planAttention:'error' as const}]).map(n=>n.thread.id)).toEqual(['failed-plan']);
});

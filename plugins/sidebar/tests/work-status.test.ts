import {expect,test} from 'vitest';
import {attentionThreads,waitingReason,searchProjects} from '../src/core/work-status';
import {todayThreads} from '../src/core/active';
import type {TreeNode} from '../src/core/tree';
const thread=(id:string,status='idle')=>({id,title:id,titleFallback:null,projectId:'p',parentThreadId:null,status,isArchived:false,isHidden:false,isPinned:false,isUnread:false,latestAttentionAt:1});
test('attention prioritizes questions and preserves ancestors in its filter',()=>{
 const root=thread('root'),question={...thread('question'),hasPendingInteraction:true,parentThreadId:'root'},error=thread('error','error');
 expect(attentionThreads([error,question,thread('worker','active')]).map(t=>t.id)).toEqual(['question','error']);
 expect(todayThreads([root,question,error],'attention').map(n=>n.thread.id)).toContain('root');
 expect(waitingReason([thread('worker','active'),question,error])).toBe('Ждёт 3 субтреда');
});
test('project search keeps ancestry and retains the full subtree of a matching folder',()=>{
 const leaf:TreeNode={key:'leaf',label:'Example',project:{id:'p',name:'Example'},children:[],threads:[],threadCount:0,latestAttentionAt:0};
 const root:TreeNode={...leaf,key:'root',label:'Work',project:null,children:[leaf]};
 expect(searchProjects([root],'example')[0]?.children).toEqual([leaf]);
 expect(searchProjects([root],'work')).toEqual([root]);
 expect(searchProjects([root],'missing')).toEqual([]);
});

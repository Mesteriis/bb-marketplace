// @vitest-environment jsdom
import {afterEach,expect,test} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import type {ThreadNode} from '../src/core/tree';
import {ThreadBranch} from '../src/ui/thread-branch';
afterEach(cleanup);
const node=(id:string,status='idle',children:ReturnTypeNode[]=[]):ReturnTypeNode=>({thread:{id,projectId:'p',title:id,titleFallback:null,parentThreadId:null,isArchived:false,isPinned:false,latestAttentionAt:1,status},children});
interface ReturnTypeNode {thread:{isUnread?:boolean;id:string;projectId:string;title:string;titleFallback:null;parentThreadId:null;isArchived:boolean;isPinned:boolean;latestAttentionAt:number;status:string};children:ReturnTypeNode[]}
test('collapsing hides live descendants, expanding restores all',()=>{
 const tree=node('parent','idle',[node('idle'),node('starting','starting'),node('middle','idle',[node('deep-active','active')]),node('stopping','stopping')]);
 const slot=render(<ThreadBranch node={tree} depth={0} renderRow={(t,d,toggle)=><div data-depth={d}>{toggle}<a href={'/'+t.id}>{t.id}</a></div>}/>);
 fireEvent.click(slot.getByRole('button',{name:'Свернуть сабтреды: parent'}));
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent']);
 fireEvent.click(slot.getByRole('button',{name:'Развернуть сабтреды: parent'}));
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent','idle','starting','middle','deep-active','stopping']);
 expect(slot.queryByRole('button',{name:/сабтреды: idle/})).toBeNull();
});
test('status updates do not reopen a manually collapsed subtree',()=>{
 const row=(t:ThreadNode['thread'],d:number,toggle:React.ReactNode)=><div>{toggle}<a href={'/'+t.id}>{t.id}</a></div>;
 const slot=render(<ThreadBranch node={node('parent','idle',[node('child','active')])} depth={0} renderRow={row}/>);
 fireEvent.click(slot.getByRole('button',{name:'Свернуть сабтреды: parent'}));
 slot.rerender(<ThreadBranch node={node('parent','idle',[node('child','starting')])} depth={0} renderRow={row}/>);
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent']);
});

test('active section starts folded and expands running descendants on demand',()=>{
 const slot=render(<ThreadBranch node={node('parent','active',[node('idle'),node('busy','active')])} depth={0} initialCollapsed renderRow={(t,d,toggle)=><div>{toggle}<a href={'/'+t.id}>{t.id}</a></div>}/>);
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent']);
 fireEvent.click(slot.getByRole('button',{name:'Развернуть сабтреды: parent'}));
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent','idle','busy']);
});

test('unread descendants respect the collapsed parent',()=>{
 const tree=node('context','idle',[{...node('result'),thread:{...node('result').thread,isUnread:true}}]);
 const row=(t:ThreadNode['thread'],d:number,toggle:React.ReactNode)=><div>{toggle}<a href={'/'+t.id}>{t.id}</a></div>;
 const slot=render(<ThreadBranch node={tree} depth={0} initialCollapsed renderRow={row}/>);
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['context']);
});
test('pending questions respect collapse and return on expansion',()=>{
 const child={...node('question'),thread:{...node('question').thread,hasPendingInteraction:true}};
 const slot=render(<ThreadBranch node={node('parent','idle',[child])} depth={0} initialCollapsed renderRow={(t,d,toggle)=><div>{toggle}<a href={'/'+t.id}>{t.id}</a></div>}/>);
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent']);
 fireEvent.click(slot.getByRole('button',{name:'Развернуть сабтреды: parent'}));
 expect(slot.getAllByRole('link').map(a=>a.textContent)).toEqual(['parent','question']);
});

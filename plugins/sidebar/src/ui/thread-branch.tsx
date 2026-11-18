import {useState, type ReactNode} from 'react';
import type {ThreadNode} from '../core/tree';
import {runningThreads} from '../core/presentation';
interface Props {
 showUnread?:boolean;
 initialCollapsed?:boolean;
 node:ThreadNode;
 depth:number;
 renderRow:(thread:ThreadNode['thread'],depth:number,toggle:ReactNode)=>ReactNode;
}
/** A parent remains navigable while its descendant list folds independently. */
export function ThreadBranch({node,depth,renderRow,initialCollapsed=false,showUnread=false}:Props) {
 const [collapsed,setCollapsed]=useState(initialCollapsed);
 const hasChildren=node.children.length>0;
 const toggle=hasChildren?<button type="button" className="subthread-toggle" aria-expanded={!collapsed} aria-label={`${collapsed?'Развернуть':'Свернуть'} сабтреды: ${node.thread.title??node.thread.titleFallback??node.thread.id}`} onClick={()=>setCollapsed(!collapsed)}>
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" style={{transform:collapsed?'rotate(-90deg)':undefined}}><path d="m3 4.5 3 3 3-3"/></svg>
 </button>:null;
 return <div>{renderRow(node.thread,depth,toggle)}{collapsed
  ?runningThreads(node.children,showUnread).map(thread=><div key={thread.id}>{renderRow(thread,depth+1,null)}</div>)
  :node.children.map(child=><ThreadBranch key={child.thread.id} node={child} depth={depth+1} renderRow={renderRow} initialCollapsed={initialCollapsed} showUnread={showUnread}/>)}</div>;
}

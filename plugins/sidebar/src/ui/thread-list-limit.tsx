import {useEffect,useState,type ReactNode} from 'react';
/** Limits only a folder's direct threads; nested folders are rendered by its parent. */
export function ThreadListLimit({rows,limit=5,depth=0}:{rows:ReactNode[];limit?:number;depth?:number}){
 const [expanded,setExpanded]=useState(false);
 useEffect(()=>setExpanded(false),[limit]);
 const hasMore=rows.length>limit;
 return <>{expanded?rows:rows.slice(0,limit)}{hasMore&&<button type="button" className="thread-list-limit" aria-expanded={expanded} style={{paddingLeft:10+depth*14}} onClick={()=>setExpanded(!expanded)}>{expanded?'Показать меньше':`Показать больше (ещё ${rows.length-limit})`}</button>}</>;
}

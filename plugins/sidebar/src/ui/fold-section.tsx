import { useState, type ReactNode } from 'react';
/** Collapsed sections keep their live work visible without opening idle rows. */
export function FoldSection({label,count,children,running}:{label:string;count:number;children:ReactNode;running:ReactNode}) {
 const [open,setOpen]=useState(false);
 return <section aria-label={label}>
  <button className="section-toggle" aria-expanded={open} onClick={()=>setOpen(!open)}><span className="label">{label}</span><span className="count">{count}</span></button>
  {open?children:running}
 </section>;
}

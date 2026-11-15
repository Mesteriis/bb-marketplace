import React, {useState} from 'react';
export function ErrorNotice({message,onRetry}:{message:string;onRetry:()=>void}){
 const [open,setOpen]=useState(false);
 return <div className="nav-error-notice"><button type="button" aria-label="Ошибка навигации" aria-expanded={open} onClick={()=>setOpen(!open)}>⚠</button>{open&&<div className="nav-popup" role="alert"><strong>Не удалось загрузить навигацию</strong><p>{message}</p><button type="button" onClick={onRetry}>Повторить загрузку</button><button type="button" onClick={()=>setOpen(false)}>Закрыть</button></div>}</div>;
}

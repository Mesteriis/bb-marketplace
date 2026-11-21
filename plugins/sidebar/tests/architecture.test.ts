import {readdirSync,readFileSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,test} from 'vitest';
const root=fileURLToPath(new URL('..',import.meta.url));
function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):/\.tsx?$/.test(entry.name)?[join(dir,entry.name)]:[]);}
test.each(['core','ui'])('%s stays independent of the host and other plugins',layer=>{
 const violations=[];
 for(const file of files(join(root,'src',layer))) {
  const imports=[...readFileSync(file,'utf8').matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g)];
  for(const match of imports) {
   const specifier=match[1]??match[2]??match[3]??match[4]!;
   const target=resolve(file,'..',specifier);
   const local=specifier.startsWith('.')&&['core',...(layer==='ui'?['ui']:[])].some(dir=>target.startsWith(join(root,'src',dir)+sep));
   const allowed=layer==='core'?['zod']:['react','react/jsx-runtime'];
   if(!local&&!allowed.includes(specifier))violations.push(`${relative(root,file)}: ${specifier}`);
  }
 }
 expect(violations).toEqual([]);
});

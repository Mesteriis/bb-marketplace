import {readFileSync, appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export function selectPlugins(directories, paths, full=false) {
 return directories.filter(dir=>full || paths.some(path=>path.startsWith(dir+'/')));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dirs=JSON.parse(readFileSync('.bb/plugins.json','utf8')).plugins.map(p=>p.source.replace(/^\.\//,''));
 if(dirs.some(d=>!/^plugins\/[a-z0-9-]+$/.test(d))) throw new Error('Unsafe plugin directory');
 const full=process.env.FULL_AUDIT==='true';
 const base=process.env.BASE_SHA;
 const head=process.env.HEAD_SHA || 'HEAD';
 const paths=base && !/^0+$/.test(base) ? execFileSync('git',['diff','--name-only','--no-renames',base,head],{encoding:'utf8'}).trim().split('\n') : [];
 const mac=new Set(['launchd-jobs','read-aloud-local','dictation-shortcuts']);
 const include=selectPlugins(dirs,paths,full).map(directory=>({directory,runner:mac.has(directory.split('/')[1])?'macos-latest':'ubuntu-latest'}));
 const output=`matrix=${JSON.stringify({include})}\nhas_plugins=${include.length>0}\n`;
 if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,output);
 else process.stdout.write(output);
}

import {access,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

if(process.platform!=='win32')throw new Error('Build the Windows update launcher on Windows with .NET Framework installed.');
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'.local','update-launcher.exe');
const windows=process.env.WINDIR||process.env.SystemRoot||'C:\\Windows';
let compiler;
for(const arch of ['Framework64','Framework']){
 const candidate=path.join(windows,'Microsoft.NET',arch,'v4.0.30319','csc.exe');
 try{await access(candidate);compiler=candidate;break;}catch{}
}
if(!compiler)throw new Error('Cannot find the Windows .NET Framework C# compiler required to build the update launcher.');
await mkdir(path.dirname(output),{recursive:true});
const source=path.join(root,'apps','desktop','lib','update-launcher.cs');
const built=spawnSync(compiler,['/nologo','/target:winexe','/optimize+','/platform:anycpu','/out:'+output,source],{encoding:'utf8',windowsHide:true,shell:false});
if(built.error||built.status!==0)throw new Error('Update launcher compilation failed: '+(built.error?.message||built.stdout||built.stderr));
console.log(output);

import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {zipSync} from 'fflate';
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Release version must be stable semver');
const release=path.join(root,'release'),web=path.join(root,'apps/web/dist'),files={};
await stat(path.join(web,'index.html'));
async function collect(directory,relative=''){
 for(const item of await readdir(directory,{withFileTypes:true})){
  const name=path.posix.join(relative,item.name),file=path.join(directory,item.name);
  if(item.isDirectory())await collect(file,name);
  else if(item.isFile())files[name]=new Uint8Array(await readFile(file));
 }
}
await collect(web);
await writeFile(path.join(release,`DualLink-web-${version}.zip`),zipSync(files,{level:9}));
const assets=[`windows/DualLink-${version}-x64-setup.exe`,`windows/DualLink-${version}-x64-portable.exe`,`DualLink-source-${version}.zip`,`DualLink-web-${version}.zip`];
const lines=[];
for(const name of assets){
 const file=path.join(release,name);if(!(await stat(file)).size)throw Error('Empty release asset: '+name);
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 lines.push(`${hash.digest('hex')}  ${path.basename(name)}`);
}
await writeFile(path.join(release,`SHA256SUMS-${version}.txt`),lines.join('\n')+'\n');
console.log(`Compiled web and SHA256SUMS-${version}.txt generated; upload all four assets and the checksum file together.`);

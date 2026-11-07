// Development-only recovery for networks that stall large non-ranged downloads.
// The downloaded binary is checked against Electron's package SHA256 before caching.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const pkgPath=require.resolve('electron/package.json');
const {version}=JSON.parse(await fs.readFile(pkgPath,'utf8'));
const file=`electron-v${version}-win32-x64.zip`;
const expected=JSON.parse(await fs.readFile(path.join(path.dirname(pkgPath),'checksums.json'),'utf8'))[file];
if(!expected)throw new Error('Missing official checksum');
const url=`https://github.com/electron/electron/releases/download/v${version}/${file}`;
const head=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(20000)});
if(!head.ok)throw new Error(`HEAD ${head.status}`);
const size=Number(head.headers.get('content-length'));
if(!Number.isSafeInteger(size)||size<=0||size>400*1024*1024)throw new Error('Unexpected binary size');
const parsed=new URL(url);parsed.pathname=path.posix.dirname(parsed.pathname);
const cacheKey=crypto.createHash('sha256').update(parsed.toString()).digest('hex');
const cacheRoot=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'electron','Cache'):path.join(os.homedir(),'.cache','electron');
const dir=path.join(cacheRoot,cacheKey);await fs.mkdir(dir,{recursive:true});
const destination=path.join(dir,file),temporary=destination+'.partial';
const handle=await fs.open(temporary,'w');let next=0,finished=0;const step=256*1024,total=Math.ceil(size/step);
try{
  await Promise.all(Array.from({length:16},async()=>{
    while(next<total){const part=next++,start=part*step,end=Math.min(size-1,start+step-1);let done=false;
      for(let attempt=0;attempt<3&&!done;attempt++){
        try{const response=await fetch(url,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(15000)});if(response.status!==206)throw new Error(`Range status ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==end-start+1)throw new Error('Range size mismatch');await handle.write(bytes,0,bytes.length,start);done=true;finished++;if(finished%40===0||finished===total)console.log(`Electron ${version}: ${finished}/${total} chunks`);}
        catch(error){if(attempt===2)throw error;}
      }
    }
  }));
}finally{await handle.close();}
const digest=crypto.createHash('sha256');for await(const bytes of createReadStream(temporary))digest.update(bytes);
if(digest.digest('hex')!==expected)throw new Error('Electron official SHA256 mismatch');
await fs.rename(temporary,destination);console.log(`Verified official Electron ${version} in cache`);

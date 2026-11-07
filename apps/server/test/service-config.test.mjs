import test from 'node:test';
import assert from 'node:assert/strict';
test('direct HTTP IP deployment derives binding, port, cookie and proxy settings',async()=>{
 const {deploymentSettings}=await import('../src/service-config.mjs');
 assert.deepEqual(deploymentSettings('http://203.0.113.8:3080'),{origin:'http://203.0.113.8:3080',host:'0.0.0.0',port:3080,secureCookies:false,trustProxy:0});
 assert.equal(deploymentSettings('http://[2001:db8::1]:8080').host,'::');
 assert.deepEqual(deploymentSettings('assistant.example.com'),{origin:'https://assistant.example.com',host:'127.0.0.1',port:3000,secureCookies:true,trustProxy:1});
 for(const address of ['ftp://example.com','http://user:pass@example.com','http://example.com/api','http://example.com/?x=1','http://example.com:99999'])assert.throws(()=>deploymentSettings(address));
});
test('production HTTP origin uses a usable login cookie without HTTPS upgrade and still checks CSRF',async()=>{
 const {createApp}=await import('../src/app.mjs');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(tmpdir()+'/duallink-http-');const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';let app;
 try{
  app=await createApp({dataDir:dir,publicOrigin:'http://203.0.113.8:3080',startWorker:false});
  app.createUser({email:'http@test.example',password:'Testing-http-42!',name:'HTTP'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'http@test.example',password:'Testing-http-42!'})});
  assert.equal(login.status,200);assert.doesNotMatch(login.headers.get('set-cookie'),/; Secure/i);assert.doesNotMatch(login.headers.get('content-security-policy'),/upgrade-insecure-requests/);
  const cookie=login.headers.get('set-cookie').split(';')[0],body=await login.json();
  const wrong=await fetch(base+'/api/ws-ticket',{method:'POST',headers:{cookie,'X-CSRF-Token':body.csrfToken,Origin:'http://foreign.example'}});assert.equal(wrong.status,403);
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;await app?.close();await rm(dir,{recursive:true,force:true});}
});

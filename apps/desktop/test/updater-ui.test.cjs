const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function setup(){
  const elements=new Map(),calls=[];
  class Element{
    constructor(){this.hidden=false;this.disabled=false;this.textContent='';this.value=0;this.handlers={};this.attributes={};}
    addEventListener(type,callback){this.handlers[type]=callback;}
    setAttribute(name,value){this.attributes[name]=String(value);}
    click(){return this.handlers.click?.();}
  }
  const document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);}};
  let next;
  const api=Object.fromEntries(['Check','Download','Install','Upgrade'].map(kind=>['update'+kind,async()=>{calls.push(kind);if(next instanceof Error)throw next;return next;} ]));
  const window={dualLink:api};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../renderer/updater-ui.js'),'utf8'),{window,document,Number,String,Math});
  return {render:window.DualUpdaterUI.render,element:id=>document.getElementById(id),calls,setNext:value=>{next=value;}};
}

test('update card distinguishes installed/portable packages and shows current/latest versions',()=>{
  const s=setup();s.render({phase:'available',currentVersion:'1.4.0',latestVersion:'1.5.0',kind:'portable',notes:'<script>not HTML</script>'});
  assert.equal(s.element('update-current-version').textContent,'1.4.0');
  assert.equal(s.element('update-latest-version').textContent,'1.5.0');
  assert.match(s.element('update-package-kind').textContent,/便携版/);
  assert.equal(s.element('update-notes').textContent,'<script>not HTML</script>');
  assert.equal(s.element('update-download').hidden,false);
  assert.equal(s.element('update-install').hidden,true);
});

test('download progress is bounded and installation waits for a safe idle state',()=>{
  const s=setup();s.render({phase:'downloading',progress:150,totalBytes:10485760,downloadedBytes:5242880});
  assert.equal(s.element('update-progress').value,100);
  assert.match(s.element('update-progress-text').textContent,/5\.0 MB.*10\.0 MB/);
  assert.equal(s.element('update-check').disabled,true);
  s.render({phase:'downloaded',canInstall:false,blockedReason:'请先结束面试录音'});
  assert.equal(s.element('update-install').hidden,false);assert.equal(s.element('update-install').disabled,true);
  assert.equal(s.element('update-blocked').textContent,'请先结束面试录音');
  s.render({phase:'downloaded',canInstall:true});
  assert.equal(s.element('update-install').disabled,false);assert.equal(s.element('update-blocked').hidden,true);
});

test('buttons invoke only their fixed update operation and failures remain retryable',async()=>{
  const s=setup();s.render({phase:'idle',currentVersion:'1.4.0'});
  s.setNext({phase:'available',latestVersion:'1.5.0'});await s.element('update-check').click();
  assert.deepEqual(s.calls,['Check']);assert.equal(s.element('update-download').hidden,false);
  s.setNext(new Error('下载连接失败'));await s.element('update-download').click();
  assert.deepEqual(s.calls,['Check','Download']);assert.equal(s.element('update-error').textContent,'下载连接失败');
  assert.equal(s.element('update-download').disabled,false);
  s.render({phase:'downloaded',canInstall:true});s.setNext({phase:'installing'});await s.element('update-install').click();
  assert.deepEqual(s.calls,['Check','Download','Install']);assert.equal(s.element('update-install').disabled,true);
});

test('development and unsupported clients explain why update actions are disabled',()=>{
  const s=setup();s.render({phase:'idle',currentVersion:'1.4.0',supported:false});
  assert.equal(s.element('update-check').disabled,true);
  assert.match(s.element('update-status').textContent,/已打包的 Windows 客户端/);
});

test('one-click upgrade invokes the complete main-process flow and permits downloading during active work',async()=>{
  const s=setup();s.render({phase:'available',currentVersion:'1.4.0',latestVersion:'1.5.0',supported:true,blockedReason:'面试会话尚未结束'});
  assert.equal(s.element('update-upgrade').hidden,false);assert.equal(s.element('update-upgrade').disabled,false);
  s.setNext({phase:'downloaded',canInstall:false,blockedReason:'面试会话尚未结束'});
  await s.element('update-upgrade').click();
  assert.deepEqual(s.calls,['Upgrade']);assert.equal(s.element('update-install').disabled,true);
  assert.equal(s.element('update-upgrade').hidden,true);
  s.render({phase:'downloading',supported:true});assert.equal(s.element('update-upgrade').disabled,true);
  s.render({phase:'idle',supported:false});assert.equal(s.element('update-upgrade').disabled,true);
});

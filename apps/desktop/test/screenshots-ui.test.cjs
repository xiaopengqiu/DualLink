const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function setup(){
  const elements=new Map(),calls=[];
  class Element{
    constructor(tag='div'){this.tagName=tag;this.children=[];this.handlers={};this.hidden=false;this.disabled=false;this.textContent='';this.attributes={};}
    addEventListener(type,handler){this.handlers[type]=handler;}
    setAttribute(name,value){this.attributes[name]=String(value);}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=[...children];}
    showModal(){this.open=true;}
    click(){return this.handlers.click?.();}
  }
  const document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement(tag){return new Element(tag);}};
  let next=null;
  const api=Object.fromEntries(['submitScreenshots','discardScreenshot','clearScreenshots','screenshotPreview'].map(name=>[name,async(...args)=>{calls.push([name,...args]);if(next instanceof Error)throw next;return next;}]));
  const window={dualLink:api};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../renderer/screenshots-ui.js'),'utf8'),{window,document,String,Number,Date,Math});
  return {render:window.DualScreenshotsUI.render,element:id=>document.getElementById(id),calls,setNext:value=>{next=value;}};
}
const pending=[{captureId:'first',createdAt:'2026-11-08T10:00:00.000Z',width:1920,height:1080,size:2048},{captureId:'second',createdAt:'2026-11-08T10:01:00.000Z',width:800,height:600,size:1024}];

test('screenshots remain ordered in pending UI and explicit trigger shows configured answer shortcut',()=>{
  const s=setup();s.render({paired:true,settings:{answerShortcut:'Ctrl+Shift+Enter'},screenshots:{pending,batches:[],capturing:false}});
  assert.equal(s.element('screenshots-count').textContent,'2');
  assert.equal(s.element('screenshots-answer-key').textContent,'Ctrl + Shift + Enter');
  assert.equal(s.element('screenshots-submit').disabled,false);
  assert.deepEqual(s.calls,[]);
  assert.match(s.element('screenshots-pending').children[0].children[1].children[0].textContent,/1.*1920/);
  assert.match(s.element('screenshots-pending').children[1].children[1].children[0].textContent,/2.*800/);
});

test('pending screenshot removal, clear and submit use fixed explicit APIs',async()=>{
  const s=setup();s.render({paired:true,settings:{},screenshots:{pending,batches:[]}});
  await s.element('screenshots-pending').children[0].children[3].click();
  assert.deepEqual(s.calls,[['discardScreenshot','first']]);
  await s.element('screenshots-clear').click();await s.element('screenshots-submit').click();
  assert.deepEqual(s.calls,[['discardScreenshot','first'],['clearScreenshots'],['submitScreenshots']]);
});

test('capture in progress blocks submission and upload failures remain visible without losing pending count',async()=>{
  const s=setup();s.render({paired:true,settings:{},screenshots:{pending,batches:[{id:'batch',count:3,status:'failed',error:'网络断开'}],capturing:true}});
  assert.equal(s.element('screenshots-submit').disabled,true);
  assert.match(s.element('screenshots-status').textContent,/截图.*完成/);
  assert.match(s.element('screenshots-batches').children[0].textContent,/3.*网络断开/);
  s.render({paired:true,settings:{},screenshots:{pending,batches:[],capturing:false}});
  s.setNext(new Error('提交失败'));await s.element('screenshots-submit').click();
  assert.equal(s.element('screenshots-error').textContent,'提交失败');
  assert.equal(s.element('screenshots-count').textContent,'2');
  assert.equal(s.element('screenshots-submit').disabled,false);
});

test('pending preview opens only after explicit preview and empty/unpaired controls stay disabled',async()=>{
  const s=setup();s.render({paired:true,settings:{},screenshots:{pending,batches:[]}});
  s.setNext('data:image/png;base64,AAAA');await s.element('screenshots-pending').children[1].children[2].click();
  assert.deepEqual(s.calls,[['screenshotPreview','second']]);
  assert.equal(s.element('preview-image').src,'data:image/png;base64,AAAA');
  assert.equal(s.element('preview-dialog').open,true);
  s.render({paired:false,settings:{},screenshots:{pending:[],batches:[]}});
  assert.equal(s.element('screenshots-submit').disabled,true);
  assert.equal(s.element('screenshots-clear').disabled,true);
});

test('shortcut submission freezes current screenshot edit controls until its batch is sealed',()=>{
  const s=setup();s.render({paired:true,settings:{},screenshots:{pending,batches:[],submitting:true}});
  assert.equal(s.element('screenshots-submit').disabled,true);
  assert.equal(s.element('screenshots-clear').disabled,true);
  assert.equal(s.element('screenshots-pending').children[0].children[3].disabled,true);
});

test('retry remains enabled when every image uploaded but the grouped task submission failed',()=>{
  const s=setup();s.render({paired:true,settings:{},queue:[],screenshots:{pending:[],batches:[{id:'batch',count:2,status:'failed',error:'提交超时'}]}});
  assert.equal(s.element('retry').disabled,false);
  s.render({paired:true,settings:{},queue:[],screenshots:{pending:[],batches:[{id:'batch',count:2,status:'submitted'}]}});
  assert.equal(s.element('retry').disabled,true);
  s.render({paired:true,settings:{},queue:[{captureId:'one'}],screenshots:{pending:[],batches:[]}});
  assert.equal(s.element('retry').disabled,false);
});

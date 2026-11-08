'use strict';
(function(){
  const ui=id=>document.getElementById(id),api=window.dualLink;
  let latest=null,busy=false,localError='';
  const labels={queued:'等待上传',uploading:'正在上传',submitting:'正在提交',submitted:'已提交云端',completed:'已提交云端',failed:'提交失败，等待重试',error:'提交失败，等待重试'};
  const element=(tag,className,value)=>{const node=document.createElement(tag);node.className=className;if(value!==undefined)node.textContent=value;return node;};
  function showError(error){localError=String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');ui('screenshots-error').textContent=localError;ui('screenshots-error').hidden=false;}
  async function action(operation){if(busy)return;busy=true;localError='';if(latest)render(latest);try{const state=await operation();if(state?.screenshots)latest=state;}catch(error){showError(error);}finally{busy=false;if(latest)render(latest);}}
  async function preview(capture,index){try{const image=await api.screenshotPreview(capture.captureId);if(image){ui('preview-title').textContent=`待回答截图 ${index+1}`;ui('preview-image').src=image;ui('preview-dialog').showModal();}}catch(error){showError(error);}}
  function render(state){
    latest=state;const screenshots=state.screenshots||{},pending=screenshots.pending||[],capturing=screenshots.capturing===true,locked=busy||screenshots.submitting===true;
    ui('screenshots-count').textContent=String(pending.length);
    ui('screenshots-answer-key').textContent=(state.settings?.answerShortcut||'Ctrl+Alt+Enter').replaceAll('+',' + ');
    ui('screenshots-submit').disabled=locked||!state.paired||capturing||!pending.length;
    ui('screenshots-clear').disabled=locked||!pending.length;
    ui('retry').disabled=!state.paired||!(state.queue?.length||(screenshots.batches||[]).some(batch=>batch.status!=='submitted'));
    ui('screenshots-status').textContent=screenshots.submitting?'正在封存本次题目，请稍候…':capturing?'请等待当前截图完成，再触发回答。':pending.length?`已缓存 ${pending.length} 张，按顺序作为同一道题提交；提交后新截图进入下一题。`:'截图先保存在本机；确认题目截全后，再按回答快捷键。';
    ui('screenshots-error').hidden=!localError;ui('screenshots-error').textContent=localError;
    const list=ui('screenshots-pending');list.replaceChildren();
    for(const [index,capture] of pending.entries()){
      const row=element('div','screenshot-pending-row');
      row.append(element('span','screenshot-order',String(index+1)));
      const meta=element('div','screenshot-pending-meta');meta.append(element('strong','',`截图 ${index+1} · ${capture.width||'?'} × ${capture.height||'?'}`),element('small','',`${new Date(capture.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${Math.max(1,Math.round((capture.size||0)/1024))} KB`));row.append(meta);
      const view=element('button','button text-button','预览');view.type='button';view.disabled=locked;view.setAttribute('aria-label',`预览待回答截图 ${index+1}`);view.addEventListener('click',()=>preview(capture,index));row.append(view);
      const remove=element('button','button text-button screenshot-remove','移除');remove.type='button';remove.disabled=locked;remove.setAttribute('aria-label',`移除待回答截图 ${index+1}`);remove.addEventListener('click',()=>action(()=>api.discardScreenshot(capture.captureId)));row.append(remove);list.append(row);
    }
    if(!pending.length)list.append(element('p','screenshot-empty','还没有待回答截图，可连续截取题干、选项和代码。'));
    const batches=ui('screenshots-batches');batches.replaceChildren();
    for(const batch of (screenshots.batches||[]).slice(-6).reverse())batches.append(element('p','screenshot-batch',`${batch.count} 张截图 · ${labels[batch.status]||batch.status}${batch.error?' · '+batch.error:''}`));
  }
  ui('screenshots-submit').addEventListener('click',()=>action(()=>api.submitScreenshots()));
  ui('screenshots-clear').addEventListener('click',()=>action(()=>api.clearScreenshots()));
  window.DualScreenshotsUI={render};
})();

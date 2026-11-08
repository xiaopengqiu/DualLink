'use strict';
(function(){
  const ui=id=>document.getElementById(id),api=window.dualLink;
  const labels={idle:'点击检查新版本',checking:'正在检查新版本…',available:'发现新版本，可下载更新',current:'当前已是最新版本',downloading:'正在下载更新…',downloaded:'下载完成，文件校验通过',installing:'正在安装，即将重启…',error:'更新未完成，可以重试'};
  let latest={},busy=false,localError='';
  const bytes=value=>`${(Math.max(0,Number(value)||0)/1024/1024).toFixed(1)} MB`;
  function render(update){
    latest=update||{};
    const phase=latest.phase||'idle',running=busy||['checking','downloading','installing'].includes(phase),supported=latest.supported!==false;
    const percent=Math.max(0,Math.min(100,Number(latest.progress)||0));
    ui('update-current-version').textContent=latest.currentVersion||'—';
    ui('update-latest-version').textContent=latest.latestVersion||'尚未检查';
    ui('update-package-kind').textContent=latest.kind==='portable'?'便携版 · 退出后替换并重启':'安装版 · 安装后重启';
    ui('update-status').textContent=supported?(labels[phase]||labels.idle):'当前运行方式不支持安装更新，请使用已打包的 Windows 客户端';
    ui('update-status').setAttribute('data-phase',phase);
    ui('update-progress-wrap').hidden=phase!=='downloading';
    ui('update-progress').value=percent;
    ui('update-progress-text').textContent=`${Math.round(percent)}% · ${bytes(latest.downloadedBytes)} / ${latest.totalBytes?bytes(latest.totalBytes):'正在确认大小'}`;
    const blocked=String(latest.blockedReason||'');
    ui('update-blocked').textContent=blocked;ui('update-blocked').hidden=!blocked;
    const error=localError||String(latest.error||'');
    ui('update-error').textContent=error;ui('update-error').hidden=!error;
    const notes=typeof latest.notes==='string'?latest.notes.slice(0,6000):'';
    ui('update-notes').textContent=notes;ui('update-notes-wrap').hidden=!notes;
    ui('update-check').disabled=running||!supported;
    ui('update-upgrade').hidden=['downloaded','installing'].includes(phase);
    ui('update-upgrade').disabled=running||!supported;
    ui('update-download').hidden=!(['available','downloading'].includes(phase)||(phase==='error'&&latest.latestVersion));
    ui('update-download').disabled=running||!supported;
    ui('update-install').hidden=!['downloaded','installing'].includes(phase);
    ui('update-install').disabled=running||!supported||!latest.canInstall;
  }
  async function action(button,method){
    if(busy||button.disabled)return;
    busy=true;localError='';render(latest);
    try{const result=await api[method]();if(result)latest=result.update||result;}
    catch(error){localError=String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');}
    finally{busy=false;render(latest);}
  }
  for(const [id,method]of [['update-check','updateCheck'],['update-upgrade','updateUpgrade'],['update-download','updateDownload'],['update-install','updateInstall']])ui(id).addEventListener('click',()=>action(ui(id),method));
  window.DualUpdaterUI={render};
  render();
})();

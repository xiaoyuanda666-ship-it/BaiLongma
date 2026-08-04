import { API } from "./api-client.js";

// ── AI 视频生成模式（Seedance · 生成工作台）──
// 三段式：生成栏(多任务队列) + 播放区 + 输入区。全程由 aivideo_mode SSE 事件驱动。
export function initAIVideoMode() {
  var el = function(id){ return document.getElementById(id); };
  var panel = el("aivideo-panel");
  if (!panel) return;
  var queueEl=el("aivideo-queue"), stage=el("aivideo-stage"), stageEmpty=el("aivideo-stage-empty"),
      feed=el("aivideo-feed"), dlBtn=el("aivideo-dl"), playerMeta=el("aivideo-player-meta"),
      dropzone=el("aivideo-dropzone"), modeTag=el("aivideo-modetag"), modeHint=el("aivideo-modehint"),
      promptInput=el("aivideo-prompt-input"), ratioSel=el("aivideo-ratio"), resSel=el("aivideo-resolution"),
      durSel=el("aivideo-duration"), submitBtn=el("aivideo-submit"), composeErr=el("aivideo-compose-err"),
      fileInput=el("aivideo-file-input"), newBtn=el("aivideo-new-btn"), exitBtn=el("aivideo-exit-btn");

  var active=false, jobs=[], selId=null, images=[], submitting=false;

  var toastEl=document.createElement("div"); toastEl.className="aivideo-toast"; document.body.appendChild(toastEl);
  var toastTimer=null;
  function showToast(html){ toastEl.innerHTML=html; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(function(){ toastEl.classList.remove("show"); },3200); }

  function mediaUrl(u){ var s=String(u||""); if(!s) return ""; return s.charAt(0)==="/" ? (API+s) : s; }
  function modeLabel(m){ return m==="flf"?"首尾帧":(m==="image"?"图生视频":"文生视频"); }
  function jobById(id){ for(var i=0;i<jobs.length;i++){ if(jobs[i].id===id) return jobs[i]; } return null; }

  // —— 感知同步：把「面板开关 + 提示词草稿」实时回传后端，让 agent 能直接看到用户在框里写了什么 ——
  var draftTimer=null, lastDraftSent=null;
  function syncDraft(immediate){
    clearTimeout(draftTimer);
    var doSync=function(){
      var payload=JSON.stringify({ open:active, prompt:(promptInput.value||"") });
      if(payload===lastDraftSent) return;            // 没变化就不发，省流量
      lastDraftSent=payload;
      try{ fetch(API+"/aivideo/draft",{method:"POST",headers:{"Content-Type":"application/json"},body:payload}).catch(function(){}); }catch(e){}
    };
    if(immediate) doSync(); else draftTimer=setTimeout(doSync,400);
  }

  function setActive(on){
    active=!!on; document.body.classList.toggle("aivideo-mode", active);
    if(active){ try{ window.bailongmaMedia&&window.bailongmaMedia.controlVideo&&window.bailongmaMedia.controlVideo({action:"pause"}); }catch(e){} document.body.classList.remove("video-mode"); }
    syncDraft(true);   // 开/关状态立即同步
  }

  // —— 生成栏 ——
  function renderQueue(){
    queueEl.innerHTML="";
    if(!jobs.length){ var em=document.createElement("div"); em.className="aivideo-queue-empty"; em.textContent="还没有生成任务"; queueEl.appendChild(em); return; }
    jobs.forEach(function(j){
      var t=document.createElement("div");
      t.className="av-tile "+(j.status==="gen"?"gen":j.status==="fail"?"fail":"")+(j.id===selId?" sel":"");
      var fr=document.createElement("div"); fr.className="frame";
      if(j.status==="done"){
        var v=document.createElement("video"); v.className="thumb"; v.src=mediaUrl(j.videoUrl); v.muted=true; v.playsInline=true; v.preload="metadata"; fr.appendChild(v);
        var pl=document.createElement("div"); pl.className="play"; pl.textContent="▶"; fr.appendChild(pl);
        if(j.dur){ var d=document.createElement("div"); d.className="dur"; d.textContent=j.dur+"s"; fr.appendChild(d); }
      } else if(j.status==="gen"){
        var orb=document.createElement("div"); orb.className="av-orb"; orb.innerHTML="<i></i><i></i>"; fr.appendChild(orb);
        var gb=document.createElement("div"); gb.className="genbadge"; gb.textContent="生成中"; fr.appendChild(gb);
        var gt=document.createElement("div"); gt.className="gentime"; gt.dataset.start=String(j.start||Date.now()); gt.textContent="0:00"; fr.appendChild(gt);
      } else {
        var x=document.createElement("div"); x.className="x"; x.textContent="!"; fr.appendChild(x);
      }
      if(j.status!=="gen"){ var rm=document.createElement("button"); rm.className="rm"; rm.textContent="×"; rm.onclick=function(e){ e.stopPropagation(); removeJob(j.id); }; fr.appendChild(rm); }
      t.appendChild(fr);
      var lb=document.createElement("div"); lb.className="label";
      lb.textContent = j.status==="fail" ? ("失败 · "+(j.error||"")) : (j.prompt || modeLabel(j.mode));
      t.appendChild(lb);
      t.onclick=function(){ if(j.status==="done") loadPlayer(j); };
      queueEl.appendChild(t);
    });
  }
  function tickTimers(){ var now=Date.now(); var list=queueEl.querySelectorAll(".gentime"); for(var i=0;i<list.length;i++){ var s=Math.floor((now-Number(list[i].dataset.start))/1000); if(s<0)s=0; list[i].textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); } }
  setInterval(tickTimers,500);
  function removeJob(id){ jobs=jobs.filter(function(j){ return j.id!==id; }); if(selId===id){ selId=null; clearPlayer(); } renderQueue(); }

  // —— 重建历史：从后端拉已完成视频（newest-first），合并进 jobs。 ——
  // 修复「面板关闭重开 / app 重启后队列空了」：jobs[] 原本纯内存，重载即丢，
  // 而视频其实还在磁盘。这里按 id 去重，不覆盖本会话进行中的瓦片。
  function hydrateHistory(){
    fetch(API+"/aivideo/history").then(function(r){ return r.json(); }).then(function(d){
      if(!d||!d.ok||!Array.isArray(d.jobs)) return;
      var changed=false;
      d.jobs.forEach(function(h){
        if(!h||!h.id) return;
        var ex=jobById(h.id);
        if(ex){
          if(ex.status!=="done"&&h.videoUrl){ ex.status="done"; ex.videoUrl=h.videoUrl; ex.mode=ex.mode||h.mode; ex.prompt=ex.prompt||h.prompt; ex.res=ex.res||h.res; ex.ratio=ex.ratio||h.ratio; ex.dur=ex.dur||h.dur; changed=true; }
          return;
        }
        jobs.push({ id:h.id, status:"done", videoUrl:h.videoUrl, mode:h.mode, prompt:h.prompt, res:h.res, ratio:h.ratio, dur:h.dur });
        changed=true;
      });
      if(changed) renderQueue();
    }).catch(function(){});
  }

  // —— 播放区 ——
  function clearPlayer(){ try{ feed.pause(); }catch(e){} feed.removeAttribute("src"); if(feed.load) feed.load(); feed.hidden=true; dlBtn.hidden=true; stageEmpty.hidden=false; if(stage) stage.classList.add("is-empty"); playerMeta.textContent=""; }
  function loadPlayer(j){
    selId=j.id; feed.src=mediaUrl(j.videoUrl); feed.hidden=false; feed.muted=false; dlBtn.hidden=false; stageEmpty.hidden=true; if(stage) stage.classList.remove("is-empty");
    playerMeta.innerHTML="<b>"+modeLabel(j.mode)+"</b>"+(j.res?" · "+j.res:"")+(j.ratio?" · "+j.ratio:"")+(j.dur?" · "+j.dur+"s":"");
    if(feed.play) feed.play().catch(function(){}); renderQueue();
  }
  function download(){
    if(!selId) return; dlBtn.disabled=true; var old=dlBtn.textContent; dlBtn.textContent="保存中…";
    fetch(API+"/aivideo/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:selId})})
      .then(function(r){ return r.json(); })
      .then(function(d){ if(d&&d.ok){ showToast('已保存到　<span class="mono">'+(d.path||"")+'</span>'); } else { showToast('保存失败：'+((d&&d.error)||"未知错误")); } })
      .catch(function(e){ showToast('保存失败：'+e.message); })
      .then(function(){ dlBtn.disabled=false; dlBtn.textContent=old; });
  }
  dlBtn.addEventListener("click", download);

  // —— 输入区：加图（点击/拖拽/粘贴，最多 2 张）——
  function renderDropzone(){
    dropzone.innerHTML="";
    images.forEach(function(src,i){
      var cell=document.createElement("div"); cell.className="av-imgcell";
      var im=document.createElement("img"); im.src=src; cell.appendChild(im);
      var r=document.createElement("div"); r.className="role"; r.textContent=images.length===2?(i===0?"首帧":"尾帧"):"参考图"; cell.appendChild(r);
      var rm=document.createElement("button"); rm.className="rm"; rm.textContent="×"; rm.onclick=function(e){ e.stopPropagation(); images.splice(i,1); renderDropzone(); updateMode(); }; cell.appendChild(rm);
      dropzone.appendChild(cell);
    });
    if(images.length<2){ var add=document.createElement("div"); add.className="av-addcell"; add.innerHTML='<span class="plus">+</span><span>图片</span><small>点击/拖拽/粘贴</small>'; add.onclick=function(){ fileInput.click(); }; dropzone.appendChild(add); }
  }
  var hadImages=false;
  function updateMode(){
    var m=images.length>=2?"flf":(images.length===1?"image":"text");
    // 进入图生/首尾帧默认「适配图片」(输出比例跟随上传图)；退回文生时恢复 16:9。仅在边界切换，尊重用户在同一模式内的手动选择
    if(images.length>0 && !hadImages){ ratioSel.value="adaptive"; }
    else if(images.length===0 && hadImages && ratioSel.value==="adaptive"){ ratioSel.value="16:9"; }
    hadImages=images.length>0;
    modeTag.textContent=modeLabel(m); modeTag.classList.toggle("flf", m==="flf");
    modeHint.textContent = m==="text" ? "不加图 = 文生视频 · 1 张 = 图生视频 · 2 张 = 首尾帧"
      : m==="image" ? "已加 1 张参考图 → 图生视频（比例已设为「适配图片」）"
      : "已加 2 张 → 首尾帧：第 1 张为「首帧」，第 2 张为「尾帧」";
  }
  function addImage(src){ if(images.length>=2) return; images.push(src); renderDropzone(); updateMode(); }
  fileInput.addEventListener("change", function(e){ var f=e.target.files&&e.target.files[0]; if(f){ var rd=new FileReader(); rd.onload=function(){ addImage(String(rd.result||"")); }; rd.readAsDataURL(f); } e.target.value=""; });
  ["dragenter","dragover"].forEach(function(ev){ dropzone.addEventListener(ev,function(e){ e.preventDefault(); dropzone.classList.add("dragover"); }); });
  ["dragleave","drop"].forEach(function(ev){ dropzone.addEventListener(ev,function(e){ e.preventDefault(); dropzone.classList.remove("dragover"); }); });
  dropzone.addEventListener("drop", function(e){ var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f&&f.type.indexOf("image/")===0){ var rd=new FileReader(); rd.onload=function(){ addImage(String(rd.result||"")); }; rd.readAsDataURL(f); } });
  document.addEventListener("paste", function(e){
    if(!active) return; var cd=e.clipboardData||window.clipboardData; var items=cd&&cd.items; if(!items) return;
    for(var i=0;i<items.length;i++){ if(items[i].type.indexOf("image")===0){ var blob=items[i].getAsFile(); var rd=new FileReader(); rd.onload=function(){ addImage(String(rd.result||"")); }; rd.readAsDataURL(blob); e.preventDefault(); break; } }
  });

  var PROMPT_MIN=46, PROMPT_MAX=160;
  function autoGrow(){
    if(!promptInput.clientWidth){ promptInput.style.height=""; return; } // 面板隐藏(宽0)时测量会拿到错误的 scrollHeight，跳过，交给 CSS min-height
    promptInput.style.height="auto";
    var b=promptInput.offsetHeight-promptInput.clientHeight;
    promptInput.style.height=Math.min(PROMPT_MAX, Math.max(PROMPT_MIN, promptInput.scrollHeight+b))+"px";
  }
  promptInput.addEventListener("input", function(){ autoGrow(); syncDraft(); });

  // —— 提交生成 ——
  function submitGenerate(){
    if(submitting) return;
    var prompt=(promptInput.value||"").trim();
    if(!prompt && images.length===0){ composeErr.textContent="请至少输入一段画面描述（或加一张参考图）"; composeErr.hidden=false; return; }
    composeErr.hidden=true; submitting=true; submitBtn.disabled=true; submitBtn.textContent="提交中…";
    fetch(API+"/aivideo/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ prompt:prompt, images:images.slice(0,2), ratio:ratioSel.value, resolution:resSel.value, duration:Number(durSel.value)||5 })})
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
      .then(function(res){
        submitting=false; submitBtn.disabled=false; submitBtn.textContent="生成";
        if(!res.ok || !res.d || !res.d.ok){ var d=res.d||{}; composeErr.textContent=d.guide||d.error||"提交失败"; composeErr.hidden=false; return; }
        promptInput.value=""; autoGrow(); images=[]; renderDropzone(); updateMode(); syncDraft(true);
      })
      .catch(function(e){ submitting=false; submitBtn.disabled=false; submitBtn.textContent="生成"; composeErr.textContent="网络错误："+e.message; composeErr.hidden=false; });
  }
  submitBtn.addEventListener("click", submitGenerate);
  promptInput.addEventListener("keydown", function(e){ if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){ e.preventDefault(); submitGenerate(); } });

  // —— 打开/关闭 ——
  function openPanel(configured){
    setActive(true);
    hydrateHistory();   // 每次打开都拉一次历史，重建之前生成的视频队列
    if(configured===false){ composeErr.textContent="尚未配置火山方舟（Seedance）API Key —— 把 key 发给小白龙即可（例如「火山视频 你的APIKey」），配置后就能在这里生成。"; composeErr.hidden=false; }
    else composeErr.hidden=true;
    setTimeout(function(){ try{ promptInput.focus(); }catch(e){} },60);
  }
  function closePanel(){ setActive(false); try{ feed.pause(); }catch(e){} }
  newBtn.addEventListener("click", function(){ images=[]; renderDropzone(); updateMode(); promptInput.value=""; autoGrow(); composeErr.hidden=true; syncDraft(true); try{ promptInput.focus(); }catch(e){} });
  exitBtn.addEventListener("click", closePanel);
  window.addEventListener("keydown", function(e){ if(!active) return; if(e.key==="Escape"){ if(document.activeElement===promptInput){ promptInput.blur(); return; } e.preventDefault(); closePanel(); } });

  // —— SSE 事件 ——
  function handle(data){
    data=data||{}; var action=data.action||"show";
    if(action==="hide"||action==="close"){ closePanel(); return; }
    if(action==="open"){ openPanel(data.configured); return; }
    if(action==="set_prompt"){
      // agent 在用户确认采用后，把优化好的提示词写回输入框（覆盖草稿）
      if(!active) setActive(true);
      promptInput.value=String(data.prompt||""); autoGrow(); syncDraft(true);
      showToast("已采用优化后的提示词，检查后点「生成」即可");
      try{ promptInput.focus(); }catch(e){}
      return;
    }
    if(action==="show"){
      setActive(true);
      var j=jobById(data.jobId);
      if(!j){ j={ id:data.jobId, status:"gen", start:Date.now() }; jobs.unshift(j); }
      j.status="gen"; j.prompt=data.prompt||j.prompt||""; j.mode=data.mode||j.mode||"text";
      j.res=data.resolution||j.res; j.ratio=data.ratio||j.ratio; j.dur=data.duration||j.dur;
      if(!j.start) j.start=Date.now();
      renderQueue(); return;
    }
    var job=jobById(data.jobId); if(!job) return;
    if(action==="progress"){ job.status="gen"; return; }
    if(action==="ready"){ job.status="done"; job.videoUrl=data.videoUrl; renderQueue(); if(!active) setActive(true); loadPlayer(job); return; }
    if(action==="error"){ job.status="fail"; job.error=data.message||"生成失败"; renderQueue(); return; }
  }
  window.addEventListener("bailongma:aivideo", function(e){ handle(e.detail||{}); });
  window.bailongmaAIVideo={ handle:handle, open:openPanel, close:closePanel };

  renderDropzone(); updateMode(); renderQueue(); autoGrow();
  hydrateHistory();   // 初始化即重建一次（覆盖 app 重启/渲染进程重载后的历史恢复）
}

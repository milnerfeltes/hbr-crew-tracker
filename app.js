"use strict";

let WORKERS = ["Luis Bordón", "Enrique Villalba", "César Cáceres", "Milner Feltes"];
const WORKERS_KEY = "__workers__";
const DAYNAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

let state = {};
let currentDate = todayStr();
let currentView = "daily";
let openReason = null;
let storageOK = true;

/* ---------- date helpers ---------- */
function toLocalStr(d){ const o=d.getTimezoneOffset(); return new Date(d-o*60000).toISOString().slice(0,10); }
function todayStr(){ return toLocalStr(new Date()); }
function newId(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtDate(d){ const dt=new Date(d+"T00:00:00"); return dt.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}); }
function pctColor(p){ return p>=100?"#36c26a":p>=50?"#ffb020":"#ef4d4d"; }
function pctOf(t){ return typeof t.pct==="number" ? t.pct : (t.done?100:0); }
function isDone(t){ return pctOf(t)>=100; }
function shiftDay(dateStr,n){ const d=new Date((dateStr||todayStr())+"T00:00:00"); d.setDate(d.getDate()+n); return toLocalStr(d); }
function mondayOf(dateStr){
  if(!dateStr) dateStr=todayStr();
  const d=new Date(dateStr+"T00:00:00"); if(isNaN(d)) return todayStr();
  const day=d.getDay(), diff=(day===0?-6:1-day); d.setDate(d.getDate()+diff); return toLocalStr(d);
}
function weekDates(monday){ const arr=[],d=new Date(monday+"T00:00:00"); for(let i=0;i<7;i++){arr.push(toLocalStr(d));d.setDate(d.getDate()+1);} return arr; }

/* ---------- IndexedDB layer ---------- */
const DB_NAME="hbr_tracker", STORE="days", DB_VER=1;
let _db=null;
function openDB(){
  return new Promise((res,rej)=>{
    if(_db) return res(_db);
    if(!("indexedDB" in window)) return rej(new Error("no-idb"));
    const req=indexedDB.open(DB_NAME,DB_VER);
    req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess=()=>{ _db=req.result; res(_db); };
    req.onerror=()=>rej(req.error);
  });
}
function idbGet(key){
  return openDB().then(db=>new Promise((res,rej)=>{
    const tx=db.transaction(STORE,"readonly").objectStore(STORE).get(key);
    tx.onsuccess=()=>res(tx.result); tx.onerror=()=>rej(tx.error);
  }));
}
function idbSet(key,val){
  return openDB().then(db=>new Promise((res,rej)=>{
    const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(val,key);
    tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); tx.onabort=()=>rej(tx.error);
  }));
}
function idbAll(){
  return openDB().then(db=>new Promise((res,rej)=>{
    const out={}, store=db.transaction(STORE,"readonly").objectStore(STORE);
    const cur=store.openCursor();
    cur.onsuccess=()=>{ const c=cur.result; if(c){ out[c.key]=c.value; c.continue(); } else res(out); };
    cur.onerror=()=>rej(cur.error);
  }));
}

/* localStorage fallback if IDB unavailable (private mode, etc.) */
const mem={};
function lsKey(d){ return "hbr_"+d; }
function lsGet(d){ try{ const v=localStorage.getItem(lsKey(d)); return v?JSON.parse(v):null; }catch(e){ return mem[d]||null; } }
function lsSet(d,obj){ try{ localStorage.setItem(lsKey(d),JSON.stringify(obj)); return true; }catch(e){ mem[d]=obj; return false; } }

/* ---------- data model ---------- */
function normalize(day){
  day=day||{};
  // Normalize every worker key already present in the stored data, not just
  // the current active roster — a removed crew member's historical entries
  // must still get reason/pct defaults so old days render correctly.
  const allKeys=new Set([...WORKERS, ...Object.keys(day)]);
  allKeys.forEach(w=>{
    if(!Array.isArray(day[w])) day[w]=[];
    day[w].forEach(t=>{
      if(typeof t.reason!=="string") t.reason="";
      if(typeof t.pct!=="number") t.pct = t.done?100:0;
    });
  });
  return day;
}
// Workers to show for a given day's data: the active roster, plus anyone no
// longer on the roster who still has task history recorded that day. This is
// what makes "remove a worker" a soft delete — their data is never dropped.
function dayWorkers(day){
  day=day||{};
  const extra=Object.keys(day).filter(k=>Array.isArray(day[k])&&day[k].length&&!WORKERS.includes(k));
  return [...WORKERS, ...extra];
}
async function getDay(d){
  try{ const r=await idbGet(d); if(r) return normalize(r); }
  catch(e){ const ls=lsGet(d); if(ls) return normalize(ls); }
  return normalize({});
}
async function save(){
  try{
    await idbSet(currentDate, JSON.parse(JSON.stringify(state)));
    storageOK=true;
  }catch(e){
    storageOK = lsSet(currentDate, state); // try localStorage, else memory
  }
  updateSaveStatus();
}
async function load(){ state=await getDay(currentDate); render(); }

/* ---------- crew roster (add / remove workers) ---------- */
async function loadWorkers(){
  try{ const r=await idbGet(WORKERS_KEY); if(Array.isArray(r)&&r.length){ WORKERS=r; return; } }
  catch(e){}
  const ls=lsGet(WORKERS_KEY); if(Array.isArray(ls)&&ls.length){ WORKERS=ls; return; }
  await saveWorkers(); // first run on this device — persist the default roster
}
async function saveWorkers(){
  try{ await idbSet(WORKERS_KEY, WORKERS.slice()); }
  catch(e){ lsSet(WORKERS_KEY, WORKERS.slice()); }
}
function addWorker(name){
  name=(name||"").trim(); if(!name) return;
  if(WORKERS.some(w=>w.toLowerCase()===name.toLowerCase())) return; // already on the crew
  WORKERS.push(name);
  saveWorkers();
  if(!Array.isArray(state[name])) state[name]=[]; // so today's view/add-task works immediately
  save(); render();
}
function removeWorker(name){
  showConfirmModal(
    `Remove ${name} from the crew?`,
    `This only takes them off the active list for adding new tasks — every task they've already logged stays saved and still shows up on the days/weeks/PDF reports where it happened.`,
    ()=>{ WORKERS=WORKERS.filter(w=>w!==name); saveWorkers(); render(); }
  );
}

/* ---------- custom confirm modal (no blocking window.confirm) ---------- */
let _confirmYes=null;
function showConfirmModal(title,body,onYes){
  _confirmYes=onYes;
  document.getElementById("confirmTitle").textContent=title;
  document.getElementById("confirmBody").textContent=body;
  document.getElementById("confirmOverlay").classList.remove("hidden");
}
function hideConfirmModal(){ document.getElementById("confirmOverlay").classList.add("hidden"); _confirmYes=null; }

/* ---------- mutations ---------- */
function addTask(w,text){ if(!text.trim())return; state[w].push({id:newId(),text:text.trim(),pct:0,reason:""}); save(); render(); }
function toggle(w,id){ const t=state[w].find(x=>String(x.id)===String(id)); if(t){ t.pct=isDone(t)?0:100; if(t.pct===100) t.reason=""; } save(); render(); }
function del(w,id){ state[w]=state[w].filter(x=>String(x.id)!==String(id)); save(); render(); }
function setReason(w,id,v){ const t=state[w].find(x=>String(x.id)===String(id)); if(t) t.reason=v; save(); }
function setPct(w,id,val){
  const t=state[w].find(x=>String(x.id)===String(id)); if(!t) return;
  val=Math.max(0,Math.min(100,Math.round(Number(val)||0)));
  t.pct=val;
  if(val>=100){ t.reason=""; openReason=null; } else { openReason=String(id); }
  save(); render();
  if(val<100){ const inp=document.querySelector('.why input[data-id="'+id+'"]'); if(inp) inp.focus(); }
}

/* ---------- stats + ring ---------- */
function stats(day){
  let done=0,total=0,credit=0;
  dayWorkers(day).forEach(w=>{
    const ts=day[w]||[];
    total+=ts.length;
    ts.forEach(t=>{ const p=pctOf(t); if(p>=100) done++; credit+=p/100; });
  });
  return {done,total,credit,pct: total?Math.round(credit/total*100):0};
}
function ring(pct,size){
  const r=(size/2)-8, c=2*Math.PI*r, off=c*(1-pct/100), col=pctColor(pct);
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="#2a313d" stroke-width="8"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${col}" stroke-width="8"
        stroke-dasharray="${c}" stroke-dashoffset="${off}" stroke-linecap="round"/>
    </svg><div class="pc" style="color:${col}">${pct}%</div></div>`;
}

/* ---------- render daily ---------- */
function render(){
  const s=stats(state);
  document.getElementById("overall").innerHTML=`
    <div class="score">${ring(s.pct,92)}
      <div><div class="lead">Today's production</div>
      <div class="big">${s.done} / ${s.total}</div>
      ${s.total-s.done>0?`<div class="note warn">${s.total-s.done} still open</div>`
        :(s.total?`<div class="note good">All done — 100%</div>`:`<div class="note">No tasks yet</div>`)}</div>
    </div>`;

  const wrap=document.getElementById("workers"); wrap.innerHTML="";
  const PRESETS=[100,90,80,70,50,25,0];
  dayWorkers(state).forEach(w=>{
    const isActive=WORKERS.includes(w);
    const tasks=state[w]||[];
    const done=tasks.filter(t=>isDone(t)).length;
    const wCredit=tasks.reduce((a,t)=>a+pctOf(t)/100,0);
    const pct=tasks.length?Math.round(wCredit/tasks.length*100):0, col=pctColor(tasks.length?pct:0);
    const div=document.createElement("div"); div.className="worker";
    div.innerHTML=`
      <div class="w-head"><div class="w-name">${esc(w)}${isActive?'':'<span class="w-archived">Removed</span>'}</div>
        <div class="w-right">
          <div class="w-pct" style="color:${tasks.length?col:'#8b95a3'}">${pct}% · ${done}/${tasks.length}</div>
          ${isActive?`<div class="w-remove" data-w="${esc(w)}" data-act="removeworker">×</div>`:''}
        </div></div>
      <div class="track"><i style="width:${pct}%;background:${col}"></i></div>
      <div class="tasks">
        ${tasks.map(t=>{
          const open=openReason===String(t.id);
          const p=pctOf(t), tDone=isDone(t);
          let why="";
          if(!tDone){
            if(open){
              const chips=PRESETS.map(v=>`<button class="pct-chip ${p===v?'active':''}" data-w="${esc(w)}" data-id="${t.id}" data-act="setpct" data-val="${v}">${v}%</button>`).join("");
              why=`<div class="why"><div class="pct-row">${chips}</div><input data-w="${esc(w)}" data-id="${t.id}" data-act="reason" placeholder="Why isn't this done? (materials, weather, client…)" value="${esc(t.reason)}"></div>`;
            } else {
              const parts=[]; if(p>0) parts.push(p+"% done"); if(t.reason) parts.push(t.reason);
              if(parts.length) why=`<div class="why-tag" data-w="${esc(w)}" data-id="${t.id}" data-act="editreason">⚠ ${esc(parts.join(" — "))}</div>`;
            }
          }
          return `<div class="task ${tDone?'done':''}">
            <div class="t-row">
              <div class="check ${tDone?'on':''}" data-w="${esc(w)}" data-id="${t.id}" data-act="toggle">${tDone?'✓':''}</div>
              <div class="t-text" data-w="${esc(w)}" data-id="${t.id}" data-act="openreason">${esc(t.text)}</div>
              <div class="x" data-w="${esc(w)}" data-id="${t.id}" data-act="del">×</div>
            </div>${why}</div>`;
        }).join("")}
        ${isActive?`<div class="add"><input type="text" placeholder="Add task for ${esc(w.split(' ')[0])}…" data-w="${esc(w)}"><button data-w="${esc(w)}" data-act="add">+</button></div>`:''}
      </div>`;
    wrap.appendChild(div);
  });
  const addWorkerDiv=document.createElement("div"); addWorkerDiv.className="add-worker";
  addWorkerDiv.innerHTML=`<input type="text" id="newWorkerName" placeholder="Add crew member…"><button data-act="addworker">+</button>`;
  wrap.appendChild(addWorkerDiv);
  renderBlockers();
  updateSaveStatus();
}

function renderBlockers(){
  const open=[]; dayWorkers(state).forEach(w=>{ (state[w]||[]).forEach(t=>{ if(!isDone(t)) open.push({w,t}); }); });
  const el=document.getElementById("blockers");
  if(stats(state).total===0){ el.innerHTML=""; return; }
  if(open.length===0){ el.innerHTML=`<div class="blockers"><h2>Why not 100%?</h2><div class="done-all">✓ Everything finished — 100% complete</div></div>`; return; }
  el.innerHTML=`<div class="blockers"><h2>Why not 100%? — ${open.length} open</h2>
    ${open.map(({w,t})=>{
      const p=pctOf(t);
      const label=[p>0?p+"% done":"",t.reason||""].filter(Boolean).join(" — ");
      return `<div class="bk"><span class="bt">${esc(t.text)}</span> <span class="bw">— ${esc(w)}</span>
      <div class="br ${label?'':'empty'}" data-w="${esc(w)}" data-id="${t.id}" data-act="openreason">${label?'⚠ '+esc(label):'Tap to add a % and reason…'}</div></div>`;
    }).join("")}
  </div>`;
}

function updateSaveStatus(){
  const el=document.getElementById("saveStatus"); if(!el) return;
  if(storageOK){ el.textContent="✓ Saved on this device"; el.className="status"; }
  else{ el.textContent="⚠ Couldn't save to device storage — export the PDF to keep a copy"; el.className="status warn"; }
}

/* ---------- render weekly ---------- */
async function renderWeek(){
  const monday=mondayOf(document.getElementById("weekPicker").value);
  const dates=weekDates(monday);
  const wrap=document.getElementById("weekContent"); wrap.innerHTML='<div class="loading">Loading…</div>';
  let wDone=0,wTotal=0,wCredit=0; const data={};
  for(const d of dates) data[d]=await getDay(d);
  wrap.innerHTML="";
  dates.forEach(d=>{
    const day=data[d], dt=new Date(d+"T00:00:00"), ds=stats(day);
    let html="";
    dayWorkers(day).forEach(w=>{
      const tasks=day[w]||[];
      if(tasks.length){
        const done=tasks.filter(t=>isDone(t)).length; wDone+=done; wTotal+=tasks.length;
        html+=`<div class="wk-w"><div class="n">${esc(w)} <span>(${done}/${tasks.length})</span></div>`;
        tasks.forEach(t=>{
          const p=pctOf(t), tDone=isDone(t);
          wCredit+=p/100;
          html+=`<div class="wk-t ${tDone?'d':''}"><span class="m">${tDone?'✓':'○'}</span> ${esc(t.text)}${!tDone&&p>0?' — '+p+'%':''}</div>`;
          if(!tDone&&t.reason) html+=`<div class="wk-r">⚠ ${esc(t.reason)}</div>`;
        });
        html+="</div>";
      }
    });
    const div=document.createElement("div"); div.className="wk-day";
    div.innerHTML=`<h3><span>${DAYNAMES[dt.getDay()]} · ${fmtDate(d)}</span>${ds.total?`<span class="p" style="color:${pctColor(ds.pct)}">${ds.pct}%</span>`:''}</h3>${ds.total?html:'<div class="empty">No tasks recorded</div>'}`;
    wrap.appendChild(div);
  });
  const pct=wTotal?Math.round(wCredit/wTotal*100):0;
  document.getElementById("weekOverall").innerHTML=`
    <div class="score">${ring(pct,92)}
      <div><div class="lead">Week of ${fmtDate(monday)}</div>
      <div class="big">${wDone} / ${wTotal}</div>
      ${wTotal-wDone>0?`<div class="note warn">${wTotal-wDone} not finished</div>`
        :(wTotal?`<div class="note good">Full week done 🎉</div>`:`<div class="note">No tasks recorded</div>`)}</div>
    </div>`;
}

/* ---------- PDF ---------- */
async function exportPDF(){
  if(!window.jspdf){ alert("Report tool still loading — try again in a moment."); return; }
  const { jsPDF }=window.jspdf;
  const doc=new jsPDF({unit:"pt",format:"letter"});
  const monday=mondayOf(document.getElementById("weekPicker").value);
  const dates=weekDates(monday);
  const data={}; let wDone=0,wTotal=0,wCredit=0; const blockers=[];
  for(const d of dates) data[d]=await getDay(d);

  const pw=doc.internal.pageSize.getWidth(), ph=doc.internal.pageSize.getHeight();
  doc.setFillColor(17,21,28); doc.rect(0,0,pw,74,"F");
  doc.setFillColor(255,176,32); doc.rect(0,72,pw,3,"F");
  doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(18);
  doc.text("Hampton Bays Remodeling Corp.",40,36);
  doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.setTextColor(200,205,212);
  doc.text("Weekly Production Report — Week of "+fmtDate(monday),40,57);
  let y=98; doc.setTextColor(40,40,40);
  function pageCheck(h){ if(y+h>ph-44){ doc.addPage(); y=52; } }

  dates.forEach(d=>{
    const day=data[d], dt=new Date(d+"T00:00:00"), ds=stats(day);
    pageCheck(40);
    doc.setFillColor(238,240,244); doc.rect(40,y-13,pw-80,23,"F");
    doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(17,21,28);
    doc.text(DAYNAMES[dt.getDay()]+" — "+fmtDate(d),48,y+3);
    if(ds.total){ const c=ds.pct>=100?[54,194,106]:ds.pct>=50?[200,140,0]:[220,60,60]; doc.setTextColor(c[0],c[1],c[2]); doc.text(ds.pct+"%",pw-72,y+3); }
    y+=30;
    let any=false;
    dayWorkers(day).forEach(w=>{
      const tasks=day[w]||[];
      if(tasks.length){
        any=true; const done=tasks.filter(t=>isDone(t)).length; wDone+=done; wTotal+=tasks.length;
        pageCheck(20); doc.setFont("helvetica","bold"); doc.setFontSize(10.5); doc.setTextColor(30,30,30);
        doc.text(w+"  ("+done+"/"+tasks.length+")",48,y); y+=15;
        doc.setFont("helvetica","normal"); doc.setFontSize(10);
        tasks.forEach(t=>{
          const p=pctOf(t), tDone=isDone(t);
          wCredit+=p/100;
          pageCheck(15); const mark=tDone?"[X]":(p>0?"["+p+"%]":"[ ]");
          doc.setTextColor(tDone?125:40,tDone?125:40,tDone?125:40);
          const lines=doc.splitTextToSize(mark+" "+t.text,pw-130); doc.text(lines,60,y); y+=13*lines.length;
          if(!tDone) blockers.push({d,w,t});
          if(!tDone&&t.reason){ pageCheck(13); doc.setTextColor(200,120,20);
            const rl=doc.splitTextToSize("Reason: "+t.reason,pw-150); doc.text(rl,78,y); y+=12*rl.length; doc.setTextColor(40,40,40); }
        });
        y+=5;
      }
    });
    if(!any){ doc.setFont("helvetica","italic"); doc.setFontSize(10); doc.setTextColor(150,150,150); doc.text("No tasks recorded.",48,y); y+=18; }
    y+=6;
  });

  pageCheck(46);
  const pct=wTotal?Math.round(wCredit/wTotal*100):0;
  doc.setDrawColor(200,200,200); doc.line(40,y,pw-40,y); y+=22;
  doc.setFont("helvetica","bold"); doc.setFontSize(13); doc.setTextColor(54,194,106);
  doc.text("Week Completion: "+pct+"%   ("+wDone+"/"+wTotal+" tasks)",40,y); y+=26;

  if(blockers.length){
    pageCheck(40); doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(200,120,20);
    doc.text("Why not 100% — Outstanding items ("+blockers.length+")",40,y); y+=18;
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(50,50,50);
    blockers.forEach(({d,w,t})=>{ pageCheck(16);
      const p=pctOf(t);
      const note=[p>0?p+"% done":"",t.reason||"no reason given"].filter(Boolean).join("; ");
      const line="• "+fmtDate(d)+" — "+w+": "+t.text+"  ("+note+")";
      const ls=doc.splitTextToSize(line,pw-92); doc.text(ls,48,y); y+=13*ls.length+2; });
  } else if(wTotal){
    pageCheck(20); doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(54,194,106);
    doc.text("All tasks completed this week — 100%.",40,y);
  }

  const fname="HBR_Weekly_Report_"+monday+".pdf";
  try{
    const blob=doc.output("blob"); const file=new File([blob],fname,{type:"application/pdf"});
    if(navigator.canShare&&navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:"Weekly Production Report"}); return; }
  }catch(e){}
  doc.save(fname);
}

/* ---------- events ---------- */
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  t.classList.add("active"); currentView=t.dataset.view; openReason=null;
  if(currentView==="daily"){ document.getElementById("dailyView").classList.remove("hidden"); document.getElementById("weeklyView").classList.add("hidden"); }
  else{ document.getElementById("dailyView").classList.add("hidden"); document.getElementById("weeklyView").classList.remove("hidden"); renderWeek(); }
}));

/* render() rebuilds the whole worker block on every change, which destroys
   and recreates the "add task" input — so after adding a task we have to
   re-find the fresh input for that worker and refocus it, or a second task
   typed right after the first would land nowhere. */
function focusAddInput(w){
  document.querySelectorAll('.add input[data-w]').forEach(inp=>{ if(inp.dataset.w===w) inp.focus(); });
}
function focusNewWorkerInput(){
  const inp=document.getElementById("newWorkerName"); if(inp) inp.focus();
}

const daily=document.getElementById("dailyView");
daily.addEventListener("click",e=>{
  const el=e.target.closest("[data-act]"); if(!el)return;
  const act=el.dataset.act,w=el.dataset.w,id=el.dataset.id;
  if(act==="toggle"){ openReason=null; toggle(w,id); }
  else if(act==="del"){ openReason=null; del(w,id); }
  else if(act==="add"){ const inp=el.parentElement.querySelector("input"); addTask(w,inp.value); focusAddInput(w); }
  else if(act==="setpct"){ setPct(w,id,el.dataset.val); }
  else if(act==="openreason"||act==="editreason"){ openReason=String(id); render();
    const inp=document.querySelector('.why input[data-id="'+id+'"]'); if(inp) inp.focus(); }
  else if(act==="addworker"){ const inp=document.getElementById("newWorkerName"); addWorker(inp.value); focusNewWorkerInput(); }
  else if(act==="removeworker"){ removeWorker(w); }
});
daily.addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;
  if(e.target.matches('.add input[data-w]')){ const w=e.target.dataset.w; addTask(w,e.target.value); focusAddInput(w); }
  else if(e.target.matches('#newWorkerName')){ addWorker(e.target.value); focusNewWorkerInput(); }
  else if(e.target.matches('.why input')){ e.target.blur(); }
});
daily.addEventListener("input",e=>{ if(e.target.matches(".why input")) setReason(e.target.dataset.w,e.target.dataset.id,e.target.value); });
daily.addEventListener("focusout",e=>{ if(e.target.matches(".why input")){ openReason=null; render(); } });
/* Tapping a % chip would otherwise steal focus from the reason input first,
   firing the focusout handler above and collapsing the panel before the
   chip's own click is processed. Blocking the default mousedown focus-shift
   keeps the input focused so the click lands on the chip as expected. */
daily.addEventListener("mousedown",e=>{ if(e.target.closest(".pct-chip")) e.preventDefault(); });

document.getElementById("datePicker").addEventListener("change",e=>{ currentDate=e.target.value||todayStr(); openReason=null; sync(); load(); });
document.getElementById("prevDay").addEventListener("click",()=>{ currentDate=shiftDay(currentDate,-1); openReason=null; sync(); load(); });
document.getElementById("nextDay").addEventListener("click",()=>{ currentDate=shiftDay(currentDate,1); openReason=null; sync(); load(); });
document.getElementById("todayBtn").addEventListener("click",()=>{ currentDate=todayStr(); openReason=null; sync(); load(); });
document.getElementById("weekPicker").addEventListener("change",renderWeek);
document.getElementById("exportPdf").addEventListener("click",exportPDF);
document.getElementById("confirmCancel").addEventListener("click",hideConfirmModal);
document.getElementById("confirmYes").addEventListener("click",()=>{ const fn=_confirmYes; hideConfirmModal(); if(fn) fn(); });
document.getElementById("confirmOverlay").addEventListener("click",e=>{ if(e.target.id==="confirmOverlay") hideConfirmModal(); });

function sync(){ document.getElementById("datePicker").value=currentDate; }

/* ---------- install hint (iOS has no auto prompt) ---------- */
function maybeShowInstall(){
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if(standalone) return;
  let dismissed=false; try{ dismissed=localStorage.getItem("hbr_install_dismissed")==="1"; }catch(e){}
  if(dismissed) return;
  const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
  const el=document.getElementById("installHint");
  el.innerHTML=`<div class="install"><div><b>Install this app.</b> ${isIOS?'Tap the Share button, then “Add to Home Screen.”':'Open your browser menu and choose “Install app” / “Add to Home screen.”'} It then opens full-screen and works offline.</div><div class="dismiss" id="dismissInstall">×</div></div>`;
  document.getElementById("dismissInstall").addEventListener("click",()=>{ try{localStorage.setItem("hbr_install_dismissed","1");}catch(e){} el.innerHTML=""; });
}

/* ---------- boot ---------- */
(async function boot(){
  await loadWorkers(); // must load the saved crew roster before the first render
  sync();
  document.getElementById("weekPicker").value=currentDate;
  await load();
  maybeShowInstall();
  if("serviceWorker" in navigator){
    window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
  }
})();

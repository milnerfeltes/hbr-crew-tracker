"use strict";

let WORKERS = ["Luis Bordón", "Enrique Villalba", "César Cáceres"];
const WORKERS_KEY = "__workers__";
const LASTOPEN_KEY = "__lastOpen__";
const DAYNAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

let state = {};
let currentDate = todayStr();
let currentView = "daily";
let openReason = null;
let storageOK = true;
let isUnlocked = false;
const APP_VERSION = "1.2.0";
const MAX_NAME_LEN = 40, MAX_TASK_LEN = 200, MAX_REASON_LEN = 200;

/* ---------- global error safety net ----------
   Catches anything unexpected so the user sees a calm message instead of a
   silently broken UI, and is reassured their saved data isn't touched by it. */
let _lastErrToast = 0;
function _globalErrToast(){
  const now = Date.now();
  if (now - _lastErrToast < 5000) return; // don't spam if several fire at once
  _lastErrToast = now;
  showToast("Something went wrong, but your saved data is safe. Try reloading.", "error");
}
window.addEventListener("error", _globalErrToast);
window.addEventListener("unhandledrejection", _globalErrToast);

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

/* ---------- toast (lightweight, non-blocking feedback) ---------- */
let _toastTimer=null;
function showToast(msg,type){
  const el=document.getElementById("toast"); if(!el) return;
  el.textContent=msg; el.className="toast show "+(type||"");
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>{ el.className="toast "+(type||""); },3200);
}

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
  const prevOK=storageOK;
  try{
    await idbSet(currentDate, JSON.parse(JSON.stringify(state)));
    storageOK=true;
  }catch(e){
    storageOK = lsSet(currentDate, state); // try localStorage, else memory
  }
  if(prevOK && !storageOK) showToast("Couldn't save automatically — export a PDF backup soon.","error");
  updateSaveStatus();
}
async function load(){ state=await getDay(currentDate); render(); }

/* ---------- carry unfinished tasks forward to the next day ----------
   Runs once per calendar-day transition, at boot only — never while just
   browsing prev/next day or the date picker. Whatever was still under 100%
   on the last day the app was actually opened gets copied (same text, same
   % progress, same reason) onto today's list, tagged so the crew can see it
   rolled over. The original day's record is left untouched, so weekly/PDF
   history still accurately shows it was open on that day. */
async function carryOverUnfinishedTasks(){
  const today=todayStr();
  let lastOpen=null;
  try{ lastOpen=await idbGet(LASTOPEN_KEY); }catch(e){ lastOpen=lsGet(LASTOPEN_KEY); }
  const markOpened=async()=>{ try{ await idbSet(LASTOPEN_KEY,today); }catch(e){ lsSet(LASTOPEN_KEY,today); } };

  if(!lastOpen || lastOpen>=today){ await markOpened(); return; } // first-ever run, or already handled today

  const prevDay=await getDay(lastOpen);
  const openTasks=[];
  dayWorkers(prevDay).forEach(w=>{
    (prevDay[w]||[]).forEach(t=>{ if(!isDone(t)) openTasks.push({w,t}); });
  });
  if(!openTasks.length){ await markOpened(); return; }

  const todayDay=await getDay(today);
  openTasks.forEach(({w,t})=>{
    if(!Array.isArray(todayDay[w])) todayDay[w]=[];
    todayDay[w].push({id:newId(), text:t.text, pct:t.pct, reason:t.reason||"", carriedFrom:lastOpen});
  });
  try{ await idbSet(today,todayDay); }catch(e){ lsSet(today,todayDay); }
  await markOpened();
  showToast(
    (openTasks.length===1?"1 unfinished task":openTasks.length+" unfinished tasks")+" carried over from "+fmtDate(lastOpen)+".",
    "success"
  );
}

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
  name=(name||"").trim();
  if(!name){ showToast("Enter a name first.","warn"); return; }
  if(name.length>MAX_NAME_LEN){ showToast("Name is too long (max "+MAX_NAME_LEN+" characters).","warn"); return; }
  if(WORKERS.some(w=>w.toLowerCase()===name.toLowerCase())){ showToast(name+" is already on the crew.","warn"); return; }
  WORKERS.push(name);
  saveWorkers();
  if(!Array.isArray(state[name])) state[name]=[]; // so today's view/add-task works immediately
  save(); render(); renderCrewList();
  showToast(name+" added to the crew.","success");
}
function removeWorker(name){
  showConfirmModal(
    `Remove ${name} from the crew?`,
    `This only takes them off the active list for adding new tasks — every task they've already logged stays saved and still shows up on the days/weeks/PDF reports where it happened.`,
    ()=>{ WORKERS=WORKERS.filter(w=>w!==name); saveWorkers(); render(); renderCrewList(); }
  );
}

/* Crew list shown inside Settings — a clearly-labeled, dedicated place to add
   or remove workers (in addition to the inline controls on the Today view),
   since the inline "+"/"×" controls there are easy to miss. */
function renderCrewList(){
  const el=document.getElementById("crewList"); if(!el) return;
  if(!WORKERS.length){ el.innerHTML='<div class="crew-empty">No crew members yet — add one below.</div>'; return; }
  el.innerHTML=WORKERS.map(name=>
    `<div class="crew-row"><div class="cr-name">${esc(name)}</div><button class="cr-remove" data-w="${esc(name)}">Remove</button></div>`
  ).join("");
}

/* ---------- custom confirm modal (no blocking window.confirm) ---------- */
let _confirmYes=null;
function showConfirmModal(title,body,onYes,yesLabel){
  _confirmYes=onYes;
  document.getElementById("confirmTitle").textContent=title;
  document.getElementById("confirmBody").textContent=body;
  document.getElementById("confirmYes").textContent=yesLabel||"Remove";
  document.getElementById("confirmOverlay").classList.remove("hidden");
}
function hideConfirmModal(){ document.getElementById("confirmOverlay").classList.add("hidden"); _confirmYes=null; }

/* ---------- PIN lock (per-device passcode gate) ----------
   This is a UI-level deterrent against casual access on a shared device —
   it does not encrypt the underlying data. Losing the PIN means the only
   way back in is the "forgot PIN" reset, which erases this device's data. */
const PIN_KEY="hbr_pin_hash";
async function sha256Hex(str){
  const buf=await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
function getPinHash(){ try{ return localStorage.getItem(PIN_KEY); }catch(e){ return null; } }
function setPinHash(hash){ try{ localStorage.setItem(PIN_KEY,hash); return true; }catch(e){ return false; } }

let _pinFailCount=0, _pinLockedUntil=0;

function showLockOverlay(){ document.getElementById("lockOverlay").classList.remove("hidden"); }
function hideLockOverlay(){ document.getElementById("lockOverlay").classList.add("hidden"); isUnlocked=true; }

function initLock(){
  showLockMode(getPinHash() ? "unlock" : "setup");
  showLockOverlay();
}

function showLockMode(mode){
  document.getElementById("lockSetup").classList.toggle("hidden", mode!=="setup");
  document.getElementById("lockUnlock").classList.toggle("hidden", mode!=="unlock");
  document.getElementById("lockError").textContent="";
  if(mode==="setup"){
    document.getElementById("pinNew").value=""; document.getElementById("pinNew2").value="";
    setTimeout(()=>document.getElementById("pinNew").focus(),50);
  } else {
    document.getElementById("pinEnter").value="";
    setTimeout(()=>document.getElementById("pinEnter").focus(),50);
  }
}

async function submitPinSetup(){
  const a=document.getElementById("pinNew").value.trim();
  const b=document.getElementById("pinNew2").value.trim();
  const err=document.getElementById("lockError");
  if(!/^\d{4,8}$/.test(a)){ err.textContent="PIN must be 4–8 digits."; return; }
  if(a!==b){ err.textContent="PINs don't match — try again."; return; }
  setPinHash(await sha256Hex(a));
  hideLockOverlay();
  showToast("PIN set. You'll need it next time you open the tracker here.","success");
}

async function submitPinUnlock(){
  const now=Date.now();
  if(now<_pinLockedUntil){
    document.getElementById("lockError").textContent="Too many tries — wait a few seconds and try again.";
    return;
  }
  const v=document.getElementById("pinEnter").value.trim();
  const hash=await sha256Hex(v);
  if(hash===getPinHash()){
    _pinFailCount=0;
    hideLockOverlay();
  } else {
    _pinFailCount++;
    document.getElementById("pinEnter").value="";
    document.getElementById("pinEnter").focus();
    if(_pinFailCount>=5){
      _pinLockedUntil=now+10000; _pinFailCount=0;
      document.getElementById("lockError").textContent="Too many wrong tries — wait 10 seconds.";
    } else {
      document.getElementById("lockError").textContent="Incorrect PIN — try again.";
    }
  }
}

function resetAppData(){
  showConfirmModal(
    "Erase all data on this device?",
    "This deletes every saved day, the crew roster, and the PIN itself — use this only if you've forgotten the PIN. This cannot be undone. Export a backup first if you can.",
    async ()=>{
      // IndexedDB clearing is best-effort and can hang if another tab/window holds
      // an open connection — never let that block the actual recovery path (the
      // PIN itself lives in localStorage), so race it against a short timeout.
      try{
        await Promise.race([
          (async()=>{
            const db=await openDB();
            await new Promise((res)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).clear(); tx.oncomplete=res; tx.onerror=res; tx.onabort=res; });
          })(),
          new Promise(res=>setTimeout(res,3000))
        ]);
      }catch(e){}
      try{ Object.keys(localStorage).filter(k=>k.startsWith("hbr_")).forEach(k=>localStorage.removeItem(k)); }catch(e){}
      location.reload();
    },
    "Erase data"
  );
}

/* ---------- settings panel ---------- */
function openSettings(){
  document.getElementById("settingsOverlay").classList.remove("hidden");
  document.getElementById("settingsVersion").textContent="HBR Crew Tracker · v"+APP_VERSION;
  document.getElementById("changePinForm").classList.add("hidden");
  renderCrewList();
}
function closeSettings(){ document.getElementById("settingsOverlay").classList.add("hidden"); }

function openChangePin(){
  document.getElementById("changePinForm").classList.remove("hidden");
  ["cpCurrent","cpNew","cpNew2"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("cpError").textContent="";
  setTimeout(()=>document.getElementById("cpCurrent").focus(),50);
}

async function submitChangePin(){
  const cur=document.getElementById("cpCurrent").value.trim();
  const a=document.getElementById("cpNew").value.trim();
  const b=document.getElementById("cpNew2").value.trim();
  const err=document.getElementById("cpError");
  const curHash=await sha256Hex(cur);
  if(curHash!==getPinHash()){ err.textContent="Current PIN is incorrect."; return; }
  if(!/^\d{4,8}$/.test(a)){ err.textContent="New PIN must be 4–8 digits."; return; }
  if(a!==b){ err.textContent="New PINs don't match."; return; }
  setPinHash(await sha256Hex(a));
  document.getElementById("changePinForm").classList.add("hidden");
  showToast("PIN updated.","success");
}

function lockNow(){
  closeSettings();
  isUnlocked=false;
  showLockMode("unlock");
  showLockOverlay();
}

/* ---------- backup / restore ---------- */
async function exportBackup(){
  try{
    let all={}; try{ all=await idbAll(); }catch(e){}
    const days={...all}; const workersFromIdb=days[WORKERS_KEY]; delete days[WORKERS_KEY]; delete days[LASTOPEN_KEY];
    // also sweep localStorage for any day records IDB might be missing (private-mode fallback)
    try{
      Object.keys(localStorage).forEach(k=>{
        if(k.startsWith("hbr_") && k!=="hbr_pin_hash" && k!=="hbr_install_dismissed"){
          const day=k.slice(4);
          if(day!=="__workers__" && day!==LASTOPEN_KEY && !(day in days)){
            const v=lsGet(day); if(v) days[day]=v;
          }
        }
      });
    }catch(e){}
    const payload={ app:"hbr-crew-tracker", version:1, exportedAt:new Date().toISOString(),
      workers: Array.isArray(workersFromIdb)&&workersFromIdb.length? workersFromIdb : WORKERS, days };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const fname="HBR_Backup_"+todayStr()+".json";
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=fname; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },1000);
    showToast("Backup exported — check your downloads.","success");
  }catch(e){ showToast("Couldn't create the backup file.","error"); }
}

function triggerImport(){ document.getElementById("importFile").click(); }

async function handleImportFile(file){
  if(!file) return;
  try{
    const text=await file.text();
    const data=JSON.parse(text);
    if(!data || typeof data.days!=="object" || !Array.isArray(data.workers)) throw new Error("bad shape");
    const dayCount=Object.keys(data.days).length;
    showConfirmModal(
      "Restore this backup?",
      "This will overwrite the crew roster and any matching dates ("+dayCount+" day"+(dayCount===1?"":"s")+") with data from this file"+(data.exportedAt?(" (exported "+new Date(data.exportedAt).toLocaleDateString()+")"):"")+". Days not in the file are left as-is.",
      async ()=>{
        try{
          for(const [d,rec] of Object.entries(data.days)){
            if(d===WORKERS_KEY || d===LASTOPEN_KEY) continue; // never treat special keys as day records
            if(!rec || typeof rec!=="object") continue; // skip malformed entries instead of aborting the whole restore
            const clean=normalize(JSON.parse(JSON.stringify(rec)));
            try{ await idbSet(d,clean); }catch(e){ lsSet(d,clean); }
          }
          const cleanWorkers=[...new Set(data.workers.map(w=>String(w).trim()).filter(Boolean))];
          if(cleanWorkers.length){ WORKERS=cleanWorkers; await saveWorkers(); }
          await load();
          if(currentView==="weekly") renderWeek();
          showToast("Backup restored.","success");
        }catch(e){ showToast("Restore failed partway through — check your data.","error"); }
      },
      "Restore"
    );
  }catch(e){ showToast("That file doesn't look like a valid HBR backup.","error"); }
}

/* ---------- mutations ---------- */
function addTask(w,text){
  text=(text||"").trim(); if(!text) return;
  if(text.length>MAX_TASK_LEN){ showToast("Task text is too long (max "+MAX_TASK_LEN+" characters).","warn"); return; }
  state[w].push({id:newId(),text,pct:0,reason:""}); save(); render();
}
function toggle(w,id){ const t=state[w].find(x=>String(x.id)===String(id)); if(t){ t.pct=isDone(t)?0:100; if(t.pct===100) t.reason=""; } save(); render(); }
function del(w,id){ state[w]=state[w].filter(x=>String(x.id)!==String(id)); save(); render(); }
function setReason(w,id,v){ const t=state[w].find(x=>String(x.id)===String(id)); if(t) t.reason=String(v).slice(0,MAX_REASON_LEN); save(); }
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

/* ---------- print a single worker's task list ----------
   Opens a clean, paper-friendly page in a new tab/window and triggers the
   browser's print dialog, so a worker can be handed a printed copy. */
function printWorkerTasks(w){
  const tasks=state[w]||[];
  const done=tasks.filter(t=>isDone(t)).length;
  const rows=tasks.map(t=>{
    const p=pctOf(t), tDone=isDone(t);
    const status=tDone?"Done":(p>0?p+"% done":"Not started");
    return `<tr><td class="pc-check">${tDone?"&#10003;":""}</td><td>${esc(t.text)}</td>
      <td>${esc(status)}</td><td>${esc(t.reason||"")}</td></tr>`;
  }).join("");
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${esc(w)} — ${esc(fmtDate(currentDate))}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:32px;}
  .hdr{border-bottom:3px solid #ffb020;padding-bottom:14px;margin-bottom:18px;}
  .hdr .co{font-weight:800;font-size:20px;letter-spacing:-.01em;}
  .hdr .sub{color:#555;font-size:13px;margin-top:2px;}
  h1{font-size:18px;margin:0 0 4px;}
  .meta{color:#444;font-size:13px;margin-bottom:18px;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;}
  th{text-align:left;background:#f0f0f0;padding:8px 10px;border-bottom:2px solid #ccc;font-size:11.5px;
    text-transform:uppercase;letter-spacing:.04em;color:#555;}
  td{padding:9px 10px;border-bottom:1px solid #ddd;vertical-align:top;}
  .pc-check{width:26px;text-align:center;font-weight:700;color:#1a8a3e;}
  .summary{margin-top:18px;font-size:13.5px;font-weight:700;}
  .sig{margin-top:54px;display:flex;gap:40px;}
  .sig div{flex:1;border-top:1px solid #999;padding-top:6px;font-size:12px;color:#555;}
  @media print{ body{padding:18px;} }
</style></head><body>
<div class="hdr"><div class="co">Hampton Bays Remodeling Corp.</div><div class="sub">Daily Task List</div></div>
<h1>${esc(w)}</h1>
<div class="meta">${esc(fmtDate(currentDate))}</div>
<table><thead><tr><th></th><th>Task</th><th>Status</th><th>Notes</th></tr></thead>
<tbody>${rows||'<tr><td colspan="4" style="color:#888;font-style:italic;">No tasks logged for this day.</td></tr>'}</tbody></table>
<div class="summary">${done} of ${tasks.length} tasks complete</div>
<div class="sig"><div>Worker signature</div><div>Date</div></div>
</body></html>`;
  const win=window.open("","_blank");
  if(!win){ showToast("Pop-up blocked — allow pop-ups to print.","warn"); return; }
  win.document.open(); win.document.write(html); win.document.close();
  setTimeout(()=>{ try{ win.focus(); win.print(); }catch(e){} },300);
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
  const PCT_STEPS=[]; for(let v=100;v>=0;v-=5) PCT_STEPS.push(v);
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
          ${tasks.length?`<div class="w-print" data-w="${esc(w)}" data-act="print">Print</div>`:''}
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
              const rows=PCT_STEPS.map(v=>`<div class="pct-table-row ${p===v?'active':''}" data-w="${esc(w)}" data-id="${t.id}" data-act="setpct" data-val="${v}">
                  <div class="ptr-bar"><i style="width:${v}%;background:${pctColor(v)}"></i></div>
                  <div class="ptr-val">${v}%</div></div>`).join("");
              why=`<div class="why"><div class="pct-table-label">Scroll to set % complete</div><div class="pct-table">${rows}</div><input data-w="${esc(w)}" data-id="${t.id}" data-act="reason" maxlength="${MAX_REASON_LEN}" placeholder="Why isn't this done? (materials, weather, client…)" value="${esc(t.reason)}"></div>`;
            } else {
              const parts=[]; if(p>0) parts.push(p+"% done"); if(t.reason) parts.push(t.reason);
              if(parts.length) why=`<div class="why-tag" data-w="${esc(w)}" data-id="${t.id}" data-act="editreason">⚠ ${esc(parts.join(" — "))}</div>`;
            }
          }
          const carriedTag=t.carriedFrom?`<div class="carried-tag">&#8635; carried over from ${esc(fmtDate(t.carriedFrom))}</div>`:"";
          return `<div class="task ${tDone?'done':''}">
            <div class="t-row">
              <div class="check ${tDone?'on':''}" data-w="${esc(w)}" data-id="${t.id}" data-act="toggle">${tDone?'✓':''}</div>
              <div class="t-text" data-w="${esc(w)}" data-id="${t.id}" data-act="openreason">${esc(t.text)}</div>
              <div class="x" data-w="${esc(w)}" data-id="${t.id}" data-act="del">×</div>
            </div>${carriedTag}${why}</div>`;
        }).join("")}
        ${isActive?`<div class="add"><input type="text" placeholder="Add task for ${esc(w.split(' ')[0])}…" maxlength="${MAX_TASK_LEN}" data-w="${esc(w)}"><button data-w="${esc(w)}" data-act="add">+</button></div>`:''}
      </div>`;
    wrap.appendChild(div);
  });
  const addWorkerDiv=document.createElement("div"); addWorkerDiv.className="add-worker";
  addWorkerDiv.innerHTML=`<input type="text" id="newWorkerName" placeholder="Add crew member…" maxlength="${MAX_NAME_LEN}"><button data-act="addworker">+</button>`;
  wrap.appendChild(addWorkerDiv);
  // Scroll the open %-table so the currently-set value is in view, without
  // jumping the whole page (manual scrollTop on the small inner container).
  const activeRow=wrap.querySelector(".pct-table-row.active");
  if(activeRow){
    const tbl=activeRow.closest(".pct-table");
    if(tbl) tbl.scrollTop=activeRow.offsetTop-tbl.clientHeight/2+activeRow.clientHeight/2;
  }
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
  if(!window.jspdf){ showToast("Report tool still loading — try again in a moment.","warn"); return; }
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
  else if(act==="print"){ printWorkerTasks(w); }
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
daily.addEventListener("mousedown",e=>{ if(e.target.closest(".pct-chip,.pct-table-row")) e.preventDefault(); });

document.getElementById("datePicker").addEventListener("change",e=>{ currentDate=e.target.value||todayStr(); openReason=null; sync(); load(); });
document.getElementById("prevDay").addEventListener("click",()=>{ currentDate=shiftDay(currentDate,-1); openReason=null; sync(); load(); });
document.getElementById("nextDay").addEventListener("click",()=>{ currentDate=shiftDay(currentDate,1); openReason=null; sync(); load(); });
document.getElementById("todayBtn").addEventListener("click",()=>{ currentDate=todayStr(); openReason=null; sync(); load(); });
document.getElementById("weekPicker").addEventListener("change",renderWeek);
document.getElementById("exportPdf").addEventListener("click",exportPDF);
document.getElementById("confirmCancel").addEventListener("click",hideConfirmModal);
document.getElementById("confirmYes").addEventListener("click",()=>{ const fn=_confirmYes; hideConfirmModal(); if(fn) fn(); });
document.getElementById("confirmOverlay").addEventListener("click",e=>{ if(e.target.id==="confirmOverlay") hideConfirmModal(); });

/* settings + PIN lock wiring */
document.getElementById("settingsBtn").addEventListener("click",openSettings);
document.getElementById("settingsClose").addEventListener("click",closeSettings);
document.getElementById("settingsOverlay").addEventListener("click",e=>{ if(e.target.id==="settingsOverlay") closeSettings(); });
document.getElementById("changePinBtn").addEventListener("click",openChangePin);
document.getElementById("cpSubmit").addEventListener("click",submitChangePin);
document.getElementById("lockNowBtn").addEventListener("click",lockNow);
document.getElementById("exportBackupBtn").addEventListener("click",exportBackup);
document.getElementById("importBackupBtn").addEventListener("click",triggerImport);
document.getElementById("importFile").addEventListener("change",e=>{ handleImportFile(e.target.files[0]); e.target.value=""; });
document.getElementById("resetAppBtn").addEventListener("click",resetAppData);
document.getElementById("crewAddBtn").addEventListener("click",()=>{
  const inp=document.getElementById("crewAddName"); addWorker(inp.value); inp.value=""; inp.focus();
});
document.getElementById("crewAddName").addEventListener("keydown",e=>{
  if(e.key==="Enter"){ const inp=e.target; addWorker(inp.value); inp.value=""; inp.focus(); }
});
document.getElementById("crewList").addEventListener("click",e=>{
  const btn=e.target.closest(".cr-remove"); if(btn) removeWorker(btn.dataset.w);
});
document.getElementById("pinSetupBtn").addEventListener("click",submitPinSetup);
document.getElementById("pinUnlockBtn").addEventListener("click",submitPinUnlock);
document.getElementById("pinForgot").addEventListener("click",resetAppData);
document.getElementById("pinNew2").addEventListener("keydown",e=>{ if(e.key==="Enter") submitPinSetup(); });
document.getElementById("pinEnter").addEventListener("keydown",e=>{ if(e.key==="Enter") submitPinUnlock(); });
document.getElementById("cpNew2").addEventListener("keydown",e=>{ if(e.key==="Enter") submitChangePin(); });
document.querySelectorAll(".pin-input").forEach(inp=>{
  inp.addEventListener("input",()=>{ inp.value=inp.value.replace(/\D/g,"").slice(0,8); });
});

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
  await carryOverUnfinishedTasks(); // roll yesterday's open tasks into today, once
  sync();
  document.getElementById("weekPicker").value=currentDate;
  await load();
  maybeShowInstall();
  initLock();
  if("serviceWorker" in navigator){
    window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
  }
})();

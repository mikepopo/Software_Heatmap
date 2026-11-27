(function (root) {
"use strict";
const REPO = "mikepopo/Software_Heatmap";
const BRANCH = "main";
const STATE_PATH = "PaPer/reading-state.json";
const RAW = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/";
const SITE = "https://mikepopo.github.io/Software_Heatmap/PaPer/";
const CACHE = "paper-reading.state.v1";
const AUTH_STORE = "paper-reading.supabase.session.v1";
const STAGES = ["Abstract · Introduction · Related Work", "Method1", "Method2", "Experiment · Conclusion", "总结"];
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("paper-reading.v1") : null;
let queue = Promise.resolve();
let lastUploadedId = null;

function day(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("阅读记录包含无效时间。");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}
function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validate(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.papers) || !Array.isArray(state.legacyReadDates) || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("论文记录格式无效，已停止写入。");
  if (state.deletedPapers && !Array.isArray(state.deletedPapers)) throw new Error("回收站记录格式无效。");
  for (const entry of state.deletedPapers || []) {
    if (!entry?.paper || !Number.isFinite(new Date(entry.deletedAt).getTime()) || (entry.pdfBackup && (!/^PaPer\/papers\/[\w.-]+\.pdf$/i.test(entry.pdfBackup.path) || !/^[a-f0-9]{40}$/i.test(entry.pdfBackup.sha)))) throw new Error("回收站记录格式无效。");
  }
  if (state.deskNote && (typeof state.deskNote.text !== "string" || state.deskNote.text.length > 4000 || !Number.isFinite(new Date(state.deskNote.updatedAt).getTime()))) throw new Error("便签格式无效。");
  const ids = new Set();
  for (const paper of state.papers.concat((state.deletedPapers || []).map(entry => entry.paper))) {
    if (!paper || typeof paper.id !== "string" || ids.has(paper.id) || !String(paper.title || "").trim() || !Array.isArray(paper.stages) || paper.stages.length !== 5) throw new Error("论文记录不完整，已停止写入。");
    ids.add(paper.id);
    let gap = false;
    for (const stage of paper.stages) {
      if (!stage) { gap = true; continue; }
      if (gap || !stage.at || !Number.isFinite(new Date(stage.at).getTime())) throw new Error("五阶段阅读顺序异常，已停止写入。");
    }
    if (paper.completedDate && !validDay(paper.completedDate)) throw new Error("论文完成日期无效。");
  }
  if (!state.legacyReadDates.every(validDay)) throw new Error("历史打卡日期无效。");
  for (const [date, pause] of Object.entries(state.dayPauses || {})) {
    if (!validDay(date) || !pause || typeof pause.reason !== "string" || !pause.reason.trim() || pause.reason.length > 500 || day(pause.at) !== date || (pause.resumedAt && day(pause.resumedAt) !== date)) throw new Error("暂停阅读记录格式无效。");
  }
  return state;
}
function spineTitle(value) {
  const title = String(value || "").replace(/\.pdf$/i, "").trim();
  const parts = title.match(/^(.+)_([^_]+)_(\d{4})$/);
  return parts ? parts[1] : title;
}
function pauseFor(state, date = day(new Date())) { const pause = state?.dayPauses?.[date]; return pause && !pause.resumedAt ? pause : null; }
function dayDescription(state, date) {
  const read = readDates(state).includes(date), pause = state.dayPauses?.[date];
  const parts = [date, read ? "✓ 阅读已打卡" : "未打卡"];
  if (pause) parts.push((pause.resumedAt ? "曾暂停：" : read ? "阅读后暂停：" : "未打卡原因：") + pause.reason);
  return parts.join(" · ");
}
function isComplete(paper) { return Boolean(paper.completedDate) || paper.stages.every(Boolean); }
function completedDate(paper) { return paper.completedDate || (isComplete(paper) ? day(paper.stages[4].at) : ""); }
function pdfURL(paper) {
  if (!paper.pdf) return "";
  const url = new URL(paper.pdf, SITE);
  return ["https:", "http:"].includes(url.protocol) ? url.href : "";
}
function completed(state) {
  return state.papers.filter(isComplete).map(paper => ({ id: paper.id, title: paper.title, pdf: pdfURL(paper), date: completedDate(paper) }));
}
function pending(state) {
  return state.papers.filter(paper => !isComplete(paper)).map(paper => ({ id: paper.id, title: paper.title, pdf: pdfURL(paper), date: day(paper.addedAt) }));
}
function readDates(state) {
  const dates = new Set(state.legacyReadDates);
  for (const paper of state.papers) {
    for (const stage of paper.stages) if (stage) dates.add(day(stage.at));
    if (paper.completedDate) dates.add(paper.completedDate);
  }
  return [...dates].sort();
}
function applyOperation(state, operation) {
  validate(state);
  const next = JSON.parse(JSON.stringify(state));
  const date = day(operation.at);
  if (operation.type === "add") {
    if (next.papers.some(paper => paper.id === operation.paper.id)) return next;
    next.papers.push(operation.paper);
  } else if (operation.type === "clear-trash") {
    const expected = operation.entries || [];
    if (!Array.isArray(expected)) throw new Error("回收站清空参数无效。");
    const keys = new Set(expected.map(entry => entry.id + "|" + entry.deletedAt));
    next.deletedPapers = (next.deletedPapers || []).filter(entry => !keys.has(entry.paper.id + "|" + entry.deletedAt));
    if (next.deletedPapers.length === (state.deletedPapers || []).length) return next;
  } else if (operation.type === "note") {
    if (typeof operation.text !== "string" || operation.text.length > 4000) throw new Error("便签最多可写4000字。");
    if (operation.expectedNoteAt !== undefined && operation.expectedNoteAt !== (next.deskNote?.updatedAt || "")) throw new Error("其他页面已更新便签，草稿已保留，请先载入已保存版本。");
    if (operation.text === (next.deskNote?.text || "")) return next;
    next.deskNote = {text:operation.text,updatedAt:operation.at};
  } else if (operation.type === "delete") {
    const index = next.papers.findIndex(paper => paper.id === operation.paperId);
    if (index < 0) return next;
    const paper = next.papers[index];
    if (operation.expectedPaper && operation.expectedPaper !== JSON.stringify(paper)) throw new Error("论文记录刚刚发生变化，请刷新后重新删除。");
    next.deletedPapers ||= [];
    next.deletedPapers.push({paper,position:index,deletedAt:operation.at,...(operation.pdfBackup ? {pdfBackup:operation.pdfBackup} : {})});
    next.papers.splice(index,1);
  } else if (operation.type === "restore") {
    const index = (next.deletedPapers || []).findIndex(entry => entry.paper.id === operation.paperId);
    if (index < 0) return next;
    const entry = next.deletedPapers[index];
    if (operation.expectedDeletedAt && operation.expectedDeletedAt !== entry.deletedAt) throw new Error("回收站记录已改变，请刷新后重试。");
    next.papers.splice(Math.min(Math.max(0,entry.position || 0),next.papers.length),0,entry.paper);
    next.deletedPapers.splice(index,1);
  } else if (["stage", "undo"].includes(operation.type)) {
    const paper = next.papers.find(item => item.id === operation.paperId);
    if (!paper) throw new Error("这篇论文已不在记录中，请刷新后重试。");
    if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > 4) throw new Error("阅读阶段无效。");
    if (operation.type === "undo") {
      if (!paper.completedDate && !paper.stages[operation.index]) return next;
      if (operation.expectedStages && operation.expectedStages !== JSON.stringify(paper.stages)) throw new Error("阶段已在其他页面变动，请刷新后再次撤回。");
      next.undoHistory ||= [];
      next.undoHistory.push({paperId:paper.id,index:operation.index,at:operation.at,stages:paper.stages.slice(operation.index),...(paper.completedDate ? {completedDate:paper.completedDate} : {})});
      for (let i = operation.index; i < 5; i++) paper.stages[i] = null;
      delete paper.completedDate;
    } else {
      if (pauseFor(next, date)) throw new Error("今天已暂停阅读，请先点击继续阅读。");
      if (paper.stages[operation.index] || paper.completedDate) return next;
      if (paper.stages.slice(0, operation.index).some(stage => !stage)) throw new Error("请先完成前面的阅读阶段。");
      paper.stages[operation.index] = { at: operation.at };
    }
  } else if (operation.type === "pause") {
    const reason = String(operation.reason || "").trim();
    if (!reason || reason.length > 500) throw new Error("请填写停止阅读的原因（1–500字）。");
    next.dayPauses ||= {};
    next.dayPauses[date] = {reason, at:operation.at};
  } else if (operation.type === "resume") {
    if (!pauseFor(next, date)) return next;
    next.dayPauses[date].resumedAt = operation.at;
  } else {
    throw new Error("不支持的论文记录操作。");
  }
  next.revision++;
  next.updatedAt = operation.at;
  return validate(next);
}

const SUPABASE_URL = "https://eubjpbheryecjofphluc.supabase.co";
const SUPABASE_PUBLIC_KEY = "sb_publishable_LdJwDikOC_4_VYOpH15nCw_trqRyRxn";
const FUNCTION_URL = SUPABASE_URL + "/functions/v1/paper-reading-github";
let auth = null, session = null, backendReady = false, authError = "";
let initialized = null;
function init() {
  if(initialized)return initialized;
  initialized = (async()=>{
    if(!root.supabase?.createClient){authError="无法加载登录组件，请刷新页面。";return}
    auth = root.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLIC_KEY,{auth:{storageKey:AUTH_STORE,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
    auth.auth.onAuthStateChange((_event,next)=>{session=next;if(!next)backendReady=false;});
    const result=await auth.auth.getSession();if(result.error){authError="登录状态无法恢复，请重新登录。";return}
    session=result.data.session;
  })().catch(()=>{authError="登录组件初始化失败，请刷新。"});
  return initialized;
}
function token(){return Boolean(session&&backendReady)}
function cached() { try { const value=JSON.parse(localStorage.getItem(CACHE)||"null");return value?validate(value):null; } catch {return null;} }
function remember(state,notify){
  try{localStorage.setItem(CACHE,JSON.stringify(state));}catch{}
  if(notify){channel?.postMessage({revision:state.revision});root.dispatchEvent?.(new CustomEvent("paper-reading-change",{detail:state.revision}));}
  return state;
}
async function rpc(action,body,headers={}){
  await init();
  if(!auth)throw Error(authError||"登录组件不可用。");
  const result=await auth.auth.getSession();if(result.error||!result.data.session){session=null;backendReady=false;throw Error("请先登录云端账号。");}
  session=result.data.session;
  const response=await fetch(FUNCTION_URL+"?action="+encodeURIComponent(action),{method:"POST",cache:"no-store",headers:{apikey:SUPABASE_PUBLIC_KEY,Authorization:"Bearer "+session.access_token,...headers},body});
  const data=await response.json().catch(()=>null);
  if(!response.ok){
    authError=data?.error||("云端请求失败（HTTP "+response.status+"）。");
    if([401,403,503].includes(response.status))backendReady=false;
    const e=Error(authError);e.status=response.status;throw e;
  }
  backendReady=true;authError="";
  if(!data?.state)throw Error("云端没有返回论文记录。");
  return {...data,state:validate(data.state)};
}
async function load(options={}){
  await init();
  if(session){
    try{return remember((await rpc("state")).state,Boolean(options.notify));}catch(e){authError=e.message;}
  }
  const response=await fetch(RAW+STATE_PATH+"?t="+Date.now(),{cache:"no-store"});
  if(!response.ok)throw Error("论文记录读取失败（HTTP "+response.status+"）。");
  const remote=validate(await response.json()),local=cached();
  return remember(local&&local.revision>remote.revision?local:remote,Boolean(options.notify));
}
async function connect(email,password){
  await init();if(!auth)throw Error(authError||"登录组件不可用。");
  if(email&&password){const result=await auth.auth.signInWithPassword({email:email.trim(),password});if(result.error)throw Error("登录失败，请确认邮箱和密码。");session=result.data.session;}
  if(!session)throw Error("请填写已有 Supabase 云同步账号的邮箱和密码。");
  return remember((await rpc("state")).state,true);
}
async function disconnect(){
  await init();if(auth){const result=await auth.auth.signOut({scope:"local"});if(result.error)throw Error("退出失败，请重试。");}
  session=null;backendReady=false;authError="";
}
function commitOperation(operation){
  const run=async()=>remember((await rpc("operation",JSON.stringify(operation),{"Content-Type":"application/json"})).state,true);
  const result=queue.then(run);queue=result.catch(()=>{});return result;
}
async function upload(file){
  if(file.size>12*1024*1024)throw Error("当前云端单篇 PDF 最大为 12 MiB，较大的文件请暂用原版阅读台上传。");
  if(!file.name.toLowerCase().endsWith(".pdf"))throw Error("请上传 PDF 文件。");
  const run=async()=>{const data=await rpc("upload",file,{"Content-Type":"application/pdf","x-paper-name":encodeURIComponent(file.name)});lastUploadedId=data.lastUploadedId||null;return remember(data.state,true);};
  const result=queue.then(run);queue=result.catch(()=>{});return result;
}
function watch(listener){
  let revision=cached()?.revision??-1;
  const changed=()=>{const state=cached();if(state&&state.revision!==revision){revision=state.revision;listener(state);}};
  root.addEventListener?.("storage",e=>{if(e.key===CACHE)changed();});
  root.addEventListener?.("paper-reading-change",changed);
  channel?.addEventListener("message",changed);
  setInterval(async()=>{if(root.document?.hidden)return;try{const state=await load();if(state.revision!==revision){revision=state.revision;listener(state);}}catch{}},60000);
}
root.PaperData={STAGES,day,spineTitle,pauseFor,dayDescription,get lastUploadedId(){return lastUploadedId;},get authError(){return authError;},get signedIn(){return Boolean(session);},validate,isComplete,completedDate,completed,pending,readDates,applyOperation,load,watch,token,connect,disconnect,upload,commitOperation};
if(typeof module==="object"&&module.exports)module.exports=root.PaperData;
})(typeof window==="object"?window:globalThis);

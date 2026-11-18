(function (root) {
"use strict";
const REPO = "mikepopo/Software_Heatmap";
const BRANCH = "main";
const STATE_PATH = "PaPer/reading-state.json";
const API = "https://api.github.com/repos/" + REPO + "/contents/";
const RAW = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/";
const SITE = "https://mikepopo.github.io/Software_Heatmap/PaPer/";
const CACHE = "paper-reading.state.v1";
const TOKEN = "paper-reading.github.session.v1";
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
function decode(text) {
  const bytes = Uint8Array.from(atob(text.replace(/\s/g, "")), character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function encode(text) { return bytesToBase64(new TextEncoder().encode(text)); }
function bytesToBase64(bytes) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
function token() { try { return sessionStorage.getItem(TOKEN) || ""; } catch (error) { return ""; } }
function cached() { try { const value = JSON.parse(localStorage.getItem(CACHE) || "null"); return value ? validate(value) : null; } catch (error) { return null; } }
function remember(state, notify) {
  try { localStorage.setItem(CACHE, JSON.stringify(state)); } catch (error) {}
  if (notify) {
    channel?.postMessage({ revision: state.revision });
    root.dispatchEvent?.(new CustomEvent("paper-reading-change", { detail: state.revision }));
  }
  return state;
}
async function request(path, options = {}) {
  const key = token();
  if (!key) throw new Error("请先连接 GitHub，再上传或确认阅读。");
  const response = await fetch("https://api.github.com/repos/" + REPO + "/" + path, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/vnd.github+json", Authorization: "Bearer " + key, "X-GitHub-Api-Version": "2022-11-28", ...(options.headers || {}) }
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "GitHub 凭据已失效，请重新连接。" : response.status === 403 ? "GitHub 拒绝写入，请检查该仓库的 Contents 读写权限与请求额度。" : response.status === 409 || response.status === 422 ? "记录刚刚被更新，正在重新读取。" : "GitHub 请求失败（HTTP " + response.status + "）。");
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function api(path, options = {}) { return request("contents/" + path, options); }
async function freshState() {
  const file = await api(STATE_PATH + "?ref=" + BRANCH);
  if (typeof file.content !== "string" || !file.sha) throw new Error("无法读取 GitHub 中的论文记录。");
  return { state: validate(JSON.parse(decode(file.content))), sha: file.sha };
}
async function load(options = {}) {
  try {
    if (token()) return remember((await freshState()).state, Boolean(options.notify));
    const response = await fetch(RAW + STATE_PATH + "?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("论文记录读取失败（HTTP " + response.status + "）。");
    const remote = validate(await response.json());
    const local = cached();
    return remember(local && local.revision > remote.revision ? local : remote, Boolean(options.notify));
  } catch (error) {
    // The caller decides whether and how to surface a failed refresh.
    throw new Error(error.message || "无法读取 GitHub 论文记录，请点击刷新重试。");
  }
}
function paperPath(paper) {
  if (!paper.pdf) return "";
  if (!/^papers\/[\w.-]+\.pdf$/i.test(paper.pdf)) throw new Error("PDF 路径不在本仓库的 papers 目录，已停止删除。");
  return "PaPer/" + paper.pdf;
}
async function commitFileOperation(operation) {
  for (let attempt=0;attempt<3;attempt++) {
    const head = (await request("git/ref/heads/" + BRANCH)).object.sha;
    const treeSha = (await request("git/commits/" + head)).tree.sha;
    const file = await api(STATE_PATH + "?ref=" + head);
    const state = validate(JSON.parse(decode(file.content)));
    const entries = await request("git/trees/" + treeSha + "?recursive=1");
    if (entries.truncated) throw new Error("文件列表不完整，已停止删除或恢复。");
    const active = state.papers.find(paper=>paper.id===operation.paperId);
    const deleted = state.deletedPapers?.find(entry=>entry.paper.id===operation.paperId);
    if (operation.type==="delete" && !active || operation.type==="restore" && !deleted) return remember(state,true);
    let pdfEntry = null, op = {...operation};
    if (operation.type==="delete") {
      const path=paperPath(active);
      if (path) {
        if(state.papers.some(paper=>paper.id!==active.id && paperPath(paper)===path)) throw new Error("这份 PDF 还被另一条论文记录使用，请先处理重复记录。");
        const blob=entries.tree.find(entry=>entry.path===path && entry.type==="blob");
        if(blob){op.pdfBackup={path,sha:blob.sha};pdfEntry={path,mode:"100644",type:"blob",sha:null};}
      }
    } else {
      const path=paperPath(deleted.paper);
      if(path && !deleted.pdfBackup) throw new Error("原 PDF 已缺失，无法完整恢复，请重新上传。");
      if(path){
        const present=entries.tree.find(entry=>entry.path===path);
        if(present && present.sha!==deleted.pdfBackup.sha) throw new Error("该路径已有另一份 PDF，已停止恢复。");
        if(!present) pdfEntry={path,mode:"100644",type:"blob",sha:deleted.pdfBackup.sha};
      }
    }
    const next = applyOperation(state,op);
    if(next.revision===state.revision) return remember(state,true);
    const tree=[{path:STATE_PATH,mode:"100644",type:"blob",content:JSON.stringify(next,null,2)+"\n"}];
    if(pdfEntry) tree.push(pdfEntry);
    try {
      const createdTree=await request("git/trees",{method:"POST",body:JSON.stringify({base_tree:treeSha,tree})});
      const commit=await request("git/commits",{method:"POST",body:JSON.stringify({message:operation.type==="delete"?"Delete paper PDF and reading record":"Restore paper PDF and reading record",tree:createdTree.sha,parents:[head]})});
      await request("git/refs/heads/"+BRANCH,{method:"PATCH",body:JSON.stringify({sha:commit.sha,force:false})});
      const verified=(await freshState()).state;
      const present=verified.papers.some(paper=>paper.id===operation.paperId);
      if(operation.type==="delete" ? present || !verified.deletedPapers?.some(entry=>entry.paper.id===operation.paperId) : !present) throw new Error("删除或恢复后的回读未通过，请刷新检查。");
      return remember(verified,true);
    } catch(error) {
      if(![409,422].includes(error.status) || attempt===2) throw error;
    }
  }
}

function commitOperation(operation) {
  const run = async () => {
    if (["delete","restore"].includes(operation.type)) return commitFileOperation(operation);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, sha } = await freshState();
      const next = applyOperation(state, operation);
      if (next.revision === state.revision) return remember(state, true);
      try {
        await api(STATE_PATH, { method: "PUT", body: JSON.stringify({
          message: operation.type === "add" ? "Add a paper to the reading desk" : operation.type === "stage" ? "Record paper reading stage " + (operation.index + 1) : operation.type === "undo" ? "Undo paper reading stage " + (operation.index + 1) : operation.type === "pause" ? "Record reading pause reason" : operation.type === "clear-trash" ? "Empty paper recycle bin" : operation.type === "note" ? "Save reading desk note" : "Resume paper reading",
          branch: BRANCH, sha, content: encode(JSON.stringify(next, null, 2) + "\n")
        }) });
        const verified = (await freshState()).state;
        const paper = verified.papers.find(item => item.id === (operation.paperId || operation.paper?.id));
        const confirmed = operation.type === "clear-trash" ? !(verified.deletedPapers || []).some(entry => operation.entries.some(item => item.id === entry.paper.id && item.deletedAt === entry.deletedAt)) : operation.type === "note" ? verified.deskNote?.text === operation.text : operation.type === "pause" ? pauseFor(verified, day(operation.at))?.reason === operation.reason.trim()
          : operation.type === "resume" ? !pauseFor(verified, day(operation.at))
          : operation.type === "undo" ? paper && !isComplete(paper) && !paper.stages[operation.index]
          : operation.type === "stage" ? Boolean(paper?.stages[operation.index]) : Boolean(paper);
        if (!confirmed) throw new Error("写入后的回读未通过，请重试。");
        return remember(verified, true);
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 2) throw error;
      }
    }
  };
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}
async function connect(key) {
  if (!key.trim()) throw new Error("请填写 GitHub 写入凭据。");
  try {
    sessionStorage.setItem(TOKEN, key.trim());
    const { state } = await freshState();
    return remember(state, false);
  } catch (error) {
    sessionStorage.removeItem(TOKEN);
    throw error;
  }
}
function disconnect() { try { sessionStorage.removeItem(TOKEN); } catch (error) {} }
async function upload(file, title) {
  if (!token()) throw new Error("请先连接 GitHub。");
  if (file.size > 90 * 1024 * 1024) throw new Error("单篇 PDF 需小于 90 MiB。");
  if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("请上传 PDF 文件。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw new Error("文件内容不是有效的 PDF。");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  const id = "paper-" + hash;
  lastUploadedId = id;
  const current = (await freshState()).state;
  const existing = current.papers.find(paper => paper.id === id);
  const deleted = current.deletedPapers?.find(entry => entry.paper.id === id);
  if (deleted) return commitOperation({type:"restore",paperId:id,expectedDeletedAt:deleted.deletedAt,at:new Date().toISOString()});
  if (existing) return remember((await freshState()).state, true);
  const path = "PaPer/papers/" + hash + ".pdf";
  try {
    await api(path, { method: "PUT", body: JSON.stringify({ message: "Upload paper PDF", branch: BRANCH, content: bytesToBase64(bytes) }) });
  } catch (error) {
    if (![409, 422].includes(error.status)) throw error;
    const uploaded = await api(path + "?ref=" + BRANCH);
    if (uploaded.size !== bytes.length) throw new Error("PDF 上传冲突，请重试。");
  }
  const at = new Date().toISOString();
  return commitOperation({ type: "add", at, paper: { id, title: file.name.replace(/\.pdf$/i, "").trim(), originalFileName: file.name, pdf: "papers/" + hash + ".pdf", addedAt: at, stages: [null, null, null, null, null] } });
}
function watch(listener) {
  let revision = cached()?.revision ?? -1;
  const changed = () => {
    const state = cached();
    if (state && state.revision !== revision) { revision = state.revision; listener(state); }
  };
  root.addEventListener?.("storage", event => { if (event.key === CACHE) changed(); });
  root.addEventListener?.("paper-reading-change", changed);
  channel?.addEventListener("message", changed);
  setInterval(async () => {
    if (root.document?.hidden) return;
    try { const state = await load(); if (state.revision !== revision) { revision = state.revision; listener(state); } } catch (error) {}
  }, 60000);
}
root.PaperData = { STAGES, day, spineTitle, pauseFor, dayDescription, get lastUploadedId() { return lastUploadedId; }, validate, isComplete, completedDate, completed, pending, readDates, applyOperation, load, watch, token, connect, disconnect, upload, commitOperation };
if (typeof module === "object" && module.exports) module.exports = root.PaperData;
})(typeof window === "object" ? window : globalThis);

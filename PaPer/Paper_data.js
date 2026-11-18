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
  const ids = new Set();
  for (const paper of state.papers) {
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
  return state;
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
  if (operation.type === "add") {
    if (next.papers.some(paper => paper.id === operation.paper.id)) return next;
    next.papers.push(operation.paper);
  } else if (operation.type === "stage") {
    const paper = next.papers.find(item => item.id === operation.paperId);
    if (!paper) throw new Error("这篇论文已不在记录中，请刷新后重试。");
    if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > 4) throw new Error("阅读阶段无效。");
    if (paper.stages[operation.index] || paper.completedDate) return next;
    if (paper.stages.slice(0, operation.index).some(stage => !stage)) throw new Error("请先完成前面的阅读阶段。");
    paper.stages[operation.index] = { at: operation.at };
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
async function api(path, options = {}) {
  const key = token();
  if (!key) throw new Error("请先连接 GitHub，再上传或确认阅读。");
  const response = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", Accept: "application/vnd.github+json", Authorization: "Bearer " + key, "X-GitHub-Api-Version": "2022-11-28", ...(options.headers || {}) }
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "GitHub 凭据已失效，请重新连接。" : response.status === 403 ? "GitHub 拒绝写入，请检查该仓库的 Contents 读写权限与请求额度。" : response.status === 409 || response.status === 422 ? "记录刚刚被更新，正在重新读取。" : "GitHub 请求失败（HTTP " + response.status + "）。");
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function freshState() {
  const file = await api(STATE_PATH + "?ref=" + BRANCH);
  if (typeof file.content !== "string" || !file.sha) throw new Error("无法读取 GitHub 中的论文记录。");
  return { state: validate(JSON.parse(decode(file.content))), sha: file.sha };
}
async function load() {
  try {
    const response = await fetch(RAW + STATE_PATH + "?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("论文记录读取失败（HTTP " + response.status + "）。");
    const remote = validate(await response.json());
    const local = cached();
    return remember(local && local.revision > remote.revision ? local : remote, false);
  } catch (error) {
    // The caller decides whether and how to surface a failed refresh.
    throw new Error("无法读取 GitHub 论文记录，请点击刷新重试。");
  }
}
function commitOperation(operation) {
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, sha } = await freshState();
      const next = applyOperation(state, operation);
      if (next.revision === state.revision) return remember(state, true);
      try {
        await api(STATE_PATH, { method: "PUT", body: JSON.stringify({
          message: operation.type === "add" ? "Add a paper to the reading desk" : "Record paper reading stage " + (operation.index + 1),
          branch: BRANCH, sha, content: encode(JSON.stringify(next, null, 2) + "\n")
        }) });
        const verified = (await freshState()).state;
        const paper = verified.papers.find(item => item.id === (operation.paperId || operation.paper.id));
        if (!paper || (operation.type === "stage" && !paper.stages[operation.index])) throw new Error("写入后的回读未通过，请重试。");
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
  const existing = (await freshState()).state.papers.find(paper => paper.id === id);
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
  return commitOperation({ type: "add", at, paper: { id, title: (title || file.name.replace(/\.pdf$/i, "")).trim(), pdf: "papers/" + hash + ".pdf", addedAt: at, stages: [null, null, null, null, null] } });
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
root.PaperData = { STAGES, day, validate, isComplete, completedDate, completed, pending, readDates, applyOperation, load, watch, token, connect, disconnect, upload, commitOperation };
if (typeof module === "object" && module.exports) module.exports = root.PaperData;
})(typeof window === "object" ? window : globalThis);

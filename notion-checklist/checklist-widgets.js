
'use strict';

const byId = id => document.getElementById(id);
const STORE = 'daily-checklist.records.v4';
const SELECTED_DAY_STORE = 'daily-checklist.embeds.selected-day.v1';
const panel = document.body.dataset.panel;
if (window.self !== window.top) document.body.dataset.embedded = '';
const OLDER_STORES = ['daily-checklist.records.v3', 'daily-checklist.records.v2', 'daily-checklist.records.v1'];
const TASK_CATEGORIES = ['学习', '生活', '锻炼'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dateLabel = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
});

const TREE_SPECIES = {
  pine:      { name: '青松', goal: 0 },
  cherry:    { name: '樱花', goal: 5 },
  hydrangea: { name: '绣球木', goal: 8 },
  maple:     { name: '金枫', goal: 12 },
  birch:     { name: '白桦', goal: 18 },
  willow:    { name: '垂柳', goal: 25 },
  flame:     { name: '火焰木', goal: 32 },
  ginkgo:    { name: '银杏', goal: 40 },
  star:      { name: '星光树', goal: 50 },
  snowfir:   { name: '雪杉', goal: 65 },
  jacaranda: { name: '蓝花楹', goal: 85 },
  banyan:    { name: '碧玉榕', goal: 110 },
};


function treeImage(id) {
  const image = document.createElement('img');
  image.className = 'tree-art';
  image.src = TREE_SPRITES[id];
  image.alt = '';
  image.draggable = false;
  return image;
}

function getToday() {
  const parts = Object.fromEntries(shanghaiDate.formatToParts().map(part => [part.type, part.value]));
  return [parts.year, parts.month, parts.day].join('-');
}

function fromDay(day) {
  return new Date(day + 'T00:00:00Z');
}

function isDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000')) return false;
  const date = fromDay(day);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function shiftDay(day, offset) {
  const date = fromDay(day);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().split('T')[0];
}

function showStorageWarning(message) {
  const warning = byId('storage-warning');
  warning.textContent = message;
  warning.hidden = !message;
}

function readSaved(key) {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function validateRecords(value) {
  if (![1, 2, 3, 4].includes(value?.version) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days)) {
    throw new Error('Invalid backup');
  }
  const days = Object.create(null);
  for (const [day, tasks] of Object.entries(value.days)) {
    if (!isDay(day) || !Array.isArray(tasks)) throw new Error('Invalid date or task list');
    const seen = new Set();
    days[day] = tasks.map(task => {
      if (!task || typeof task.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(task.id) ||
          seen.has(task.id) || typeof task.title !== 'string' || !task.title.trim() ||
          task.title.length > 120 ||
          typeof task.done !== 'boolean') {
        throw new Error('Invalid task');
      }
      seen.add(task.id);
      if (task.tree !== undefined && !Object.hasOwn(TREE_SPECIES, task.tree)) throw new Error('Invalid tree species');
      if (task.category !== undefined && !TASK_CATEGORIES.includes(task.category)) throw new Error('Invalid task category');
      return { id: task.id, title: task.title.trim(), done: task.done, ...(task.category ? { category: task.category } : {}), ...(task.tree ? { tree: task.tree } : {}) };
    });
  }
  const recaps = Object.create(null);
  if (value.recaps !== undefined) {
    if (!value.recaps || typeof value.recaps !== 'object' || Array.isArray(value.recaps)) {
      throw new Error('Invalid daily recaps');
    }
    for (const [day, text] of Object.entries(value.recaps)) {
      if (!isDay(day) || typeof text !== 'string') throw new Error('Invalid daily recap');
      if (text.trim()) recaps[day] = text.trim();
    }
  }
  const forest = value.forest ?? { species: 'pine', peak: 0 };
  if (!Object.hasOwn(TREE_SPECIES, forest.species) || !Number.isSafeInteger(forest.peak) || forest.peak < 0) {
    throw new Error('Invalid forest settings');
  }
  return { days, recaps, forest: { species: forest.species, peak: forest.peak } };
}

function emptyRecords() {
  return { days: Object.create(null), recaps: Object.create(null), forest: { species: 'pine', peak: 0 } };
}

function readCurrentRecords() {
  for (const store of [STORE, ...OLDER_STORES]) {
    const saved = readSaved(store);
    if (saved !== null) return validateRecords(saved);
  }
  return emptyRecords();
}

let cloudSync = null;
let records = emptyRecords();
try {
  records = readCurrentRecords();
} catch {
  showStorageWarning('无法读取浏览器中的记录。你可以导入备份，或导出本次填写的清单。');
}

let today = getToday();
let selected = today;
try {
  const choice = readSaved(SELECTED_DAY_STORE);
  if (choice?.today === today && isDay(choice.day)) selected = choice.day;
} catch {
  // The task editor already displays a message if browser storage is unavailable.
}
let heatYear = Math.min(Number(selected.slice(0, 4)), Number(today.slice(0, 4)));
let filter = 'all';
let trendRange = 7;
let editing = null;
let confirmAction = null;
let pendingRecap = null;
let recapTimer;
let celebrationTimer;
let forestRange = 'day';
let forestInspection = null;
let forestDisplayScope = '';

function saveRecords(nextRecords, beforeRecords = records) {
  if (cloudSync?.active()) {
    cloudSync.enqueue(beforeRecords, nextRecords);
    records = cloudSync.view();
    return;
  }
  records = nextRecords;
  try {
    localStorage.setItem(STORE, JSON.stringify({ version: 4, ...records }));
    showStorageWarning('');
  } catch {
    showStorageWarning('浏览器无法保存记录。关闭页面前，请导出备份。');
  }
}

function latestRecords() {
  if (cloudSync?.active()) return cloudSync.view();
  try {
    if (byId('storage-warning').hidden) return readCurrentRecords();
  } catch {
    // Keep unsaved edits in memory if browser storage is unavailable.
  }
  return records;
}

function updateTasks(day, update) {
  const latest = latestRecords();
  const days = { ...latest.days };
  const before = days[day] || [];
  const total = totalTrees(latest.days);
  const previousPeak = Math.max(latest.forest.peak, total);
  const tasks = update(before, latest, previousPeak);
  if (tasks.length) days[day] = tasks;
  else delete days[day];
  const peak = Math.max(previousPeak, total - taskCounts(before).done + taskCounts(tasks).done);
  saveRecords({ ...latest, days, forest: { ...latest.forest, peak } }, latest);
  render();
  return previousPeak;
}

function renderRecap() {
  const input = byId('recap-input');
  const draft = pendingRecap?.day === selected ? pendingRecap : null;
  const text = draft?.text ?? records.recaps[selected] ?? '';
  if (input.dataset.day !== selected || (document.activeElement !== input && input.value !== text)) {
    input.value = text;
  }
  input.dataset.day = selected;
  const state = byId('recap-state');
  const message = draft ? '保存中…' : text ? (byId('storage-warning').hidden ? '已自动保存' : '暂存于本页') : '';
  if (state.textContent !== message) state.textContent = message;
}

function renderHeatRecap() {
  const preview = byId('heat-recap');
  if (!preview) return;
  const text = Number(selected.slice(0, 4)) === heatYear ? records.recaps[selected] : '';
  preview.textContent = text ? '复盘 · ' + text : '';
  preview.hidden = !text;
}

function flushRecap() {
  if (!pendingRecap) return;
  clearTimeout(recapTimer);
  const { day, text } = pendingRecap;
  pendingRecap = null;
  const latest = latestRecords();
  const cleanText = text.trim();
  if (cleanText !== (latest.recaps[day] ?? '')) {
    const recaps = { ...latest.recaps };
    if (cleanText) recaps[day] = cleanText;
    else delete recaps[day];
    saveRecords({ ...latest, recaps }, latest);
  }
  renderRecap();
  renderHeatRecap();
}

function stopCelebration() {
  clearTimeout(celebrationTimer);
  byId('progress')?.classList.remove('is-celebrating');
  const toast = byId('completion-toast');
  if (toast) toast.hidden = true;
}

function totalTrees(days) {
  return Object.values(days).reduce((sum, list) => sum + taskCounts(list).done, 0);
}

function automaticSpecies(record, peak, previousTree) {
  if (previousTree) return previousTree;
  const total = totalTrees(record.days);
  const species = Object.entries(TREE_SPECIES);
  const unlocked = species.find(([, tree]) => tree.goal > peak && tree.goal <= total + 1);
  if (unlocked) return unlocked[0];
  const available = species.filter(([, tree]) => tree.goal <= peak);
  return available[total % available.length][0];
}

function forestScope() {
  return selected.slice(0, { day: 10, month: 7, year: 4 }[forestRange]);
}

function forestEntries() {
  const scope = forestScope();
  const dates = forestRange === 'day' ? [selected] : Object.keys(records.days).filter(day => day.startsWith(scope)).sort();
  return dates.flatMap(day => currentTasks(day).filter(task => task.done).map(task => ({ day, task })));
}

const FOREST_MIN_SIDE = 5;
let forestSlots = [[2,2], [1,2], [3,1], [2,3], [1,0], [3,3], [0,3], [4,2]];
const forestUsedSlots = new Set(forestSlots.map(([x,y]) => x + ':' + y));
let forestAllocatedSide = 0;

function forestSide(count) {
  return Math.max(FOREST_MIN_SIDE, Math.ceil(Math.sqrt(count)));
}

function ensureForestSlots(side) {
  // Extend the existing orchard rather than starting a new page.
  for (let size = Math.max(FOREST_MIN_SIDE, forestAllocatedSide + 1); size <= side; size++) {
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (size > FOREST_MIN_SIDE && row !== size - 1 && col !== size - 1) continue;
        const key = col + ':' + row;
        if (!forestUsedSlots.has(key)) {
          forestUsedSlots.add(key);
          forestSlots.push([col,row]);
        }
      }
    }
  }
  forestAllocatedSide = Math.max(forestAllocatedSide, side);
}

function orchardPlot(side, column, row) {
  const depth = row / (side - 1);
  const across = column / (side - 1) - .5;
  const expansion = side - FOREST_MIN_SIDE;
  const spread = Math.min(.87, .55 + depth * .15 + Math.min(expansion, 5) * .043);
  const stagger = (row % 2 ? .028 : -.01) * Math.min(1, 7 / side);
  const farEdge = Math.max(.465, .555 - expansion * .035);
  const nearEdge = .89 + Math.min(.045, Math.max(0, side - 7) * .003);
  const jitter = Math.min(1, 7 / side);
  const x = .50 + .014 * (1 - depth) + across * spread + stagger
    + (((column * 13 + row * 7) % 9) - 4) * .0028 * jitter;
  const y = farEdge + depth * (nearEdge - farEdge)
    - across * .036 + (((column * 11 + row * 17) % 7) - 3) * .0019 * jitter;
  const baseWidth = 7.9 + 4.2 * depth - .99 * Math.min(expansion, 2) + ((column * 7 + row * 3) % 5) * .14;
  const width = side <= 7 ? baseWidth : Math.min(baseWidth * 7 / side, spread * 100 / (side - 1) * .85);
  return { x, y, width };
}

function makeForestTree({ day, task }, inspected, index, side) {
  const id = task.tree ?? 'pine';
  const item = document.createElement('li');
  item.className = 'forest-plot';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'forest-tree';
  const [column, row] = forestSlots[index];
  const { x, y, width } = orchardPlot(side, column, row);
  button.style.setProperty('--tree-width', width + '%');
  button.style.setProperty('--tree-x', x * 100 + '%');
  button.style.setProperty('--tree-y', y * 100 + '%');
  button.style.setProperty('--tree-depth', String(Math.round(y * 1000)));
  button.style.setProperty('--breeze-delay', (-index * .42) + 's');
  button.dataset.treeId = task.id;
  button.dataset.treeDay = day;
  button.title = shortDate(day) + ' · ' + TREE_SPECIES[id].name + ' · ' + task.title;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(inspected?.day === day && inspected?.task.id === task.id));
  const art = treeImage(id);
  // Avoid hundreds of simultaneous idle animations in the annual view.
  if (side > 10) art.style.animation = 'none';
  button.append(art);
  item.append(button);
  return item;
}

function renderForestGuide(peak, total) {
  const collection = Object.create(null);
  for (const list of Object.values(records.days)) {
    for (const task of list) {
      if (!task.done) continue;
      const id = task.tree ?? 'pine';
      collection[id] = (collection[id] || 0) + 1;
    }
  }
  const available = Object.entries(TREE_SPECIES);
  byId('forest-guide-count').textContent = '已解锁 ' + available.filter(([, tree]) => tree.goal <= peak).length + ' / ' + available.length;
  const tiles = available.map(([id, species]) => {
    const unlocked = species.goal <= peak;
    const tile = document.createElement('div');
    tile.className = 'species-tile ' + (unlocked ? 'is-unlocked' : 'is-locked');
    tile.dataset.species = id;
    const name = document.createElement('span');
    name.textContent = species.name;
    const status = document.createElement('small');
    status.textContent = unlocked ? '已种 ' + (collection[id] || 0) + ' 棵' : species.goal + ' 棵解锁';
    tile.append(treeImage(id), name, status);
    return tile;
  });
  byId('forest-species').replaceChildren(...tiles);
  const next = available.find(([, species]) => species.goal > peak)?.[1];
  byId('forest-milestone').textContent = next ? '再种 ' + (next.goal - total) + ' 棵解锁' + next.name : '树种已全部解锁';
  const progress = byId('forest-progress');
  progress.hidden = !next;
  if (next) {
    progress.max = next.goal;
    progress.value = total;
  }
}

function renderForest() {
  const entries = forestEntries();
  const total = totalTrees(records.days);
  const peak = Math.max(records.forest.peak, total);
  const scope = forestScope();
  if (forestDisplayScope !== scope) {
    forestDisplayScope = scope;
    forestInspection = null;
  }
  const visible = entries;
  const side = forestSide(visible.length);
  ensureForestSlots(side);
  const capacity = side ** 2;
  let capacityLabel = '当前果园 · 已种 ' + visible.length + ' / ' + capacity + ' 棵 · ' + side + '×' + side + ' 林地';
  if (visible.length === capacity) capacityLabel += ' · 下一棵自动扩建';
  byId('forest-capacity').textContent = capacityLabel;
  const inspected = visible.find(({ day, task }) => day === forestInspection?.day && task.id === forestInspection?.id);
  forestInspection = inspected ? { day: inspected.day, id: inspected.task.id } : null;
  byId('forest-date').textContent = forestRange === 'year' ? selected.slice(0,4) + ' 年'
    : forestRange === 'month' ? selected.slice(0,4) + ' 年 ' + Number(selected.slice(5,7)) + ' 月'
      : selected === today ? '今天' : shortDate(selected);
  byId('forest-daily').textContent = entries.length;
  byId('forest-total').textContent = total;

  const grove = byId('forest-trees');
  const active = document.activeElement;
  const focusDay = active?.dataset.treeDay;
  const focusId = active?.dataset.treeId;
  const fragment = document.createDocumentFragment();
  visible.forEach((entry, index) => fragment.append(makeForestTree(entry, inspected, index, side)));
  grove.replaceChildren(fragment);
  grove.hidden = visible.length === 0;
  if (focusDay) grove.querySelector('[data-tree-day="' + focusDay + '"][data-tree-id="' + focusId + '"]')?.focus({ preventScroll: true });
  const status = byId('forest-empty');
  status.hidden = Boolean(inspected);
  status.textContent = entries.length ? '点击树木，查看对应的任务。'
    : forestRange === 'year' ? '这一年还没有种下树。'
      : forestRange === 'month' ? '这个月还没有种下树。'
      : selected === today ? '完成一项任务，种下第一棵树。' : '这一天还没有种下树。';
  const detail = byId('forest-detail');
  detail.hidden = !inspected;
  detail.textContent = inspected ? shortDate(inspected.day) + ' · ' + TREE_SPECIES[inspected.task.tree ?? 'pine'].name + ' · ' + inspected.task.title : '';
  // Keep older cached HTML compatible, but never expose pagination.
  if (byId('forest-pages')) byId('forest-pages').hidden = true;
  renderForestGuide(peak, total);
}

function animateForestTree(day, id) {
  const entries = forestEntries();
  const position = entries.findIndex(entry => entry.day === day && entry.task.id === id);
  if (position < 0) return;
  const query = '[data-tree-day="' + day + '"][data-tree-id="' + id + '"]';
  byId('forest-trees').querySelector(query)?.classList.add('tree-growing');
}

function showPlantingFeedback(completedToday, unlocked) {
  const entries = forestEntries();
  stopCelebration();
  const feedback = ['种下 1 棵树'];
  if (completedToday) feedback.push('今日任务全部完成');
  if (unlocked) feedback.push('解锁' + unlocked.name);
  if (forestSide(entries.length) > forestSide(Math.max(0, entries.length - 1))) {
    const side = forestSide(entries.length);
    feedback.push('林地扩至 ' + side + '×' + side);
  }
  byId('completion-feedback').textContent = feedback.join(' · ');
  byId('completion-toast').hidden = false;
  celebrationTimer = setTimeout(stopCelebration, 2800);
}

function currentTasks(day = selected) {
  return records.days[day] || [];
}

function checkIn(day) {
  return day <= today && currentTasks(day).some(task => task.done);
}

function announce(message) {
  byId('announce').textContent = message;
}

function selectDay(day, share = true) {
  if (!isDay(day) || (!share && selected === day)) return;
  flushRecap();
  if (selected !== day) stopCelebration();
  selected = day;
  heatYear = Math.min(Number(day.slice(0, 4)), Number(today.slice(0, 4)));
  filter = 'all';
  render();
  if (share) {
    try {
      localStorage.setItem(SELECTED_DAY_STORE, JSON.stringify({ today, day }));
    } catch {
      // Date selection still works in the current pane without storage access.
    }
  }
}

function renderHero(tasks) {
  const { done } = taskCounts(tasks);
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const showToday = selected === today;
  byId('hero-date').textContent = dateLabel.format(fromDay(selected)).replace('星期', ' · 星期');
  byId('hero-date').dateTime = selected;
  byId('hero-heading').textContent = showToday ? '今日总览' : '当日总览';
  const remaining = tasks.length - done;
  if ((!showToday || remaining || !tasks.length) && byId('progress').classList.contains('is-celebrating')) stopCelebration();
  const message = byId('hero-message');
  message.hidden = !tasks.length;
  message.textContent = remaining ? '还有 ' + remaining + ' 项待完成' : '当天任务已全部完成';
  byId('progress').style.setProperty('--progress', percent + '%');
  byId('progress').setAttribute('aria-valuenow', percent);
  byId('percent').textContent = percent;
  byId('progress-caption').textContent = done + ' / ' + tasks.length + ' 项完成';
}

function iconButton(action, label, iconId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.title = label;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + iconId);
  svg.append(use);
  button.append(svg);
  return button;
}

function taskRow(task) {
  const row = document.createElement('li');
  row.className = task.done ? 'task done' : 'task';
  row.dataset.id = task.id;

  const checkbox = document.createElement('input');
  checkbox.className = 'checkbox';
  checkbox.type = 'checkbox';
  checkbox.id = 'task-' + task.id;
  checkbox.checked = task.done;
  const label = document.createElement('label');
  label.className = 'task-label';
  label.htmlFor = checkbox.id;
  label.title = task.title;
  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;
  label.append(title);
  if (task.category) {
    const category = document.createElement('span');
    category.className = 'task-category';
    category.dataset.category = task.category;
    category.textContent = task.category;
    label.append(category);
  }

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  actions.append(
    iconButton('edit', '编辑：' + task.title, 'i-edit'),
    iconButton('delete', '删除：' + task.title, 'i-trash'),
  );
  row.append(checkbox, label, actions);
  return row;
}

function renderPlanner(tasks) {
  byId('plan-date').value = selected;
  byId('previous').disabled = selected === '0001-01-01';
  byId('next').disabled = selected === '9999-12-31';
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  const visible = tasks.filter(task => filter === 'all' || task.done === (filter === 'done'));
  const list = byId('tasks');
  const active = document.activeElement;
  const activeCheckbox = active?.classList.contains('checkbox') ? active.id : '';
  list.replaceChildren(...visible.map(taskRow));
  list.hidden = visible.length === 0;
  byId('empty').hidden = visible.length > 0;

  if (!visible.length) {
    byId('empty-title').textContent = !tasks.length ? '还没有任务' : filter === 'open' ? '待办已清空' : '还没有完成的任务';
    byId('empty-detail').textContent = !tasks.length ? '填入任务名称，按回车键添加。'
      : filter === 'open' ? '可以在「已完成」里查看记录。' : '完成一项任务后，勾选它记录进度。';
  }
  if (activeCheckbox) {
    (byId(activeCheckbox) || document.querySelector('[data-filter="' + filter + '"]')).focus();
  }
}

function checkInTotals() {
  const checkedDays = Object.keys(records.days).filter(day => day <= today && checkIn(day)).sort();
  let longest = 0;
  let run = 0;
  let monthly = 0;
  let previous = '';
  const month = today.slice(0, 7);
  for (const day of checkedDays) {
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    if (day.startsWith(month)) monthly++;
    previous = day;
  }
  return { longest, monthly };
}

function renderHabit() {
  let day = checkIn(today) ? today : shiftDay(today, -1);
  let streak = 0;
  while (checkIn(day)) {
    streak++;
    day = shiftDay(day, -1);
  }
  byId('streak').textContent = '连续 ' + streak + ' 天';
  const { monthly, longest } = checkInTotals();
  byId('habit-month').textContent = monthly + ' 天';
  byId('habit-best').textContent = longest + ' 天';
  byId('habit-note').textContent = checkIn(today)
    ? '今天已打卡，至少完成了一项任务。'
    : '完成任意一项任务即可打卡。';

  const cells = [];
  for (let offset = -6; offset <= 0; offset++) {
    const key = shiftDay(today, offset);
    const date = fromDay(key);
    const checked = checkIn(key);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = checked ? 'day checked' : 'day';
    cell.dataset.day = key;
    const label = dateLabel.format(date) + (checked ? '，已打卡' : '，未打卡');
    cell.setAttribute('aria-label', label);
    cell.title = label;
    if (key === selected) cell.setAttribute('aria-current', 'date');
    const weekday = document.createElement('span');
    weekday.textContent = WEEKDAYS[date.getUTCDay()];
    const number = document.createElement('strong');
    number.textContent = checked ? '✓' : date.getUTCDate();
    cell.append(weekday, number);
    cells.push(cell);
  }
  const week = byId('week');
  const activeDay = week.contains(document.activeElement) ? document.activeElement.dataset.day : null;
  week.replaceChildren(...cells);
  if (activeDay) cells.find(cell => cell.dataset.day === activeDay)?.focus();
}

function taskCounts(tasks) {
  return { total: tasks.length, done: tasks.filter(task => task.done).length };
}

function shortDate(day) {
  const date = fromDay(day);
  return (date.getUTCMonth() + 1) + ' 月 ' + date.getUTCDate() + ' 日';
}

function chartColumn(day, done, total, max, labelText) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'chart-day';
  cell.dataset.trendDay = day;
  const description = dateLabel.format(fromDay(day)) + '，已完成 ' + done + ' 项，待完成 ' + (total - done) + ' 项';
  cell.setAttribute('aria-label', description);
  cell.title = description;
  if (day === selected) cell.setAttribute('aria-current', 'date');
  const slot = document.createElement('span');
  slot.className = 'bar-slot';
  slot.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('span');
  bar.className = 'bar';
  bar.style.setProperty('--height', total / max * 100 + '%');
  bar.style.setProperty('--done', (total ? done / total * 100 : 0) + '%');
  const finished = document.createElement('span');
  finished.className = 'bar-done';
  const pending = document.createElement('span');
  pending.className = 'bar-open';
  bar.append(finished, pending);
  slot.append(bar);
  const label = document.createElement('span');
  label.className = 'chart-label';
  label.setAttribute('aria-hidden', 'true');
  label.textContent = labelText;
  cell.append(slot, label);
  return cell;
}

function renderTrend() {
  const start = shiftDay(today, 1 - trendRange);
  const dates = Array.from({ length: trendRange }, (_, index) => {
    const day = shiftDay(start, index);
    return { day, ...taskCounts(currentTasks(day)) };
  });
  const totals = dates.reduce((sum, item) => ({
    total: sum.total + item.total,
    done: sum.done + item.done,
    active: sum.active + Number(item.done > 0),
    highest: Math.max(sum.highest, item.total),
  }), { total: 0, done: 0, active: 0, highest: 0 });
  byId('range-done').textContent = totals.done;
  byId('range-open').textContent = totals.total - totals.done;
  byId('range-rate').textContent = totals.total ? Math.round(totals.done / totals.total * 100) + '%' : '—';
  byId('range-active').textContent = totals.active;
  byId('range-label').textContent = shortDate(start) + ' – ' + shortDate(today);
  byId('trend-chart').dataset.range = trendRange;
  byId('chart-empty').hidden = totals.total > 0;
  const chartMax = Math.max(2, Math.ceil(totals.highest / 2) * 2);
  byId('chart-max').textContent = chartMax;
  byId('chart-mid').textContent = chartMax / 2;

  const selection = dates.find(item => item.day === selected);
  byId('chart-selection').textContent = selection
    ? shortDate(selected) + ' · 已完成 ' + selection.done + ' / ' + selection.total + ' 项'
    : '选择日期可切换任务清单。';
  const plot = byId('chart-columns');
  const focusedDay = document.activeElement?.dataset.trendDay;
  const columns = dates.map(({ day, done, total }, index) => {
    const date = fromDay(day);
    const showLabel = trendRange === 7 || index % 5 === 0 || index === trendRange - 1;
    const label = showLabel ? (date.getUTCMonth() + 1) + '/' + date.getUTCDate() : '';
    return chartColumn(day, done, total, chartMax, label);
  });
  plot.style.setProperty('--days', trendRange);
  plot.replaceChildren(...columns);
  if (focusedDay) columns.find(column => column.dataset.trendDay === focusedDay)?.focus({ preventScroll: true });
}

document.querySelector('.range')?.addEventListener('click', event => {
  const range = Number(event.target.dataset.rangeOption);
  if (range !== 7 && range !== 30) return;
  trendRange = range;
  for (const button of document.querySelectorAll('[data-range-option]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.rangeOption) === range));
  }
  renderTrend();
  const scroll = document.querySelector('.chart-scroll');
  scroll.scrollLeft = range === 30 ? scroll.scrollWidth : 0;
});

byId('chart-columns')?.addEventListener('click', event => {
  const day = event.target.closest('[data-trend-day]')?.dataset.trendDay;
  if (day) selectDay(day);
});

function heatLevel(done) {
  if (done === 0) return 0;
  if (done === 1) return 1;
  if (done < 4) return 2;
  if (done < 6) return 3;
  return 4;
}

function renderHeatMonth({ month, days: dates }, tabDay) {
  const panel = document.createElement('section');
  panel.className = 'heat-month';
  const heading = document.createElement('h3');
  heading.textContent = month + ' 月';
  const plot = document.createElement('div');
  plot.className = 'heat-days';

  for (const { day, total, done } of dates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'heat-cell';
    button.dataset.heatDay = day;
    button.dataset.level = day > today ? 'future' : String(heatLevel(done));
    button.tabIndex = day === tabDay ? 0 : -1;
    if (day === selected) button.setAttribute('aria-current', 'date');
    const count = day > today ? '未来日期' : '已完成 ' + done + ' / ' + total + ' 项';
    button.title = dateLabel.format(fromDay(day)) + ' · ' + count;
    button.setAttribute('aria-label', button.title);
    plot.append(button);
  }
  panel.append(heading, plot);
  return panel;
}

function renderHeatmap() {
  const yearText = String(heatYear).padStart(4, '0');
  const start = yearText + '-01-01';
  const end = yearText + '-12-31';
  const length = (fromDay(end) - fromDay(start)) / 86400000 + 1;
  const dates = Array.from({ length }, (_, index) => {
    const day = shiftDay(start, index);
    return { day, ...taskCounts(currentTasks(day)) };
  });
  const months = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, days: [] }));
  let active = 0;
  let done = 0;
  let full = 0;
  for (const date of dates) {
    months[Number(date.day.slice(5, 7)) - 1].days.push(date);
    if (date.day > today) continue;
    done += date.done;
    active += Number(date.done > 0);
    full += Number(date.total > 0 && date.done === date.total);
  }
  byId('heat-year').textContent = heatYear + ' 年';
  byId('heat-prev').disabled = heatYear === 1;
  byId('heat-next').disabled = heatYear === Number(today.slice(0, 4));
  byId('heat-active').textContent = active;
  byId('heat-done').textContent = done;
  byId('heat-full').textContent = full;
  const detail = dates.find(date => date.day === selected);
  byId('heat-selection').textContent = detail
    ? shortDate(selected) + ' · ' + (selected > today ? '可提前安排任务' : '已完成 ' + detail.done + ' / ' + detail.total + ' 项')
    : '选一个日期查看完成记录。';
  renderHeatRecap();

  const map = byId('heatmap');
  const focused = document.activeElement?.dataset.heatDay;
  const tabDay = focused?.startsWith(yearText) ? focused : detail?.day || (today <= end && today >= start ? today : start);
  map.replaceChildren(...months.map(month => renderHeatMonth(month, tabDay)));
  if (focused) map.querySelector('[data-heat-day="' + tabDay + '"]')?.focus({ preventScroll: true });
}

function changeHeatYear(offset) {
  heatYear += offset;
  renderHeatmap();
}

byId('heat-prev')?.addEventListener('click', () => changeHeatYear(-1));
byId('heat-next')?.addEventListener('click', () => changeHeatYear(1));
byId('heatmap')?.addEventListener('click', event => {
  const day = event.target.closest('[data-heat-day]')?.dataset.heatDay;
  if (day) selectDay(day);
});

byId('heatmap')?.addEventListener('keydown', event => {
  const day = event.target.dataset.heatDay;
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key];
  if (!day || !offset || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  const next = byId('heatmap').querySelector('[data-heat-day="' + shiftDay(day, offset) + '"]');
  if (!next) return;
  event.target.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
});

function render() {
  switch (panel) {
    case 'overview':
      renderHero(currentTasks());
      renderHabit();
      break;
    case 'tasks':
      renderPlanner(currentTasks());
      renderRecap();
      break;
    case 'heatmap':
      renderHeatmap();
      break;
    case 'trend':
      renderTrend();
      break;
    case 'forest':
      renderForest();
      break;
  }
}

document.querySelector('.forest-periods')?.addEventListener('click', event => {
  const range = event.target.closest('[data-forest-range]')?.dataset.forestRange;
  if (!range || range === forestRange) return;
  forestRange = range;
  for (const button of document.querySelectorAll('[data-forest-range]')) {
    button.setAttribute('aria-pressed', String(button.dataset.forestRange === range));
  }
  renderForest();
});

byId('forest-trees')?.addEventListener('click', event => {
  const tree = event.target.closest('[data-tree-id]');
  if (!tree) return;
  forestInspection = { day: tree.dataset.treeDay, id: tree.dataset.treeId };
  renderForest();
});

byId('forest-trees')?.addEventListener('animationend', event => {
  if (event.animationName === 'tree-grow') event.target.closest('.forest-tree')?.classList.remove('tree-growing');
});

byId('previous')?.addEventListener('click', () => selectDay(shiftDay(selected, -1)));
byId('next')?.addEventListener('click', () => selectDay(shiftDay(selected, 1)));
byId('today')?.addEventListener('click', () => selectDay(today));
byId('plan-date')?.addEventListener('change', event => {
  if (isDay(event.target.value)) selectDay(event.target.value);
  else event.target.value = selected;
});
byId('week')?.addEventListener('click', event => {
  const cell = event.target.closest('[data-day]');
  if (cell) selectDay(cell.dataset.day);
});
document.querySelector('.filters')?.addEventListener('click', event => {
  if (!event.target.dataset.filter) return;
  filter = event.target.dataset.filter;
  renderPlanner(currentTasks());
});

for (const input of [byId('task-name'), byId('edit-name')].filter(Boolean)) {
  input.addEventListener('input', () => input.setCustomValidity(''));
}

function taskTitle(input) {
  const title = input.value.trim();
  if (!title) {
    input.setCustomValidity('请输入任务名称。');
    input.reportValidity();
  }
  return title;
}

function bindTaskForm(form, submit) {
  if (!form) return;
  const run = event => {
    event.preventDefault();
    submit();
  };
  // User actions still work when the surrounding iframe blocks form submission.
  form.addEventListener('submit', run);
  form.querySelector('button[type="submit"]').addEventListener('click', run);
  form.querySelector('input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) run(event);
  });
}

bindTaskForm(byId('compose'), () => {
  const input = byId('task-name');
  const title = taskTitle(input);
  if (!title) return;
  const category = byId('task-category').value;
  if (!TASK_CATEGORIES.includes(category)) return;
  const id = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  filter = filter === 'done' ? 'all' : filter;
  updateTasks(selected, tasks => [...tasks, { id, title, category, done: false }]);
  // Keep the newest task visible when the six-row list needs scrolling.
  const taskList = byId('tasks');
  taskList.scrollTop = taskList.scrollHeight;
  input.value = '';
  input.focus();
  announce('已添加任务：' + title);
});

byId('recap-input')?.addEventListener('input', event => {
  pendingRecap = { day: selected, text: event.target.value };
  clearTimeout(recapTimer);
  recapTimer = setTimeout(flushRecap, 360);
  renderRecap();
});
byId('recap-input')?.addEventListener('blur', () => {
  flushRecap();
  renderRecap();
});

byId('tasks')?.addEventListener('change', event => {
  if (!event.target.matches('.checkbox')) return;
  const id = event.target.closest('.task').dataset.id;
  const done = event.target.checked;
  const day = selected;
  const hadCheckIn = checkIn(day);
  let planted = false;
  let completedToday = false;
  const previousPeak = updateTasks(day, (tasks, latest, peak) => {
    planted = done && tasks.some(task => task.id === id && !task.done);
    const updated = tasks.map(task => {
      if (task.id !== id) return task;
      return planted ? { ...task, done, tree: automaticSpecies(latest, peak, task.tree) } : { ...task, done };
    });
    completedToday = day === today && planted && updated.every(task => task.done);
    return updated;
  });
  if (planted) {
    const unlocked = Object.values(TREE_SPECIES).find(tree => tree.goal > previousPeak && tree.goal <= records.forest.peak);
    showPlantingFeedback(completedToday, unlocked);
    if (unlocked || completedToday) announce(byId('completion-feedback').textContent);
    else announce(checkIn(day) && !hadCheckIn ? '已打卡，并种下 1 棵树。' : '已种下 1 棵树。');
    return;
  }
  if (!done) stopCelebration();
  announce(done ? '任务已完成。' : '已标记为待完成。');
});

const editDialog = byId('edit-dialog');
const confirmDialog = byId('confirm-dialog');

function restoreRowFocus(id, action) {
  const row = byId('task-' + id)?.closest('.task');
  (row?.querySelector('[data-action="' + action + '"]') || byId('task-name')).focus();
}

function confirm(title, message, buttonText, action) {
  byId('confirm-title').textContent = title;
  byId('confirm-message').textContent = message;
  byId('confirm-accept').textContent = buttonText;
  confirmAction = action;
  confirmDialog.returnValue = 'cancel';
  confirmDialog.showModal();
}

confirmDialog?.querySelector('form').addEventListener('click', event => {
  const button = event.target.closest('button[value]');
  if (!button) return;
  event.preventDefault();
  confirmDialog.close(button.value);
});
confirmDialog?.addEventListener('close', () => {
  const action = confirmAction;
  confirmAction = null;
  if (confirmDialog.returnValue === 'accept') action?.();
});

byId('tasks')?.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.closest('.task').dataset.id;
  const day = selected;
  const task = currentTasks().find(item => item.id === id);
  if (!task) return;
  if (button.dataset.action === 'edit') {
    editing = { day, id };
    byId('edit-name').value = task.title;
    byId('edit-category').value = task.category ?? '';
    byId('edit-name').setCustomValidity('');
    editDialog.showModal();
    byId('edit-name').select();
    return;
  }
  confirm('删除任务', '删除「' + task.title + '」？', '删除', () => {
    updateTasks(day, tasks => tasks.filter(item => item.id !== id));
    restoreRowFocus(id, 'delete');
    announce('任务已删除。');
  });
});

byId('edit-cancel')?.addEventListener('click', () => editDialog.close());
editDialog?.addEventListener('close', () => {
  if (editing) restoreRowFocus(editing.id, 'edit');
  editing = null;
});
bindTaskForm(byId('edit-form'), () => {
  const title = taskTitle(byId('edit-name'));
  if (!title || !editing) return;
  const category = byId('edit-category').value;
  if (category && !TASK_CATEGORIES.includes(category)) return;
  const { day, id } = editing;
  updateTasks(day, tasks => tasks.map(task => {
    if (task.id !== id) return task;
    const updated = { ...task, title };
    if (category) updated.category = category;
    else delete updated.category;
    return updated;
  }));
  editDialog.close();
  announce('任务已更新。');
});

byId('export')?.addEventListener('click', () => {
  flushRecap();
  const data = JSON.stringify({ version: 4, ...latestRecords() }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'daily-checklist-backup-' + getToday() + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  byId('backup').open = false;
  byId('backup').querySelector('summary').focus();
  announce('已导出备份。');
});
byId('import')?.addEventListener('click', () => byId('import-file').click());
byId('import-file')?.addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const summary = byId('backup').querySelector('summary');
  byId('backup').open = false;
  summary.focus();
  let imported;
  try {
    imported = validateRecords(JSON.parse(await file.text()));
  } catch {
    confirm('无法导入', '请选择由此页面导出的完整 JSON 备份。', '知道了', null);
    return;
  }
  confirm('导入备份', '导入会替换当前清单、打卡、复盘和森林记录；登录后修改将同步到其他设备。请先导出备份。', '导入', () => {
    clearTimeout(recapTimer);
    pendingRecap = null;
    saveRecords(imported, latestRecords());
    filter = 'all';
    render();
    announce('备份已导入。');
  });
});

function updateClock() {
  const date = getToday();
  if (date !== today) {
    flushRecap();
    if (selected === today) {
      selected = date;
      filter = 'all';
    }
    if (heatYear === Number(today.slice(0, 4))) heatYear = Number(date.slice(0, 4));
    today = date;
    render();
  }
}

window.addEventListener('storage', event => {
  try {
    if (event.key === SELECTED_DAY_STORE) {
      const choice = readSaved(SELECTED_DAY_STORE);
      if (choice?.today === today) selectDay(choice.day, false);
      return;
    }
    if (cloudSync?.active()) return;
    if (event.key !== STORE && event.key !== null) return;
    const previous = records;
    records = readCurrentRecords();
    showStorageWarning('');
    render();

    if (panel === 'overview' && selected === today) {
      const tasks = currentTasks(today);
      const prior = previous.days[today] || [];
      if (tasks.length && tasks.every(task => task.done) && prior.some(task => !task.done)) {
        byId('progress').classList.add('is-celebrating');
        clearTimeout(celebrationTimer);
        celebrationTimer = setTimeout(stopCelebration, 2800);
      }
    }
    if (panel === 'forest') {
      const old = new Set();
      for (const [day, tasks] of Object.entries(previous.days)) {
        for (const task of tasks) if (task.done) old.add(day + '/' + task.id);
      }
      const grew = forestEntries().filter(({ day, task }) => !old.has(day + '/' + task.id));
      if (grew.length === 1) animateForestTree(grew[0].day, grew[0].task.id);
    }
  } catch {
    showStorageWarning('无法读取浏览器中的记录。你可以导出本次填写的清单。');
  }
});
window.addEventListener('pagehide', flushRecap);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushRecap();
  else updateClock();
});
if (panel === 'forest') byId('orchard-landscape').src = ORCHARD_IMAGE;
if (panel === 'overview') {
  byId('hero-landscape').src = ORCHARD_IMAGE;
  byId('habit-tree').src = TREE_SPRITES.pine;
}
if (panel === 'forest') {
  const tabs = document.querySelector('.forest-tabs');
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-forest-tab]');
    if (!tab) return;
    document.querySelector('.forest-content').dataset.forestView = tab.dataset.forestTab;
    for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button === tab));
  });
}
render();
updateClock();
setInterval(updateClock, 15000);

/* Authenticated cloud sync: preserve legacy local storage, isolate per-user caches, merge concurrent changes. */
function makeCloudPatch(before,after,migrate=false){
 const changes=[], recaps={};
 for(const day of new Set([...Object.keys(before.days),...Object.keys(after.days)])){
  const a=new Map((before.days[day]||[]).map(t=>[t.id,t])),b=new Map((after.days[day]||[]).map(t=>[t.id,t]));
  if(!migrate)for(const id of a.keys())if(!b.has(id))changes.push({day,id,kind:'delete'});
  for(const [id,task] of b){
   const prior=a.get(id);
   if(!prior){changes.push({day,id,kind:'add',task});continue}
   const fields={};
   for(const field of ['title','done','category','tree'])if(prior[field]!==task[field])fields[field]=task[field]??null;
   if(Object.keys(fields).length)changes.push({day,id,kind:'edit',fields});
  }
 }
 for(const day of new Set([...Object.keys(before.recaps),...Object.keys(after.recaps)]))if(before.recaps[day]!==after.recaps[day])recaps[day]=after.recaps[day]??null;
 return {changes,recaps,peak:after.forest.peak,species:before.forest.species!==after.forest.species?after.forest.species:null,migrate};
}
function applyCloudPatch(input,patch){
 const next=JSON.parse(JSON.stringify(input));
 for(const c of patch.changes){
  const list=next.days[c.day]||[],i=list.findIndex(t=>t.id===c.id);
  if(c.kind==='add'&&i<0)list.push({...c.task});
  if(c.kind==='delete'&&i>=0)list.splice(i,1);
  if(c.kind==='edit'&&i>=0)for(const [field,value] of Object.entries(c.fields)){if(value===null)delete list[i][field];else list[i][field]=value}
  if(list.length)next.days[c.day]=list;else delete next.days[c.day];
 }
 for(const [day,value] of Object.entries(patch.recaps)){
  if(patch.migrate&&next.recaps[day])continue;
  if(value===null)delete next.recaps[day];else next.recaps[day]=value;
 }
 next.forest.peak=Math.max(next.forest.peak,patch.peak,Object.values(next.days).flat().filter(t=>t.done).length);
 if(patch.species&&!patch.migrate)next.forest.species=patch.species;
 return next;
}
async function installChecklistCloud(){
 const host=document.querySelector('.shell');if(!host)return;
 const bar=document.createElement('details');
 bar.className='cloud-sync';
 bar.style.cssText='margin:4px 0 8px;padding:4px 8px;border:1px solid #d7e5db;border-radius:8px;font:inherit;font-size:12px;color:inherit';
 bar.innerHTML='<summary style="cursor:pointer">云同步 · 正在连接…</summary><div style="display:grid;gap:6px;padding:8px 0"><form style="display:grid;gap:6px"><input type="email" aria-label="邮箱" placeholder="邮箱" autocomplete="email" required style="width:100%;box-sizing:border-box"><input type="password" aria-label="密码" placeholder="密码（至少8位）" autocomplete="current-password" minlength="8" required style="width:100%;box-sizing:border-box"><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="button" type="submit">登录</button><button class="button" type="button" data-register>注册</button></div></form><div data-controls hidden><button class="button" type="button" data-retry>立即同步</button> <button class="button" type="button" data-migrate>迁移本机旧数据</button> <button class="button" type="button" data-logout>退出登录</button></div><span role="status" data-note>电脑和手机请使用同一个账号。</span></div>';
 host.prepend(bar);
 const recovery=document.createElement('div');
 recovery.hidden=true;
 recovery.style.cssText='margin:4px 0 8px;padding:8px;border:1px solid #b3cdb9;border-radius:8px;font-size:12px;display:none';
 const recoveryText=document.createElement('div'), restoreButton=document.createElement('button'), cloudButton=document.createElement('button');
 restoreButton.type=cloudButton.type='button';restoreButton.className=cloudButton.className='button';
 restoreButton.textContent='恢复并同步旧数据';cloudButton.textContent='仅查看云端';
 const legacyBackup=document.createElement('button');
 legacyBackup.type='button';legacyBackup.className='button';legacyBackup.textContent='导出本机原始记录';
 recovery.append(recoveryText,restoreButton,cloudButton,legacyBackup);bar.after(recovery);
 legacyBackup.addEventListener('click',()=>{
  const legacy=legacyRecords();
  if(!legacy){status('无法读取旧记录','请保留浏览器数据并回到原来使用的设备。');return}
  const url=URL.createObjectURL(new Blob([JSON.stringify({version:4,...legacy},null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='daily-checklist-legacy-'+getToday()+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
 });
 const summary=bar.querySelector('summary'),form=bar.querySelector('form'),controls=bar.querySelector('[data-controls]'),note=bar.querySelector('[data-note]');
 const email=form.querySelector('[type=email]'),password=form.querySelector('[type=password]');
 const status=(title,detail)=>{summary.textContent='云同步 · '+title;if(detail!==undefined)note.textContent=detail};
 let durable=true;
 const get=k=>{try{return localStorage.getItem(k)}catch{durable=false;return null}};
 const put=(k,v)=>{try{localStorage.setItem(k,v);return true}catch{durable=false;return false}};
 const remove=k=>{try{localStorage.removeItem(k)}catch{durable=false}};
 let client;
 try{
  if(!globalThis.supabase?.createClient)await new Promise((resolve,reject)=>{
   const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/dist/umd/supabase.js';
   s.integrity='sha384-A97u3Qnt9GZHURO9YJZRe7VQgGUeFzcv6I1oIGnUTxQrCxnpQMwR0/G8F2zt9abZ';s.crossOrigin='anonymous';s.onload=resolve;s.onerror=reject;document.head.append(s);
  });
  client=globalThis.supabase.createClient('https://eubjpbheryecjofphluc.supabase.co',"sb_publishable_LdJwDikOC_4_VYOpH15nCw_trqRyRxn",{auth:{storageKey:'daily-checklist.supabase.session.v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
 }catch{
  status('连接失败','无法加载云同步组件，旧记录仍保存在本机。联网后刷新页面。');form.style.display='none';return;
 }
 let uid=null,generation=0,busy=false,base={revision:0,records:emptyRecords()},failed=false,localPreview=false,cloudOnly=false;
 const memory=new Map(),migrated=new Set();
 const root=()=> 'daily-checklist.cloud.v1.'+uid+'.';
 function cacheBase(value){
  loadBase();
  const revision=Number(value.revision);
  if(!Number.isSafeInteger(revision)||revision<0)throw Error('Invalid revision');
  const validated=validateRecords(value.records);
  if(revision<base.revision || (revision===base.revision && get(root()+'base')))return;
  base={revision,records:validated};put(root()+'base',JSON.stringify({revision,records:{version:4,...validated}}));
 }
 function loadBase(){
  const raw=get(root()+'base');if(!raw)return;
  try{const v=JSON.parse(raw),revision=Number(v.revision);if(Number.isSafeInteger(revision)&&revision>=base.revision)base={revision,records:validateRecords(v.records)}}catch{}
 }
 function queue(){
  if(!uid)return [];
  const prefix=root()+'op.',entries=new Map([...memory].filter(([k])=>k.startsWith(prefix)));
  try{
   for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);if(!k?.startsWith(prefix))continue;
    try{const v=JSON.parse(localStorage.getItem(k));if(v?.id&&v?.patch)entries.set(k,v)}catch{durable=false}
   }
  }catch{durable=false}
  return [...entries.values()].sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
 }
 function legacyRecords(){
  try{return readCurrentRecords()}catch{return null}
 }
 function showRecovery(){
  const legacy=legacyRecords();
  const count=legacy?Object.values(legacy.days).reduce((n,list)=>n+list.length,0):0;
  const days=legacy?Object.keys(legacy.recaps).length:0;
  const pending=Boolean(uid&&legacy&&(count||days)&&!get(root()+'migrated')&&!migrated.has(root()+'migrated')&&!queue().some(op=>op.patch.migrate));
  const diagnostic=Boolean(uid&&panel==='tasks');
  recovery.hidden=!(pending||diagnostic);recovery.style.display=pending||diagnostic?'block':'none';
  restoreButton.hidden=cloudButton.hidden=!pending||panel!=='tasks';
  legacyBackup.hidden=panel!=='tasks'||!legacy||!(count||days);
  recoveryText.textContent=pending?(localPreview?'正在显示本机旧记录':'发现尚未迁移的本机记录')+' · '+count+' 项任务 / '+days+' 条复盘。'+(panel==='tasks'?' 点击恢复并同步旧数据。':' 请在任务清单模块恢复。'):diagnostic?(!legacy?'本机旧记录读取失败；请勿清理浏览器缓存。':count||days?'本机原始备份仍保留：'+count+' 项任务 / '+days+' 条复盘。':'当前浏览器存储中未检测到旧任务。请在原来使用的设备及原来的 Notion 页面中检查。'):'';
  return pending;
 }
 function view(){loadBase();return queue().reduce((v,op)=>applyCloudPatch(v,op.patch),base.records)}
 function refreshView(){
  if(!uid)return;const next=localPreview?(legacyRecords()||records):view();
  if(JSON.stringify(records)!==JSON.stringify(next)){records=next;render()}
 }
 function addOperation(patch){
  if(!uid)return;
  const created=Date.now();
  const op={id:crypto.randomUUID(),created,patch},k=root()+'op.'+op.id;
  if(!put(k,JSON.stringify(op)))memory.set(k,op);
  refreshView();status('待同步 '+queue().length,durable?'修改已暂存在本机，联网后上传。':'浏览器限制本地缓存，请保持页面打开并尽快同步或导出备份。');void sync();
 }
 async function sync(){
  if(!uid||busy)return;
  busy=true;const ticket=generation,owner=uid;
  try{
   loadBase();
   const {data,error}=await client.from('checklist_sync_state').select('revision,records').eq('user_id',owner).maybeSingle();
   if(ticket!==generation)return;if(error)throw error;if(data)cacheBase(data);
   else if(base.revision===0&&!queue().length){
    // A migration flag is not proof of a successful cloud write.
    const legacy=legacyRecords();
    if(legacy&&(Object.values(legacy.days).some(list=>list.length)||Object.keys(legacy.recaps).length)){
     migrated.delete(root()+'migrated');remove(root()+'migrated');
     if(!cloudOnly)localPreview=true;
    }
   }
   let steps=0;
   while(steps++<40&&ticket===generation){
    const op=queue()[0];if(!op)break;
    const candidate=applyCloudPatch(base.records,op.patch);
    const result=await client.rpc('checklist_sync_commit',{p_operation:op.id,p_revision:base.revision,p_records:{version:4,...candidate}});
    if(ticket!==generation)return;if(result.error)throw result.error;
    cacheBase(result.data);
    if(result.data.accepted){
      if(op.patch.migrate){const marker=root()+'migrated';migrated.add(marker);put(marker,'1')}
      const k=root()+'op.'+op.id;remove(k);memory.delete(k)
    }
   }
   if(ticket!==generation)return;
   failed=false;refreshView();
   const count=queue().length;
   if(showRecovery()&&localPreview)status('旧数据待恢复','本机历史记录仍可见，尚未上传。请在任务清单中点击恢复并同步旧数据。');
   else status(count?'待同步 '+count:'已同步',count?'尚有修改等待上传。':durable?'已连接云端，其他打开的设备约5秒内更新。':'云端已连接，但此浏览器可能无法保留登录或离线记录。');
  }catch{
   if(ticket===generation){failed=true;refreshView();status('暂未同步 · '+queue().length+' 项',durable?'网络或会话暂不可用，修改保留在本机，联网后重试。':'修改暂存在当前页面，请不要关闭页面并及时导出备份。')}
  }finally{busy=false;if(ticket!==generation&&uid)void sync()}
 }
 function activate(session){
  const next=session?.user?.id??null;
  if(uid===next){if(uid)void sync();else status('未登录','电脑和手机请使用同一个账号。未登录时仅保存在本机。');return}
  flushRecap();generation++;uid=next;base={revision:0,records:emptyRecords()};failed=false;localPreview=false;cloudOnly=false;
  form.style.display=uid?'none':'grid';controls.hidden=!uid;bar.querySelector('[data-migrate]').hidden=!uid||panel!=='tasks';
  if(uid){
   loadBase();
   localPreview=showRecovery();
   records=localPreview?(legacyRecords()||records):view();showRecovery();render();
   status(localPreview?'旧数据待恢复':'正在同步…');bar.open=localPreview&&panel==='tasks';void sync();
  }else{showRecovery();try{records=readCurrentRecords()}catch{records=emptyRecords()}render();status('未登录','已退出云账号，当前显示旧版本机记录。')}
 }
 cloudSync={active:()=>Boolean(uid&&!localPreview),view,enqueue:(before,after)=>addOperation(makeCloudPatch(before,after))};
 async function authenticate(register){
  if(!form.reportValidity())return;
  const credentials={email:email.value.trim(),password:password.value};
  for(const btn of form.querySelectorAll('button'))btn.disabled=true;
  try{
   const result=register?await client.auth.signUp(credentials):await client.auth.signInWithPassword(credentials);
   if(result.error)throw result.error;
   if(result.data.session)activate(result.data.session);
   else status('请验证邮箱','请打开验证邮件完成注册，再返回此处登录。验证后即使跳转失败也可重新登录。');
  }catch(error){status('登录/注册未完成',error?.message||'请检查账号与网络。')}
  finally{password.value='';for(const btn of form.querySelectorAll('button'))btn.disabled=false}
 }
 form.addEventListener('submit',e=>{e.preventDefault();void authenticate(false)});
 bar.querySelector('[data-register]').addEventListener('click',()=>void authenticate(true));
 bar.querySelector('[data-retry]').addEventListener('click',()=>void sync());
 bar.querySelector('[data-logout]').addEventListener('click',async()=>{
  flushRecap();await sync();
  if(queue().length){status('仍有待同步记录','为防止丢失，请先联网同步，再退出账号。');return;}
  const result=await client.auth.signOut({scope:'local'});if(result.error)status('退出失败','请检查网络后重试。');else activate(null);
 });
 function migrateLegacy(){
  if(!uid)return;
  const marker=root()+'migrated';
  if(queue().some(op=>op.patch.migrate)){status('正在恢复','旧记录正在等待上传，请勿清除缓存。');void sync();return}
  if(migrated.has(marker)||get(marker)){status('已迁移过','为避免重复恢复已删除任务，本设备不再自动迁移。如需恢复，请使用数据备份导入。');return}
  let legacy;try{legacy=readCurrentRecords()}catch{status('迁移失败','无法读取旧版记录，请使用原备份导入。');return}
  if(!Object.keys(legacy.days).length&&!Object.keys(legacy.recaps).length){status('没有旧记录','如果记录在其他电脑，请到原设备的 Notion 页面迁移。');return}
  confirm('迁移本机旧数据','将本机旧清单合并到当前云账号？已有同 ID 任务及复盘保留云端版本，旧本机记录不删除。','迁移',()=>{
   if(marker!==root()+'migrated')return;
   flushRecap();
   const latestLegacy=legacyRecords()||legacy;
   localPreview=false;
   addOperation(makeCloudPatch(emptyRecords(),latestLegacy,true));showRecovery();refreshView();void sync();
  });
 }
 bar.querySelector('[data-migrate]').addEventListener('click',migrateLegacy);
 restoreButton.addEventListener('click',migrateLegacy);
 cloudButton.addEventListener('click',()=>{flushRecap();cloudOnly=true;localPreview=false;refreshView();showRecovery();void sync()});
 window.addEventListener('storage',e=>{
  if(!uid)return;
  if(e.key===root()+'migrated'&&get(root()+'migrated')){localPreview=false;refreshView();showRecovery();void sync();return}
  if(e.key===null||e.key?.startsWith(root())){refreshView();showRecovery();if(e.key?.includes('.op.'))void sync()}
  else if(e.key===STORE&&localPreview){refreshView();showRecovery()}
 });
 window.addEventListener('online',()=>void sync());window.addEventListener('focus',()=>void sync());
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync()});
 client.auth.onAuthStateChange((_event,session)=>setTimeout(()=>activate(session),0));
 try{const {data,error}=await client.auth.getSession();if(error)throw error;activate(data.session)}catch{status('未登录','无法恢复登录，请重新登录。')}
 setInterval(()=>{if(uid&&(!document.hidden||failed||queue().length))void sync()},5000);
}
void installChecklistCloud();

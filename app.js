'use strict';

const STORAGE_KEY = 'ops_dem_v2';
const LEGACY_KEY = 'ops_ngc_v1';

const CAPS = {
  targets: 2,
  tasks: 6,
  b1Pushing: 2,
  b1Internal: 2,
  b2Pushing: 2,
  b2Internal: 2,
  followUps: 3,
  stuck: 4,
  tomorrowFollowUps: 3,
  tickets: 8
};

const LANES = {
  'b1-pushing': { block: 'block1', lane: 'pushing', max: CAPS.b1Pushing },
  'b1-internal': { block: 'block1', lane: 'internal', max: CAPS.b1Internal },
  'b2-pushing': { block: 'block2', lane: 'pushing', max: CAPS.b2Pushing },
  'b2-internal': { block: 'block2', lane: 'internal', max: CAPS.b2Internal },
  'b3-items': { block: 'block3', lane: 'items', max: 6 }
};

const EXEC = {
  STALE_MS: 48 * 60 * 60 * 1000,
  RECENT_MS: 24 * 60 * 60 * 1000,
  UP_NEXT_MAX: 5,
  LANE_OVERLOAD: 3,
  DONE_FADE_MS: 72 * 60 * 60 * 1000
};

let state = emptyState();
let saveTimer = null;

function emptyState() {
  return {
    version: 2,
    dateKey: todayKey(),
    lastDay: '',
    targets: [
      { id: uid(), text: '', done: false },
      { id: uid(), text: '', done: false }
    ],
    start: { targetsLocked: false, noReacting: false, workNotes: '' },
    blocks: {
      block1: { pushing: [], internal: [] },
      block2: { pushing: [], internal: [] },
      reset: { scan: '' },
      block3: { items: [] }
    },
    followUps: [],
    eod: {
      closedToday: '',
      stillStuck: [],
      tomorrowT1: '',
      tomorrowT2: '',
      tomorrowFollowUps: []
    },
    tickets: [],
    recentDays: [],
    focusId: null,
    doneLane: []
  };
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

function setSaveStatus(s) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.className = 'save-pill ' + s;
  el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'failed' ? 'Save failed' : 'Ready';
}

function save() {
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveStatus('saved');
    } catch (e) {
      setSaveStatus('failed');
    }
  }, 400);
}

function nowMs() {
  return Date.now();
}

function makeTask(text, done, extra) {
  const ts = nowMs();
  return {
    id: uid(),
    text: text || '',
    done: !!done,
    createdAt: ts,
    updatedAt: ts,
    completedAt: done ? ts : null,
    linkedTarget: null,
    pendingAction: false,
    dueAt: null,
    ...(extra || {})
  };
}

function ensureTask(task) {
  const ts = nowMs();
  if (!task.id) task.id = uid();
  if (!task.createdAt) task.createdAt = ts;
  if (!task.updatedAt) task.updatedAt = task.createdAt;
  if (task.completedAt === undefined) task.completedAt = task.done ? task.updatedAt : null;
  if (task.linkedTarget === undefined) task.linkedTarget = null;
  if (task.pendingAction === undefined) task.pendingAction = false;
  if (task.dueAt === undefined) task.dueAt = null;
  return task;
}

function touchTask(task) {
  ensureTask(task);
  task.updatedAt = nowMs();
}

function targetText(idx) {
  return (state.targets[idx]?.text || '').trim().toLowerCase();
}

function autoLinkTarget(task) {
  ensureTask(task);
  const text = (task.text || '').trim().toLowerCase();
  if (!text) return null;
  const t1 = targetText(0);
  const t2 = targetText(1);
  if (t1 && (text === t1 || text.includes(t1) || t1.includes(text))) return 't1';
  if (t2 && (text === t2 || text.includes(t2) || t2.includes(text))) return 't2';
  return task.linkedTarget;
}

function isT1Task(task) {
  ensureTask(task);
  if (task.done) return false;
  if (task.linkedTarget === 't1') return true;
  return autoLinkTarget(task) === 't1';
}

function isStale(task) {
  ensureTask(task);
  if (task.done || !(task.text || '').trim()) return false;
  return nowMs() - task.updatedAt >= EXEC.STALE_MS;
}

function isRecent(task) {
  ensureTask(task);
  return nowMs() - task.createdAt <= EXEC.RECENT_MS;
}

function isDueSoon(task) {
  ensureTask(task);
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return false;
  return due - nowMs() <= EXEC.RECENT_MS;
}

function iterActiveTasks(fn) {
  Object.keys(LANES).forEach(listId => {
    const arr = getTaskArray(listId) || [];
    arr.forEach((task, idx) => {
      if (!(task.text || '').trim() || task.done) return;
      fn(task, listId, idx);
    });
  });
}

function findTaskById(taskId) {
  if (!taskId) return null;
  for (const listId of Object.keys(LANES)) {
    const arr = getTaskArray(listId) || [];
    const idx = arr.findIndex(t => t.id === taskId);
    if (idx >= 0) return { task: arr[idx], listId, idx };
  }
  return null;
}

function getFocusTask() {
  const hit = findTaskById(state.focusId);
  if (!hit || hit.task.done || !(hit.task.text || '').trim()) return null;
  return hit.task;
}

function setFocus(taskId) {
  if (!taskId) {
    state.focusId = null;
    return;
  }
  const hit = findTaskById(taskId);
  if (!hit || hit.task.done || !(hit.task.text || '').trim()) {
    state.focusId = null;
    return;
  }
  state.focusId = taskId;
}

function clearFocusIf(taskId) {
  if (state.focusId === taskId) state.focusId = null;
}

function urgencyScore(task, listId) {
  ensureTask(task);
  let score = 0;
  if (isT1Task(task)) score += 100;
  if (isRecent(task)) score += 50;
  if (task.pendingAction) score += 40;
  if (listId && (listId.includes('internal') || listId === 'b3-items')) score += 35;
  if (isDueSoon(task)) score += 60;
  if (isStale(task)) score += 35;
  if (state.focusId === task.id) score += 120;
  score += Math.max(0, 20 - Math.floor((nowMs() - task.updatedAt) / 3600000));
  return score;
}

function computeUpNext() {
  const items = [];
  iterActiveTasks((task, listId) => {
    items.push({
      task,
      score: urgencyScore(task, listId),
      label: (task.text || '').trim()
    });
  });
  items.sort((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt);
  const limit = Math.min(EXEC.UP_NEXT_MAX, Math.max(5, items.length));
  return items.slice(0, limit);
}

function laneActiveCount(arr) {
  return (arr || []).filter(t => (t.text || '').trim() && !t.done).length;
}

function getLaneState(listId, arr) {
  const active = (arr || []).filter(t => (t.text || '').trim() && !t.done);
  if (!active.length) return 'clean';
  const hasT1 = active.some(isT1Task);
  const hasStale = active.some(isStale);
  if (hasT1 || hasStale) return 'critical';
  if (active.length > EXEC.LANE_OVERLOAD) return 'overloaded';
  return 'active';
}

function sortTasksForDisplay(arr) {
  return arr
    .map((task, idx) => ({ task, idx }))
    .sort((a, b) => {
      const aActive = (a.task.text || '').trim() && !a.task.done;
      const bActive = (b.task.text || '').trim() && !b.task.done;
      if (!aActive && bActive) return 1;
      if (aActive && !bActive) return -1;
      if (aActive && bActive) {
        const aStale = isStale(a.task) ? 1 : 0;
        const bStale = isStale(b.task) ? 1 : 0;
        if (aStale !== bStale) return bStale - aStale;
        const aT1 = isT1Task(a.task) ? 1 : 0;
        const bT1 = isT1Task(b.task) ? 1 : 0;
        if (aT1 !== bT1) return bT1 - aT1;
        if (state.focusId === a.task.id) return -1;
        if (state.focusId === b.task.id) return 1;
      }
      return a.idx - b.idx;
    })
    .map(x => x.task);
}

function doneFadeStyle(task) {
  ensureTask(task);
  if (!task.completedAt) return '';
  const age = nowMs() - task.completedAt;
  const t = Math.min(1, age / EXEC.DONE_FADE_MS);
  const opacity = 1 - t * 0.45;
  const sat = 1 - t * 0.55;
  return `opacity:${opacity.toFixed(2)};filter:saturate(${sat.toFixed(2)})`;
}

function appendClosedToday(text) {
  const line = (text || '').trim();
  if (!line) return;
  const lines = (state.eod.closedToday || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.includes(line)) return;
  lines.push(line);
  state.eod.closedToday = lines.join('\n');
}

function completeTask(listId, idx) {
  const arr = getTaskArray(listId);
  if (!arr || !arr[idx]) return;
  const task = ensureTask(arr[idx]);
  const text = (task.text || '').trim();
  if (!text) {
    task.done = !task.done;
    if (task.done) task.completedAt = nowMs();
    else task.completedAt = null;
    renderAll();
    save();
    return;
  }

  task.done = true;
  task.completedAt = nowMs();
  touchTask(task);
  clearFocusIf(task.id);

  const removed = arr.splice(idx, 1)[0];
  state.doneLane = state.doneLane || [];
  state.doneLane.unshift(ensureTask(removed));
  if (state.doneLane.length > 24) state.doneLane = state.doneLane.slice(0, 24);
  appendClosedToday(text);

  renderAll();
  save();
}

const UI_STATE = {
  focus: null,
  selectionActive: false,
  selectionHighlightId: null,
  mode: 'idle'
};

const SELECTION_STRIP_MAX = 5;

function syncExecutionState() {
  const focusTask = getFocusTask();
  const selectionItems = computeUpNext().filter(item => item.task.id !== state.focusId);

  UI_STATE.focus = focusTask ? focusTask.id : null;
  UI_STATE.selectionActive = selectionItems.length > 0;
  UI_STATE.selectionHighlightId = !UI_STATE.focus && selectionItems[0]
    ? selectionItems[0].task.id
    : null;

  if (UI_STATE.focus) {
    UI_STATE.mode = 'focus';
  } else if (UI_STATE.selectionActive) {
    UI_STATE.mode = 'selection';
  } else {
    UI_STATE.mode = 'idle';
  }

  applyExecutionStateDOM();
}

function applyExecutionStateDOM() {
  const body = document.body;
  const stateClasses = [
    'state-focus-active',
    'state-selection-active',
    'state-idle'
  ];
  body.classList.remove(...stateClasses);

  if (UI_STATE.mode === 'focus') {
    body.classList.add('state-focus-active');
  } else if (UI_STATE.mode === 'selection') {
    body.classList.add('state-selection-active');
  } else {
    body.classList.add('state-idle');
  }

  const zoneCore = document.getElementById('zone-core');
  const zoneDecision = document.getElementById('zone-decision');
  const focusMount = document.getElementById('exec-focus-mount');
  const blocksShell = document.getElementById('section-blocks');

  zoneCore?.classList.add('execution-layer');
  blocksShell?.classList.add('execution-layer');
  zoneDecision?.classList.add('execution-layer');
  zoneDecision?.classList.toggle('selection-buffer', UI_STATE.selectionActive);
  zoneDecision?.classList.toggle('state-selection-active', UI_STATE.mode === 'selection');
  focusMount?.classList.toggle('focus-authoritative', !!UI_STATE.focus);

  applyLayerClasses();
  applyContextZoneClasses();
  body.dataset.executionState = UI_STATE.mode;
}

const ATTENTION = UI_STATE;

function applyLayerClasses() {
  document.querySelector('.topbar')?.classList.add('system-layer');
  document.getElementById('section-targets')?.classList.add('system-layer');
  document.getElementById('section-start')?.classList.add('system-layer');
  document.getElementById('zone-context')?.classList.add('system-layer');
  document.getElementById('drawer-tickets')?.classList.add('system-layer');
  document.getElementById('drawer-backdrop')?.classList.add('system-layer');
  document.getElementById('toast')?.classList.add('system-layer');
  document.getElementById('zone-core')?.classList.add('execution-layer', 'queue');
  document.getElementById('zone-decision')?.classList.add('execution-layer', 'up-next');
  document.getElementById('section-blocks')?.classList.add('execution-layer', 'blocks');
}

function applyContextZoneClasses() {
  const followups = document.getElementById('section-followups');
  const eod = document.getElementById('section-eod');
  const recent = document.getElementById('recent-panel');
  followups?.classList.add('context-zone', 'context-dependencies');
  eod?.classList.add('context-zone', 'context-memory');
  recent?.classList.add('context-zone', 'context-archive');
}

function makeFollowUp(snow, sent, reply) {
  return { id: uid(), snow: snow || '', sent: sent || '', reply: reply || '' };
}

function countMeaningfulTasks() {
  const b = state.blocks;
  const lanes = [
    ...(b.block1?.pushing || []),
    ...(b.block1?.internal || []),
    ...(b.block2?.pushing || []),
    ...(b.block2?.internal || [])
  ];
  return lanes.filter(t => (t.text || '').trim()).length;
}

function canAddTask() {
  return countMeaningfulTasks() < CAPS.tasks;
}

function migrateFromLegacy(raw) {
  let old;
  try {
    old = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
  if (!old || typeof old !== 'object') return null;

  const s = emptyState();

  (old.outcomes || []).slice(0, CAPS.targets).forEach((o, i) => {
    s.targets[i] = { id: o.id || uid(), text: (o.text || '').trim(), done: !!o.done };
  });

  s.start.workNotes = old.workNotes || '';

  const queue = (old.cards?.queue || []).map(c => ({
    text: (c.title || c.text || '').trim(),
    done: false
  })).filter(c => c.text);

  const waiting = (old.cards?.waiting || []).map(c => ({
    text: (c.title || c.text || '').trim(),
    done: false
  })).filter(c => c.text);

  const doneTitles = (old.cards?.done || []).map(c => (c.title || c.text || '').trim()).filter(Boolean);

  let qi = 0;
  const assign = (arr, max) => {
    while (arr.length < max && qi < queue.length) {
      arr.push(makeTask(queue[qi].text));
      qi++;
    }
  };

  assign(s.blocks.block1.pushing, CAPS.b1Pushing);
  assign(s.blocks.block1.internal, CAPS.b1Internal);
  assign(s.blocks.block2.pushing, CAPS.b2Pushing);
  assign(s.blocks.block2.internal, CAPS.b2Internal);

  waiting.slice(0, 4).forEach(w => {
    s.blocks.block3.items.push(makeTask(w.text));
  });

  while (qi < queue.length && s.blocks.block3.items.length < 6) {
    s.blocks.block3.items.push(makeTask(queue[qi].text));
    qi++;
  }

  if (doneTitles.length) {
    s.eod.closedToday = doneTitles.join('\n');
  }

  (old.followups || []).slice(0, CAPS.followUps).forEach(f => {
    if (f.snow !== undefined) {
      s.followUps.push(makeFollowUp(f.snow, f.sent, f.reply));
    } else {
      s.followUps.push(makeFollowUp(f.text || '', '', ''));
    }
  });

  s.tickets = (old.tickets || []).map(t => ({
    id: t.id || uid(),
    number: t.number || '',
    user: t.user || '',
    nextMove: t.nextMove || t.next || '',
    url: t.url || '',
    status: t.status || 'Pending'
  }));

  s.recentDays = (old.recentDays || []).slice(0, 7);
  s.lastDay = old.lastDay || '';

  return s;
}

function validateFocusId() {
  if (!state.focusId) return;
  if (!findTaskById(state.focusId)) state.focusId = null;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 2) {
        state = normalize(parsed);
        validateFocusId();
        return;
      }
    }
  } catch (e) { /* fall through */ }

  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = migrateFromLegacy(legacy);
      if (migrated) {
        state = normalize(migrated);
        validateFocusId();
        save();
        toast('Migrated from previous Execution Tower');
        return;
      }
    }
  } catch (e) { /* fall through */ }

  state = emptyState();
}

function normalize(s) {
  const base = emptyState();
  const merged = { ...base, ...s, start: { ...base.start, ...(s.start || {}) } };
  merged.blocks = {
    block1: { pushing: [], internal: [], ...(s.blocks?.block1 || {}) },
    block2: { pushing: [], internal: [], ...(s.blocks?.block2 || {}) },
    reset: { scan: '', ...(s.blocks?.reset || {}) },
    block3: { items: [], ...(s.blocks?.block3 || {}) }
  };
  merged.eod = { ...base.eod, ...(s.eod || {}) };
  merged.targets = (s.targets || []).slice(0, CAPS.targets);
  while (merged.targets.length < CAPS.targets) {
    merged.targets.push({ id: uid(), text: '', done: false });
  }
  merged.followUps = (merged.followUps || []).slice(0, CAPS.followUps);
  merged.eod.stillStuck = (merged.eod.stillStuck || []).slice(0, CAPS.stuck);
  merged.eod.tomorrowFollowUps = (merged.eod.tomorrowFollowUps || []).slice(0, CAPS.tomorrowFollowUps);
  merged.tickets = (merged.tickets || []).slice(0, CAPS.tickets);
  merged.recentDays = (merged.recentDays || []).slice(0, 7);
  merged.focusId = s.focusId || null;
  merged.doneLane = (merged.doneLane || []).map(ensureTask);

  Object.keys(LANES).forEach(listId => {
    const cfg = LANES[listId];
    merged.blocks[cfg.block][cfg.lane] = (merged.blocks[cfg.block][cfg.lane] || []).map(ensureTask);
  });

  return merged;
}

function renderAll() {
  syncExecutionState();
  renderExecutionChrome();
  renderTargets();
  renderStart();
  renderBlocks();
  renderFollowUps();
  renderEod();
  renderTickets();
  renderRecentDays();
  updateTaskCounter();
  renderProgressWave();
}

function renderExecutionChrome() {
  const focusMount = document.getElementById('exec-focus-mount');
  const upMount = document.getElementById('exec-upnext-mount');

  let focusStrip = document.getElementById('exec-focus-strip');
  if (!focusStrip && focusMount) {
    focusStrip = document.createElement('section');
    focusStrip.id = 'exec-focus-strip';
    focusStrip.className = 'exec-focus-strip glass-panel depth-3 layer-3';
    focusMount.appendChild(focusStrip);
  }

  const focusTask = getFocusTask();
  if (!focusStrip) { /* no mount */ } else if (!focusTask) {
    focusStrip.classList.add('empty');
    focusStrip.innerHTML = '';
  } else {
    focusStrip.classList.remove('empty');
    focusStrip.innerHTML = `
      <div class="exec-focus-label">Current Focus</div>
      <div class="exec-focus-row">
        <span class="exec-focus-dot" aria-hidden="true"></span>
        <span class="exec-focus-text">${esc(focusTask.text)}</span>
        <button type="button" class="btn-pill btn-ghost task-focus-clear" data-focus-clear="${esc(focusTask.id)}">Clear</button>
      </div>`;
  }

  let upNext = document.getElementById('exec-upnext');
  if (!upNext && upMount) {
    upNext = document.createElement('section');
    upNext.id = 'exec-upnext';
    upNext.className = 'exec-upnext glass-panel depth-2 layer-1';
    upMount.appendChild(upNext);
  }

  const queue = computeUpNext().filter(item => item.task.id !== state.focusId);
  const selection = queue.slice(0, SELECTION_STRIP_MAX);
  const isFocusState = UI_STATE.mode === 'focus';
  const isSelectionState = UI_STATE.mode === 'selection';

  if (upNext) upNext.classList.add('selection-buffer');

  if (!upNext) { /* no mount */ } else if (!selection.length) {
    upNext.innerHTML = `
      <div class="exec-upnext-label">Up Next</div>
      <p class="exec-upnext-empty">Promoted queue items appear here.</p>`;
  } else {
    upNext.innerHTML = `
      <div class="exec-upnext-label">${isFocusState ? 'After focus' : 'Up Next'}</div>
      <div class="exec-upnext-list">
        ${selection.map((item, i) => {
          const isPick = isSelectionState && i === 0;
          return `
          <div class="exec-upnext-item priority-upnext${isPick ? ' is-selection-pick' : ''}${isFocusState ? ' priority-passive' : ''}">
            <span class="exec-rank meta-secondary">${i + 1}</span>
            <span class="upnext-text">${esc(item.label)}</span>
            <button type="button" class="task-focus-btn meta-secondary row-action" data-set-focus="${esc(item.task.id)}">Focus</button>
          </div>`;
        }).join('')}
      </div>`;
  }
}

function renderDoneLane() {
  let wrap = document.getElementById('exec-done-lane');
  const section = document.getElementById('section-blocks');
  if (!section) return;

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'exec-done-lane';
    wrap.className = 'exec-done-lane';
    section.appendChild(wrap);
  }

  const done = (state.doneLane || []).filter(t => (t.text || '').trim());
  if (!done.length) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  wrap.className = 'exec-done-lane priority-done done';
  wrap.innerHTML = `
    <div class="lane-label">Done <span class="lane-cap">${done.length}</span></div>
    ${done.map((task, i) => `
      <div class="exec-done-row" style="${doneFadeStyle(task)}">
        <span class="task-check checked" aria-hidden="true">✓</span>
        <span class="task-input">${esc(task.text)}</span>
        <button type="button" class="task-del" data-done-del="${i}" aria-label="Remove">✕</button>
      </div>`).join('')}`;
}

function renderProgressWave() {
  let wrap = document.getElementById('progress-wave');
  if (!wrap) {
    const blocksSection = document.getElementById('section-blocks');
    const head = blocksSection?.querySelector('.section-head-inline');
    if (head) {
      wrap = document.createElement('div');
      wrap.id = 'progress-wave';
      wrap.className = 'progress-wave';
      wrap.innerHTML = '<div class="progress-wave-fill" id="progress-fill"></div>';
      head.after(wrap);
    }
  }
  const fill = document.getElementById('progress-fill');
  if (!fill) return;
  const total = countMeaningfulTasks();
  const pct = Math.min(100, Math.round((total / CAPS.tasks) * 100));
  fill.style.width = pct + '%';
}

function updateTaskCounter() {
  const el = document.getElementById('task-counter');
  if (!el) return;
  const n = countMeaningfulTasks();
  el.textContent = n + ' / ' + CAPS.tasks + ' tasks';
  el.classList.toggle('at-cap', n >= CAPS.tasks);
}

function setFieldValueIfIdle(el, value) {
  if (!el || document.activeElement === el) return;
  el.value = value ?? '';
}

function renderTargets() {
  const list = document.getElementById('targets-list');
  if (!list) return;
  const active = document.activeElement;
  if (active?.classList.contains('target-input') && list.contains(active)) return;
  const locked = !!state.start.targetsLocked;
  list.innerHTML = state.targets.map((t, i) => {
    const tagClass = i === 0 ? 'target-t1' : 'target-t2';
    const hasText = !!(t.text || '').trim();
    return `
    <div class="target-row priority-passive${t.done ? ' done' : ''}${locked ? ' locked' : ''}${hasText ? ' ' + tagClass : ''}">
      <span class="target-tag">T${i + 1}</span>
      <input type="text" class="target-input" data-idx="${i}" value="${esc(t.text)}"
        placeholder="Target ${i + 1} — what must move today?" maxlength="120"${locked ? ' readonly' : ''}>
      <button type="button" class="task-check${t.done ? ' checked' : ''}" data-target-done="${i}" aria-label="Toggle target ${i + 1}">✓</button>
    </div>`;
  }).join('');
}

function renderStart() {
  document.getElementById('chk-targets-locked').checked = !!state.start.targetsLocked;
  document.getElementById('chk-no-reacting').checked = !!state.start.noReacting;
  setFieldValueIfIdle(document.getElementById('work-notes'), state.start.workNotes || '');
}

function taskRowHTML(task, listId, idx) {
  ensureTask(task);
  const isFocus = UI_STATE.focus === task.id;
  const active = (task.text || '').trim() && !task.done;
  const classes = ['task-row', 'priority-queue'];

  if (task.done) {
    classes.push('priority-done', 'layer-0');
  } else if (UI_STATE.mode === 'focus') {
    if (isFocus) {
      classes.push('is-focus', 'priority-focus', 'layer-3');
    } else if (active) {
      classes.push('priority-passive', 'is-suppressed', 'layer-0');
    }
  } else if (active) {
    classes.push('priority-passive');
    if (isStale(task)) classes.push('is-stale');
  }

  const showBadges = UI_STATE.mode === 'idle';
  const badges = [];
  if (showBadges && isT1Task(task)) badges.push('T1');
  if (showBadges && isStale(task)) badges.push('stale');

  return `
    <div class="${classes.join(' ')}" data-task-id="${esc(task.id)}">
      <button type="button" class="task-check${task.done ? ' checked' : ''}" data-list="${listId}" data-idx="${idx}">✓</button>
      <input type="text" class="task-input" data-list="${listId}" data-idx="${idx}" value="${esc(task.text)}" placeholder="Task…" maxlength="120">
      ${active ? `<button type="button" class="task-focus-btn row-action${isFocus ? ' is-active' : ''}" data-set-focus="${esc(task.id)}" title="Set Focus">Focus</button>` : ''}
      ${badges.length ? `<span class="lane-cap meta-secondary">${badges.join(' · ')}</span>` : ''}
      <button type="button" class="task-del row-action" data-list="${listId}" data-idx="${idx}" aria-label="Remove">✕</button>
    </div>`;
}

function renderTaskList(listId) {
  const el = document.getElementById(listId);
  if (!el) return;
  const active = document.activeElement;
  if (active?.classList.contains('task-input') && active.dataset.list === listId && el.contains(active)) {
    return;
  }
  const cfg = LANES[listId];
  if (!cfg) return;
  const arr = state.blocks[cfg.block][cfg.lane] || [];
  const sorted = sortTasksForDisplay(arr);
  el.innerHTML = sorted.map((t) => {
    const idx = arr.indexOf(t);
    return taskRowHTML(t, listId, idx);
  }).join('');

  const laneEl = el.closest('.task-lane');
  if (laneEl) {
    const laneState = getLaneState(listId, arr);
    laneEl.classList.remove('lane-clean', 'lane-active', 'lane-critical', 'lane-overloaded', 'lane-bg', 'lane-semi', 'lane-equal');
    laneEl.classList.add('lane-' + laneState, 'priority-passive');
  }

  const atLaneMax = arr.length >= cfg.max;
  const atGlobalCap = countMeaningfulTasks() >= CAPS.tasks;
  const canAdd = !atLaneMax && (listId.startsWith('b3') || !atGlobalCap || arr.some(t => !(t.text || '').trim()));
  const addBtn = `<button type="button" class="slot-add" data-add="${listId}"${canAdd ? '' : ' disabled'}>+ add</button>`;
  el.insertAdjacentHTML('beforeend', addBtn);
}

function renderBlocks() {
  Object.keys(LANES).forEach(renderTaskList);
  setFieldValueIfIdle(document.getElementById('reset-scan'), state.blocks.reset?.scan || '');
  renderDoneLane();
}

function followUpRowHTML(fu, listType, idx) {
  return `
    <div class="followup-row">
      <input type="text" class="clay-input" data-fu="${listType}" data-field="snow" data-idx="${idx}" value="${esc(fu.snow)}" placeholder="Ticket / item">
      <input type="text" class="clay-input" data-fu="${listType}" data-field="sent" data-idx="${idx}" value="${esc(fu.sent)}" placeholder="Sent">
      <input type="text" class="clay-input" data-fu="${listType}" data-field="reply" data-idx="${idx}" value="${esc(fu.reply)}" placeholder="Reply">
      <button type="button" class="task-del" data-fu-del="${listType}" data-idx="${idx}" aria-label="Remove">✕</button>
    </div>`;
}

function renderFollowUps() {
  const list = document.getElementById('followups-list');
  const btn = document.getElementById('btn-add-followup');
  if (!list) return;
  list.innerHTML = state.followUps.map((f, i) => followUpRowHTML(f, 'mid', i)).join('');
  if (btn) btn.disabled = state.followUps.length >= CAPS.followUps;
}

function renderEod() {
  setFieldValueIfIdle(document.getElementById('eod-closed'), state.eod.closedToday || '');
  setFieldValueIfIdle(document.getElementById('eod-t1'), state.eod.tomorrowT1 || '');
  setFieldValueIfIdle(document.getElementById('eod-t2'), state.eod.tomorrowT2 || '');

  const stuckList = document.getElementById('eod-stuck-list');
  stuckList.innerHTML = (state.eod.stillStuck || []).map((s, i) => `
    <div class="stuck-row">
      <input type="text" class="clay-input" data-stuck="${i}" value="${esc(s.text)}" placeholder="Still stuck…" maxlength="120">
      <button type="button" class="task-del" data-stuck-del="${i}">✕</button>
    </div>
  `).join('');

  document.getElementById('btn-add-stuck').disabled = (state.eod.stillStuck || []).length >= CAPS.stuck;

  const eodFu = document.getElementById('eod-followups-list');
  eodFu.innerHTML = (state.eod.tomorrowFollowUps || []).map((f, i) => followUpRowHTML(f, 'tomorrow', i)).join('');
  document.getElementById('btn-add-eod-followup').disabled = (state.eod.tomorrowFollowUps || []).length >= CAPS.tomorrowFollowUps;
}

function renderTickets() {
  const list = document.getElementById('tickets-list');
  if (!list) return;
  const active = document.activeElement;
  if (active?.dataset.ticket !== undefined && list.contains(active)) return;
  if (!state.tickets.length) {
    list.innerHTML = '<p class="recent-empty">No active tickets</p>';
    return;
  }
  list.innerHTML = state.tickets.map((t, i) => `
    <div class="ticket-card">
      <button type="button" class="ticket-del" data-ticket-del="${i}">✕</button>
      <input type="text" data-ticket="${i}" data-field="number" value="${esc(t.number)}" placeholder="RITM / INC number">
      <input type="text" data-ticket="${i}" data-field="user" value="${esc(t.user)}" placeholder="User">
      <input type="text" data-ticket="${i}" data-field="nextMove" value="${esc(t.nextMove)}" placeholder="Next move">
      <select data-ticket="${i}" data-field="status">
        ${['Pending', 'Waiting User', 'Waiting Vendor', 'In Progress', 'Ready To Close', 'Closed'].map(st =>
          `<option value="${st}"${t.status === st ? ' selected' : ''}>${st}</option>`
        ).join('')}
      </select>
    </div>
  `).join('');
}

function relDayLabel(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today - d) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (e) {
    return iso || '';
  }
}

function renderRecentDays() {
  const body = document.getElementById('recent-body');
  const hint = document.getElementById('recent-hint');
  const days = state.recentDays || [];
  if (hint) {
    hint.textContent = days.length
      ? days.length + (days.length === 1 ? ' day' : ' days')
      : 'Nothing archived yet';
  }
  if (!body) return;
  if (!days.length) {
    body.innerHTML = '<p class="recent-empty">Days you close with New Day are remembered here.</p>';
    return;
  }
  body.innerHTML = days.map(d => {
    const targets = (d.targets || d.commitments || []).filter(Boolean);
    const closed = (d.closed || d.completed || []).filter(Boolean);
    const stuck = (d.stuck || d.carryover || []).filter(Boolean);
    const summary = targets.length
      ? 'T1/T2: ' + targets.join(' · ')
      : closed.length
        ? 'Closed: ' + closed.join(' · ')
        : 'No targets logged';
    return `
      <div class="recent-day">
        <div class="recent-date">${esc(relDayLabel(d.date))}</div>
        <div class="recent-summary">${esc(summary)}</div>
      </div>`;
  }).join('');
}

function getTaskArray(listId) {
  const cfg = LANES[listId];
  if (!cfg) return null;
  return state.blocks[cfg.block][cfg.lane];
}

function addTask(listId) {
  const cfg = LANES[listId];
  if (!cfg) return;
  const arr = getTaskArray(listId);
  if (arr.length >= cfg.max) {
    toast('Max ' + cfg.max + ' in this lane');
    return;
  }
  if (!listId.startsWith('b3') && !canAddTask()) {
    toast('Max ' + CAPS.tasks + ' meaningful tasks today');
    return;
  }
  arr.push(makeTask(''));
  renderAll();
  save();
  setTimeout(() => {
    const inputs = document.querySelectorAll(`#${listId} .task-input`);
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }, 30);
}

function archiveDay() {
  const targets = state.targets.map(t => (t.text || '').trim()).filter(Boolean);
  const closed = (state.eod.closedToday || '').split('\n').map(s => s.trim()).filter(Boolean);
  const stuck = (state.eod.stillStuck || []).map(s => (s.text || '').trim()).filter(Boolean);
  if (!targets.length && !closed.length && !stuck.length) return;

  const rec = { date: todayKey(), targets, closed, stuck };
  state.recentDays = (state.recentDays || []).filter(d => d.date !== rec.date);
  state.recentDays.unshift(rec);
  if (state.recentDays.length > 7) state.recentDays = state.recentDays.slice(0, 7);
}

function newDay() {
  if (!confirm('Start a new day?\n\nToday archives to Recent Days. Execution blocks reset. Tomorrow targets become today\'s T1/T2.')) return;
  archiveDay();

  const t1 = (state.eod.tomorrowT1 || '').trim();
  const t2 = (state.eod.tomorrowT2 || '').trim();

  state.lastDay = todayKey();
  state.dateKey = todayKey();
  state.targets = [
    { id: uid(), text: t1, done: false },
    { id: uid(), text: t2, done: false }
  ];
  state.start = { targetsLocked: false, noReacting: false, workNotes: state.start.workNotes || '' };
  state.blocks = {
    block1: { pushing: [], internal: [] },
    block2: { pushing: [], internal: [] },
    reset: { scan: '' },
    block3: { items: [] }
  };
  state.followUps = (state.eod.tomorrowFollowUps || []).map(f =>
    makeFollowUp(f.snow, f.sent, f.reply)
  ).slice(0, CAPS.followUps);
  state.eod = {
    closedToday: '',
    stillStuck: [],
    tomorrowT1: '',
    tomorrowT2: '',
    tomorrowFollowUps: []
  };
  state.focusId = null;
  state.doneLane = [];

  document.getElementById('date-display').textContent = fmtDate(new Date());
  renderAll();
  save();
  toast('New day started');
}

function cleanSession() {
  if (!confirm('Clean session?\n\nClears targets, blocks, follow-ups, and EOD. Keeps work notes, tickets, and recent days.')) return;
  state.targets = [
    { id: uid(), text: '', done: false },
    { id: uid(), text: '', done: false }
  ];
  state.start.targetsLocked = false;
  state.start.noReacting = false;
  state.blocks = {
    block1: { pushing: [], internal: [] },
    block2: { pushing: [], internal: [] },
    reset: { scan: '' },
    block3: { items: [] }
  };
  state.followUps = [];
  state.eod = {
    closedToday: '',
    stillStuck: [],
    tomorrowT1: '',
    tomorrowT2: '',
    tomorrowFollowUps: []
  };
  state.focusId = null;
  state.doneLane = [];
  renderAll();
  save();
  toast('Clean session started');
}

function openTickets() {
  document.getElementById('drawer-tickets').classList.add('open');
  document.getElementById('drawer-backdrop').hidden = false;
}

function closeTickets() {
  document.getElementById('drawer-tickets').classList.remove('open');
  document.getElementById('drawer-backdrop').hidden = true;
}

function toggleRecent() {
  const panel = document.getElementById('recent-panel');
  const body = document.getElementById('recent-body');
  const btn = document.getElementById('recent-toggle');
  const collapsed = panel.classList.toggle('collapsed');
  body.hidden = collapsed;
  btn.setAttribute('aria-expanded', String(!collapsed));
}

function bindEvents() {
  document.getElementById('btn-new-day').addEventListener('click', newDay);
  document.getElementById('btn-clean').addEventListener('click', cleanSession);
  document.getElementById('btn-open-tickets').addEventListener('click', openTickets);
  document.getElementById('btn-close-tickets').addEventListener('click', closeTickets);
  document.getElementById('drawer-backdrop').addEventListener('click', closeTickets);
  document.getElementById('recent-toggle').addEventListener('click', toggleRecent);

  document.getElementById('chk-targets-locked').addEventListener('change', e => {
    state.start.targetsLocked = e.target.checked;
    renderAll();
    save();
  });
  document.getElementById('chk-no-reacting').addEventListener('change', e => {
    state.start.noReacting = e.target.checked;
    save();
  });
  document.getElementById('work-notes').addEventListener('input', e => {
    state.start.workNotes = e.target.value;
    save();
  });
  document.getElementById('reset-scan').addEventListener('input', e => {
    state.blocks.reset.scan = e.target.value;
    save();
  });

  document.getElementById('btn-add-followup').addEventListener('click', () => {
    if (state.followUps.length >= CAPS.followUps) {
      toast('Max ' + CAPS.followUps + ' follow-ups');
      return;
    }
    state.followUps.push(makeFollowUp('', '', ''));
    renderFollowUps();
    save();
  });

  document.getElementById('btn-add-stuck').addEventListener('click', () => {
    if ((state.eod.stillStuck || []).length >= CAPS.stuck) {
      toast('Max ' + CAPS.stuck + ' stuck items');
      return;
    }
    state.eod.stillStuck.push({ id: uid(), text: '' });
    renderEod();
    save();
  });

  document.getElementById('btn-add-eod-followup').addEventListener('click', () => {
    if ((state.eod.tomorrowFollowUps || []).length >= CAPS.tomorrowFollowUps) {
      toast('Max ' + CAPS.tomorrowFollowUps + ' tomorrow follow-ups');
      return;
    }
    state.eod.tomorrowFollowUps.push(makeFollowUp('', '', ''));
    renderEod();
    save();
  });

  document.getElementById('btn-add-ticket').addEventListener('click', () => {
    if (state.tickets.length >= CAPS.tickets) {
      toast('Max ' + CAPS.tickets + ' tickets');
      return;
    }
    state.tickets.push({ id: uid(), number: '', user: '', nextMove: '', url: '', status: 'Pending' });
    renderTickets();
    save();
  });

  document.addEventListener('input', e => {
    const t = e.target;

    if (t.classList.contains('target-input')) {
      if (state.start.targetsLocked) return;
      const i = +t.dataset.idx;
      state.targets[i].text = t.value;
      save();
      return;
    }

    if (t.classList.contains('task-input')) {
      const arr = getTaskArray(t.dataset.list);
      if (!arr) return;
      const task = ensureTask(arr[+t.dataset.idx]);
      const prev = (task.text || '').trim();
      task.text = t.value;
      touchTask(task);
      const now = (t.value || '').trim();
      if (!prev && now && !canAddTask() && !t.dataset.list.startsWith('b3')) {
        task.text = '';
        t.value = '';
        toast('Max ' + CAPS.tasks + ' meaningful tasks today');
      }
      validateFocusId();
      updateTaskCounter();
      save();
      return;
    }

    if (t.dataset.fu) {
      const list = t.dataset.fu === 'mid' ? state.followUps : state.eod.tomorrowFollowUps;
      list[+t.dataset.idx][t.dataset.field] = t.value;
      save();
      return;
    }

    if (t.dataset.stuck !== undefined) {
      state.eod.stillStuck[+t.dataset.stuck].text = t.value;
      save();
      return;
    }

    if (t.dataset.ticket !== undefined) {
      state.tickets[+t.dataset.ticket][t.dataset.field] = t.value;
      save();
      return;
    }

    if (t.id === 'eod-closed') {
      state.eod.closedToday = t.value;
      save();
    } else if (t.id === 'eod-t1') {
      state.eod.tomorrowT1 = t.value;
      save();
    } else if (t.id === 'eod-t2') {
      state.eod.tomorrowT2 = t.value;
      save();
    }
  });

  document.addEventListener('blur', e => {
    const t = e.target;
    if (t.classList.contains('task-input') || t.classList.contains('target-input')) {
      renderAll();
    }
  }, true);

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.ticket !== undefined && t.dataset.field === 'status') {
      state.tickets[+t.dataset.ticket].status = t.value;
      save();
    }
  });

  document.addEventListener('click', e => {
    const t = e.target;

    if (t.dataset.targetDone !== undefined) {
      const i = +t.dataset.targetDone;
      state.targets[i].done = !state.targets[i].done;
      renderAll();
      save();
      return;
    }

    if (t.dataset.setFocus) {
      setFocus(t.dataset.setFocus);
      renderAll();
      save();
      return;
    }

    if (t.dataset.focusClear) {
      state.focusId = null;
      renderAll();
      save();
      return;
    }

    if (t.dataset.list && t.classList.contains('task-check')) {
      completeTask(t.dataset.list, +t.dataset.idx);
      return;
    }

    if (t.dataset.add) {
      addTask(t.dataset.add);
      return;
    }

    if (t.dataset.list && t.classList.contains('task-del')) {
      const arr = getTaskArray(t.dataset.list);
      const task = arr?.[+t.dataset.idx];
      if (task) clearFocusIf(task.id);
      arr?.splice(+t.dataset.idx, 1);
      renderAll();
      save();
      return;
    }

    if (t.dataset.doneDel !== undefined) {
      state.doneLane.splice(+t.dataset.doneDel, 1);
      renderAll();
      save();
      return;
    }

    if (t.dataset.fuDel) {
      const list = t.dataset.fuDel === 'mid' ? state.followUps : state.eod.tomorrowFollowUps;
      list.splice(+t.dataset.idx, 1);
      t.dataset.fuDel === 'mid' ? renderFollowUps() : renderEod();
      save();
      return;
    }

    if (t.dataset.stuckDel !== undefined) {
      state.eod.stillStuck.splice(+t.dataset.stuckDel, 1);
      renderEod();
      save();
      return;
    }

    if (t.dataset.ticketDel !== undefined) {
      state.tickets.splice(+t.dataset.ticketDel, 1);
      renderTickets();
      save();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeTickets();
  });
}

function init() {
  loadState();
  document.getElementById('date-display').textContent = fmtDate(new Date());

  if (state.lastDay && state.lastDay !== todayKey()) {
    toast('New calendar day — use New Day when ready');
  }

  bindEvents();
  applyContextZoneClasses();
  renderAll();
}

init();

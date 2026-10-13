const elements = Object.fromEntries([
  'login-view', 'status-view', 'login-form', 'password', 'login-feedback',
  'login-submit', 'logout', 'refresh', 'connection-banner', 'connection-title',
  'connection-copy', 'last-received', 'target-date', 'run-mode', 'monitor-from',
  'release-at', 'monitor-until', 'slots', 'slot-template', 'empty-state',
  'events', 'event-count', 'no-events', 'demo-badge',
  'control-panel', 'control-state', 'control-demo', 'control-note', 'control-form',
  'control-fields', 'control-save', 'control-start', 'control-stop', 'control-close',
  'control-feedback', 'settings-status', 'setting-date', 'setting-monitor-from',
  'setting-release-at', 'setting-monitor-until', 'setting-delay', 'setting-manual',
  'setting-schedule-reset',
  'slot-1-enabled', 'slot-1-time', 'slot-1-profile', 'slot-2-enabled', 'slot-2-time',
  'slot-2-profile', 'push-enable', 'push-test', 'push-disable', 'push-copy', 'push-feedback',
  'progress-tab', 'settings-tab', 'progress-panel', 'settings-panel', 'settings-tab-dirty',
  'status-heading', 'review-settings', 'run-actions', 'schedule-summary', 'slot-2-options',
  'attention-banner', 'attention-title', 'attention-copy', 'attention-open',
  'close-dialog', 'close-copy', 'close-confirm', 'close-cancel',
].map((id) => [id, document.getElementById(id)]));

const phaseDetails = {
  waiting: ['等待開始', 'Mac 已準備這個時段，將在設定時間開始查詢。', 'is-muted'],
  warming: ['正在預熱', '正在準備預約瀏覽器與查詢頁面。', ''],
  monitoring: ['持續查詢', '正在查詢餘位；符合預約條件時，程式會嘗試暫留。', ''],
  retrying: ['等待重試', '稍候再次查詢，請以最新回應判斷餘位狀態。', ''],
  reserving: ['正在暫留', '已送出暫留操作，正在確認結果。', 'is-action'],
  held: ['已暫留', '請回到 Mac 查看表單，完成最後確認與付款。尚未完成預約。', 'is-action'],
  manual: ['待人工接手', '需要你在 Mac 檢查並操作預約瀏覽器。', 'is-warning'],
  ambiguous: ['結果待確認', '暫留結果尚不明確。請在 Mac 檢查原頁面，再決定下一步。', 'is-warning'],
  failed: ['已停止 · 異常', '這個時段已停止。請到 Mac 查看原因與瀏覽器狀態。', 'is-warning'],
  stopped: ['已停止', '這個時段已停止查詢。請在 Mac 確認後續處理。', 'is-muted'],
  deadline: ['監控已截止', '已到監控截止時間，不會再發起查詢。', 'is-muted'],
  'handed-off': ['已交由人工', '自動化已交接。請在 Mac 完成確認與付款。尚未確認預約結果。', 'is-action'],
};

const availabilityLabels = {
  available: '可預約', unavailable: '目前不可預約', unknown: '尚待確認',
  limited: '查詢受限', manual: '需要人工確認',
};
const connectionValues = new Set(['waiting', 'live', 'stale', 'ended']);
const dateFormatter = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
const taipeiTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const taipeiTimeWithSeconds = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const taipeiDate = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
const numberFormatter = new Intl.NumberFormat('zh-TW');

let authenticated = false;
let snapshot = null;
let eventSource = null;
let reconnectTimer = null;
let reconnectDelay = 1500;
let generation = 0;
let lastReceivedAt = 0;
let clockOffset = 0;
let connecting = false;
let pendingLogout = false;
let slotViews = [];
let authGeneration = 0;
let control = null;
let controlReceivedAt = 0;
let controlRequest = null;
let controlEpoch = 0;
let settingsDirty = false;
let settingsTargetDate = '';
let commandBusy = false;
let pushConfig = null;
let pushSubscription = null;
let pushBusy = false;
let pushNeedsRenew = false;
let pushSyncError = false;
let activePanel = 'progress';
let pendingCloseRunId = null;

function selectDashboardPanel(panel, scroll = true, focus = false) {
  if (!['progress', 'settings'].includes(panel)) return;
  activePanel = panel;
  for (const name of ['progress', 'settings']) {
    elements[`${name}-panel`].hidden = name !== panel;
    elements[`${name}-tab`].setAttribute('aria-selected', String(name === panel));
    elements[`${name}-tab`].tabIndex = name === panel ? 0 : -1;
  }
  elements['status-heading'].textContent = panel === 'progress' ? '搶位進度' : '搶位設定';
  if (focus) elements[`${panel}-tab`].focus({ preventScroll: true });
  if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
  renderAttention();
}

function renderAttention() {
  const slot = ['ambiguous', 'manual', 'held', 'handed-off', 'failed']
    .map((phase) => snapshot?.slots.find((item) => item.phase === phase)).find(Boolean);
  const external = controlFresh() && control.externalRun;
  elements['attention-banner'].hidden = !authenticated || (!slot && !external);
  elements['attention-open'].hidden = activePanel === 'progress';
  if (!slot && !external) return;
  const outdated = slot && (dataStale() || snapshot.connection === 'ended');
  elements['attention-banner'].classList.toggle('is-warning', Boolean(outdated || ['ambiguous', 'manual', 'failed'].includes(slot?.phase)));
  if (slot) {
    const [phase, description] = phaseDetails[slot.phase];
    elements['attention-title'].textContent = `${outdated ? '最後記錄：' : ''}${slot.slot} ${phase}`;
    elements['attention-copy'].textContent = outdated
      ? '這是最後收到的狀態。請在 Mac 的原預約頁面確認目前船位與付款結果。'
      : description;
  } else {
    elements['attention-title'].textContent = 'Mac 終端機執行中';
    elements['attention-copy'].textContent = '此任務由 Mac 終端機啟動。請在原終端機停止、交接或結束。';
  }
}

function validTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000;
}

function readableTime(value, includeDate = false) {
  if (!validTime(value)) return '—';
  try {
    return `${includeDate ? `${taipeiDate.format(value)}\n` : ''}${taipeiTime.format(value)}`;
  } catch {
    return '—';
  }
}

function elapsedLabel(value) {
  if (!validTime(value)) return '尚未更新';
  const seconds = Math.max(0, Math.floor((Date.now() + clockOffset - value) / 1000));
  if (seconds < 5) return '剛剛更新';
  if (seconds < 60) return `${seconds} 秒前更新`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分鐘前更新`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小時前更新`;
  return `${Math.floor(seconds / 86400)} 天前更新`;
}

function transportStale() {
  return !navigator.onLine || !lastReceivedAt || Date.now() - lastReceivedAt > 15000;
}

function dataStale() {
  return transportStale() || snapshot?.connection === 'stale';
}

function stopConnection() {
  generation += 1;
  eventSource?.close();
  eventSource = null;
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connecting = false;
}

function setLoginFeedback(message, invalid = false) {
  elements['login-feedback'].textContent = message;
  elements.password.setAttribute('aria-invalid', invalid ? 'true' : 'false');
}

function showLogin(message = '', focus = false) {
  authGeneration += 1;
  stopConnection();
  authenticated = false;
  document.body.classList.remove('dashboard-active');
  if (elements['close-dialog'].open) elements['close-dialog'].close();
  pendingCloseRunId = null;
  snapshot = null;
  lastReceivedAt = 0;
  slotViews = [];
  elements.slots.replaceChildren();
  elements.events.replaceChildren();
  elements['status-view'].hidden = true;
  elements['login-view'].hidden = false;
  elements.logout.hidden = true;
  elements.password.value = '';
  controlEpoch += 1;
  control = null;
  controlReceivedAt = 0;
  controlRequest = null;
  settingsDirty = false;
  commandBusy = false;
  pushConfig = null;
  pushSubscription = null;
  pushBusy = false;
  pushNeedsRenew = false;
  pushSyncError = false;
  elements['control-form'].reset();
  controlFeedback('');
  elements['push-feedback'].textContent = '';
  renderControl();
  renderPush();
  selectDashboardPanel('progress', false);
  setLoginFeedback(message);
  if (focus) elements.password.focus();
}

function showStatus() {
  authenticated = true;
  document.body.classList.add('dashboard-active');
  elements['login-view'].hidden = true;
  elements['status-view'].hidden = false;
  elements.logout.hidden = false;
  elements.password.value = '';
  selectDashboardPanel('progress', false);
  updateConnection();
  void refreshControl();
  void refreshPush();
}

async function api(path, options = {}) {
  return fetch(path, {
    ...options, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
}

function isSnapshot(value) {
  return value && value.schemaVersion === 1 && validTime(value.serverTime)
    && connectionValues.has(value.connection) && Array.isArray(value.slots)
    && Array.isArray(value.recentEvents)
    && value.slots.every((slot) => slot && typeof slot.slot === 'string' && Object.hasOwn(phaseDetails, slot.phase));
}

function receiveSnapshot(value) {
  if (!isSnapshot(value)) throw new Error('Invalid monitor snapshot');
  snapshot = value;
  lastReceivedAt = Date.now();
  clockOffset = value.serverTime - lastReceivedAt;
  reconnectDelay = 1500;
  renderSnapshot();
  updateConnection();
}

function updateConnection() {
  if (!authenticated) return;
  let title = '正在連線';
  let copy = '正在取得 Mac 的搶位狀態。';
  let tone = 'is-neutral';
  if (!navigator.onLine) {
    title = '手機目前離線';
    copy = snapshot ? '畫面保留上次收到的狀態；資料可能已過期。連線恢復後會自動更新。' : '目前無法取得進度。連線恢復後會自動重新連線。';
    tone = 'is-warning';
  } else if (snapshot?.connection === 'stale') {
    title = 'Mac 的進度已過期';
    copy = '監控服務未收到搶位程式的最新心跳。請在 Mac 確認程式是否仍在運作。';
    tone = 'is-warning';
  } else if (snapshot && transportStale()) {
    title = '連線中斷 · 資料已過期';
    copy = '正在重新連線。顯示的是最後收到的狀態，不能代表目前進度。';
    tone = 'is-warning';
  } else if (snapshot?.connection === 'ended') {
    title = '本次搶位已結束';
    copy = '以下為最後收到的進度。預約與付款結果，請在 Mac 的官方頁面確認。';
  } else if (snapshot?.connection === 'waiting') {
    title = '連線正常 · 等待搶位程式';
    copy = 'Mac 啟動搶位程式後，這裡會自動開始顯示進度。';
  } else if (snapshot) {
    title = snapshot.run?.id === 'demo' ? '演示模式 · 即時更新' : '連線正常 · 即時更新';
    copy = snapshot.run?.id === 'demo' ? '這是模擬進度，用來預覽看板；未進行真實搶位。' : '各時段獨立進行，手機關閉畫面不會中止搶位。';
    tone = '';
  }
  elements['connection-banner'].className = `connection-banner ${tone}`.trim();
  elements['connection-title'].textContent = title;
  elements['connection-copy'].textContent = copy;
  elements['last-received'].textContent = snapshot ? `資料${elapsedLabel(snapshot.updatedAt || snapshot.heartbeatAt)}` : '';
  updateTimers();
  renderControl();
}

function renderOverview() {
  const saved = !snapshot?.run && controlFresh() && !controlLocked() && settingsReady(control.settings) ? control.settings : null;
  const run = snapshot?.run || saved;
  if (run && typeof run.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(run.targetDate)) {
    const parsed = Date.parse(`${run.targetDate}T00:00:00+09:00`);
    elements['target-date'].textContent = Number.isFinite(parsed) ? dateFormatter.format(parsed) : '日期待確認';
    elements['run-mode'].textContent = `${run.targetDate.slice(0, 4)} 年 · ${saved ? '已儲存設定 · 尚未啟動' : snapshot.connection === 'ended' ? '本次執行已結束' : '自動搶位進度'}`;
    for (const [id, key] of [['monitor-from', 'monitorFrom'], ['release-at', 'releaseAt'], ['monitor-until', 'monitorUntil']]) {
      elements[id].textContent = readableTime(saved ? Date.parse(run[key]) : run[key], true);
    }
  } else {
    elements['target-date'].textContent = '等待搶位程式';
    elements['run-mode'].textContent = '尚未收到執行資訊';
    ['monitor-from', 'release-at', 'monitor-until'].forEach((id) => { elements[id].textContent = '—'; });
  }
  elements['demo-badge'].hidden = snapshot?.run?.id !== 'demo' && !control?.demo;
}

function renderSnapshot() {
  renderOverview();
  const previousViews = new Map(slotViews.map((view) => [view.slot.slot, view]));
  slotViews = snapshot.slots.slice(0, 10).map((slot) => {
    const previous = previousViews.get(slot.slot);
    const card = previous?.card || elements['slot-template'].content.firstElementChild.cloneNode(true);
    const [phase, description, tone] = phaseDetails[slot.phase];
    card.dataset.phase = slot.phase;
    card.querySelector('.slot-time').textContent = slot.slot;
    card.querySelector('.phase-badge').textContent = phase;
    card.querySelector('.phase-badge').className = `phase-badge ${tone}`.trim();
    card.querySelector('.phase-description').textContent = description;
    card.querySelector('.attempts').textContent = Number.isFinite(slot.attempts) && slot.attempts >= 0 ? numberFormatter.format(slot.attempts) : '—';
    card.querySelector('.availability').textContent = Object.hasOwn(availabilityLabels, slot.availability) ? availabilityLabels[slot.availability] : '尚未查詢';
    card.querySelector('.response').textContent = typeof slot.responseMs === 'number' && Number.isFinite(slot.responseMs) && slot.responseMs >= 0 ? `${numberFormatter.format(Math.round(slot.responseMs))} ms` : '—';
    const handoff = card.querySelector('.slot-handoff');
    const handoffButton = card.querySelector('.handoff-button');
    handoffButton.setAttribute('aria-label', `${slot.slot} 交接到 Mac`);
    if (!previous) handoffButton.addEventListener('click', () => void runControlCommand('handoff', slot.slot));
    return {
      slot, card, retry: card.querySelector('.retry'), updated: card.querySelector('.slot-updated'),
      badge: card.querySelector('.phase-badge'), description: card.querySelector('.phase-description'),
      handoff, handoffButton,
    };
  });
  const currentCards = new Set(slotViews.map((view) => view.card));
  for (const card of [...elements.slots.children]) {
    if (!currentCards.has(card)) card.remove();
  }
  slotViews.forEach(({ card }, index) => {
    const current = elements.slots.children[index];
    if (current !== card) elements.slots.insertBefore(card, current || null);
  });
  elements['empty-state'].hidden = snapshot.slots.length > 0;
  renderEvents();
  updateTimers();
  renderControlActions();
  renderAttention();
}

function renderEvents() {
  const recentEvents = snapshot.recentEvents.slice(0, 30);
  const rows = document.createDocumentFragment();
  for (const event of recentEvents) {
    if (!event || typeof event.label !== 'string') continue;
    const row = document.createElement('li');
    const time = document.createElement('time');
    if (validTime(event.at)) {
      time.dateTime = new Date(event.at).toISOString();
      time.textContent = taipeiTimeWithSeconds.format(event.at);
    } else {
      time.textContent = '—';
    }
    const slot = document.createElement('span');
    slot.className = 'event-slot';
    slot.textContent = typeof event.slot === 'string' ? event.slot : '全部';
    const label = document.createElement('span');
    label.className = 'event-label';
    label.textContent = event.label;
    row.append(time, slot, label);
    rows.append(row);
  }
  elements.events.replaceChildren(rows);
  elements['event-count'].textContent = `${elements.events.childElementCount} 筆`;
  elements['no-events'].hidden = elements.events.childElementCount > 0;
}

function updateTimers() {
  const now = Date.now() + clockOffset;
  for (const { slot, retry, updated, badge, description } of slotViews) {
    const [phase, phaseDescription] = phaseDetails[slot.phase];
    const outdated = dataStale() || snapshot.connection === 'ended';
    badge.textContent = `${outdated ? '最後：' : ''}${phase}`;
    description.textContent = outdated
      ? `最後記錄為「${phase}」。${snapshot.connection === 'ended' ? '本次搶位已結束' : '資料已過期'}，目前狀態請在 Mac 的官方頁面確認。`
      : phaseDescription;
    updated.textContent = elapsedLabel(slot.updatedAt);
    if (dataStale()) {
      retry.textContent = '等待最新進度';
    } else if (snapshot.connection === 'ended') {
      retry.textContent = '最後狀態 · 請在 Mac 確認';
    } else if (['held', 'manual', 'ambiguous', 'handed-off'].includes(slot.phase)) {
      retry.textContent = '請回到 Mac 確認';
    } else if (['failed', 'stopped', 'deadline'].includes(slot.phase)) {
      retry.textContent = '已停止自動查詢';
    } else if (validTime(slot.nextRetryAt)) {
      const seconds = Math.max(0, Math.ceil((slot.nextRetryAt - now) / 1000));
      retry.textContent = seconds > 0 ? `下次查詢：${numberFormatter.format(seconds)} 秒後` : '等待下一次查詢';
    } else if (slot.phase === 'waiting' && validTime(snapshot.run?.monitorFrom)) {
      const seconds = Math.max(0, Math.ceil((snapshot.run.monitorFrom - now) / 1000));
      retry.textContent = seconds > 0 ? `開始查詢：${numberFormatter.format(seconds)} 秒後` : '準備開始查詢';
    } else {
      retry.textContent = slot.phase === 'reserving' ? '正在確認暫留結果' : '即時更新中';
    }
  }
}

class UserMessage extends Error {}

function controlFresh() {
  return authenticated && navigator.onLine && control && Date.now() - controlReceivedAt < 12000;
}

function controlLocked() {
  return Boolean(control?.externalRun || (control?.worker && !control.worker.closed));
}

function settingsReady(settings) {
  return settings && typeof settings.targetDate === 'string' && Array.isArray(settings.slots)
    && settings.slots.length > 0 && settings.slots.length <= 2
    && ['monitorFrom', 'releaseAt', 'monitorUntil'].every((key) => typeof settings[key] === 'string' && Number.isFinite(Date.parse(settings[key])));
}

function taipeiInput(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed + 8 * 3600000).toISOString().slice(0, 19) : '';
}

function defaultSchedule(targetDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null;
  // Treat the Japan boarding date as a calendar date, independent of the device timezone.
  const boardingDate = new Date(`${targetDate}T00:00:00Z`);
  if (!Number.isFinite(boardingDate.getTime()) || boardingDate.toISOString().slice(0, 10) !== targetDate) return null;
  boardingDate.setUTCDate(boardingDate.getUTCDate() - 14);
  const releaseDate = boardingDate.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return null;
  // The configurable frontend default is 07:55 Taipei, with a seven-minute lead.
  const releaseAt = Date.parse(`${releaseDate}T07:55:00+08:00`);
  return {
    monitorFrom: taipeiInput(new Date(releaseAt - 7 * 60000).toISOString()),
    releaseAt: taipeiInput(new Date(releaseAt).toISOString()),
    monitorUntil: taipeiInput(new Date(releaseAt + 130 * 60000).toISOString()),
  };
}

function resetSchedule() {
  if (elements['control-fields'].disabled) return false;
  const schedule = defaultSchedule(elements['setting-date'].value);
  if (!schedule) return false;
  elements['setting-monitor-from'].value = schedule.monitorFrom;
  elements['setting-release-at'].value = schedule.releaseAt;
  elements['setting-monitor-until'].value = schedule.monitorUntil;
  settingsDirty = true;
  controlFeedback('已依乘船日期重新帶入預設時間，可再手動調整。');
  return true;
}

function updateScheduleForDate() {
  const targetDate = elements['setting-date'].value;
  if (targetDate === settingsTargetDate) return false;
  settingsTargetDate = targetDate;
  return resetSchedule();
}

function fillSettings() {
  if (!settingsReady(control?.settings)) return;
  const settings = control.settings;
  elements['setting-date'].value = settings.targetDate;
  settingsTargetDate = elements['setting-date'].value;
  elements['setting-monitor-from'].value = taipeiInput(settings.monitorFrom);
  elements['setting-release-at'].value = taipeiInput(settings.releaseAt);
  elements['setting-monitor-until'].value = taipeiInput(settings.monitorUntil);
  elements['setting-delay'].value = settings.baseDelayMs;
  elements['setting-manual'].checked = settings.manualCustomerForm;
  for (const index of [1, 2]) {
    const selected = settings.slots[index - 1];
    elements[`slot-${index}-enabled`].checked = Boolean(selected);
    elements[`slot-${index}-time`].value = selected?.slot || '';
    const select = elements[`slot-${index}-profile`];
    select.replaceChildren();
    for (const profile of control.profiles || []) {
      if (typeof profile.id !== 'string' || typeof profile.label !== 'string') continue;
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.label;
      select.append(option);
    }
    if (selected) select.value = selected.customerProfile;
    else if (select.options.length > 1) select.selectedIndex = 1;
  }
}

function renderControlActions() {
  const ready = controlFresh() && control.enabled;
  const settingsAvailable = ready && settingsReady(control.settings);
  const busy = commandBusy || control?.busy;
  const locked = controlLocked();
  elements['control-fields'].disabled = !settingsAvailable || busy || locked;
  elements['control-save'].disabled = !settingsAvailable || busy || locked || !settingsDirty;
  elements['control-start'].disabled = !settingsAvailable || busy || locked || settingsDirty;
  elements['setting-schedule-reset'].disabled = !settingsAvailable || busy || locked || !defaultSchedule(elements['setting-date'].value);
  elements['control-stop'].disabled = !ready || busy || !control.worker || control.worker.closed || control.worker.automationStopped || control.externalRun;
  elements['control-close'].disabled = !ready || busy || !control.worker || control.worker.closed || control.externalRun;
  elements['review-settings'].hidden = locked;
  elements['review-settings'].disabled = !settingsAvailable || busy;
  elements['run-actions'].hidden = !locked;
  for (const index of [1, 2]) {
    const selected = elements[`slot-${index}-enabled`].checked;
    elements[`slot-${index}-time`].disabled = !selected;
    elements[`slot-${index}-time`].required = selected;
    elements[`slot-${index}-profile`].disabled = !selected;
    elements[`slot-${index}-profile`].required = selected;
  }
  elements['slot-2-options'].hidden = !elements['slot-2-enabled'].checked;
  elements['slot-2-enabled'].closest('.slot-choice').classList.toggle('is-disabled', !elements['slot-2-enabled'].checked);
  for (const view of slotViews) {
    const workerSlot = control?.worker?.slots.find((slot) => slot.slot === view.slot.slot);
    view.handoff.hidden = !workerSlot || control.worker.closed || control.externalRun || (!workerSlot.canHandoff && !workerSlot.handedOff);
    view.handoffButton.disabled = !ready || busy || !workerSlot?.canHandoff || workerSlot.handedOff;
    view.handoffButton.textContent = workerSlot?.handedOff ? '已交接 · 請在 Mac 繼續' : '交接到 Mac';
  }
}

function renderControl() {
  elements['control-demo'].hidden = !control?.demo;
  let state = '正在取得設定';
  let note = '選好日期與時段，再啟動 Mac 的搶位程式。';
  if (!navigator.onLine) {
    state = '手機離線';
    note = '恢復連線並取得最新狀態後，才能操作搶位程式。';
  } else if (!controlFresh()) {
    state = '控制狀態待更新';
    note = '正在取得 Mac 最新控制狀態，按鈕暫時停用。';
  } else if (!control.enabled) {
    state = '控制尚未就緒';
    note = control.error || '請在 Mac 確認搶位設定，控制功能才能使用。';
  } else if (commandBusy || control.busy) {
    state = '正在處理操作';
  } else if (control.externalRun) {
    state = 'Mac 終端機執行中';
    note = '此程式由 Mac 終端機啟動。請在原終端機接手或結束，再從這裡啟動；日期與時段暫時鎖定。';
  } else if (control.worker && !control.worker.closed) {
    state = control.worker.automationStopped ? '已停止 · 頁面保留' : '搶位程式已啟動';
    note = '本次日期與時段已鎖定。更換目標前，請先結束程式，再修改設定並重新啟動。';
    if (!settingsReady(control.settings)) note += ' 本機設定目前無法讀取，仍可交接、停止或結束這次執行。';
  } else if (!settingsReady(control.settings)) {
    state = '控制尚未就緒';
    note = control.error || '請在 Mac 確認搶位設定，控制功能才能使用。';
  } else {
    state = control.worker?.closed ? '程式已結束' : '準備啟動';
  }
  elements['control-state'].textContent = state;
  elements['control-note'].textContent = note;
  elements['settings-status'].textContent = settingsDirty ? '有未儲存的修改，請先儲存。' : settingsReady(control?.settings) ? '使用 Mac 已儲存的搶位設定' : '等待設定';
  elements['settings-tab-dirty'].hidden = !settingsDirty;
  const schedule = ['setting-monitor-from', 'setting-release-at', 'setting-monitor-until'].map((id) => {
    const value = elements[id].value;
    return value ? readableTime(Date.parse(`${value}+08:00`), true).replace('\n', ' ') : '—';
  });
  elements['schedule-summary'].textContent = schedule.join(' → ');
  renderControlActions();
  renderOverview();
  renderAttention();
}

async function refreshControl() {
  if (!authenticated || !navigator.onLine) { renderControl(); return false; }
  if (controlRequest) return controlRequest;
  const epoch = controlEpoch;
  controlRequest = (async () => {
    try {
      const response = await api('/api/control');
      if (!authenticated || epoch !== controlEpoch) return false;
      if (response.status === 401) { showLogin('登入已到期，請重新輸入監控密碼。', true); return false; }
      if (!response.ok) throw new Error('Control unavailable');
      const value = await response.json();
      if (!authenticated || epoch !== controlEpoch) return false;
      if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.profiles)) throw new Error('Invalid control state');
      control = value;
      controlReceivedAt = Date.now();
      if (!settingsDirty) fillSettings();
      renderControl();
      return true;
    } catch {
      if (epoch !== controlEpoch) return false;
      controlReceivedAt = 0;
      renderControl();
      return false;
    } finally {
      if (epoch === controlEpoch) controlRequest = null;
    }
  })();
  return controlRequest;
}

function controlFeedback(message, ok = false) {
  elements['control-feedback'].textContent = message;
  elements['control-feedback'].hidden = !message;
  elements['control-feedback'].classList.toggle('control-feedback-ok', ok);
}

function readSettings() {
  const slots = [1, 2].filter((index) => elements[`slot-${index}-enabled`].checked).map((index) => ({
    slot: elements[`slot-${index}-time`].value,
    customerProfile: elements[`slot-${index}-profile`].value,
  }));
  if (!slots.length) throw new UserMessage('請至少勾選一個乘船時段。');
  if (new Set(slots.map((slot) => slot.slot)).size !== slots.length) throw new UserMessage('兩個時段不能相同；只搶一個時段時，請只勾一列。');
  return {
    targetDate: elements['setting-date'].value,
    monitorFrom: `${elements['setting-monitor-from'].value}+08:00`,
    releaseAt: `${elements['setting-release-at'].value}+08:00`,
    monitorUntil: `${elements['setting-monitor-until'].value}+08:00`,
    baseDelayMs: Number(elements['setting-delay'].value),
    manualCustomerForm: elements['setting-manual'].checked,
    slots,
  };
}

function sameSettings(left, right) {
  return left && right && left.targetDate === right.targetDate && left.baseDelayMs === right.baseDelayMs
    && left.manualCustomerForm === right.manualCustomerForm && JSON.stringify(left.slots) === JSON.stringify(right.slots)
    && ['monitorFrom', 'releaseAt', 'monitorUntil'].every((key) => Date.parse(left[key]) === Date.parse(right[key]));
}

async function runControlCommand(command, slot, confirmedRunId) {
  if (commandBusy || !controlFresh()) return;
  const epoch = controlEpoch;
  const expectedRunId = command === 'close' ? confirmedRunId : control.worker?.runId;
  const expectedSettings = control.settings;
  let settings;
  if (command === 'settings') {
    if (!elements['control-form'].reportValidity()) return;
    try { settings = readSettings(); } catch (error) { controlFeedback(error.message); return; }
  }
  commandBusy = true;
  controlFeedback('正在確認 Mac 最新狀態…');
  renderControl();
  try {
    if (!await refreshControl() || !controlFresh()) throw new UserMessage('無法取得最新控制狀態，請恢復連線後再試。');
    if (!authenticated || epoch !== controlEpoch) return;
    if (!control.enabled || control.busy || control.externalRun) throw new UserMessage(control.error || 'Mac 目前無法接受這項操作，請確認最新狀態。');
    if (['settings', 'start'].includes(command) && controlLocked()) throw new UserMessage('搶位程式已啟動；請先結束程式，再變更設定。');
    if (command === 'start' && (settingsDirty || !sameSettings(expectedSettings, control.settings))) throw new UserMessage('搶位設定已變更，請確認畫面上的設定，再按開始搶位。');
    if (['stop', 'close', 'handoff'].includes(command)) {
      if (!expectedRunId || control.worker?.runId !== expectedRunId || control.worker.closed) throw new UserMessage('本次執行狀態已變更，請確認最新狀態後再操作。');
      if (command === 'stop' && control.worker.automationStopped) throw new UserMessage('搶位已停止，頁面仍保留在 Mac。');
      if (command === 'handoff' && !control.worker.slots.some((item) => item.slot === slot && item.canHandoff && !item.handedOff)) throw new UserMessage('這個時段目前無法交接，請確認 Mac 的最新狀態。');
    }
    const payload = command === 'settings' ? settings : command === 'start' ? { confirmed: true, settings: control.settings } : command === 'handoff' ? { runId: expectedRunId, slot } : { runId: expectedRunId };
    const response = await api(`/api/control/${command}`, { method: 'POST', body: JSON.stringify(payload) });
    if (!authenticated || epoch !== controlEpoch) return;
    if (response.status === 401) { showLogin('登入已到期，請重新輸入監控密碼。', true); return; }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new UserMessage(typeof failure.error === 'string' ? failure.error.slice(0, 400) : '操作未完成，請確認 Mac 狀態後再試。');
    }
    if (command === 'settings') settingsDirty = false;
    if (!await refreshControl()) throw new UserMessage('操作已送出，但尚未取得確認狀態。請重新連線，確認 Mac 的結果。');
    if (!authenticated || epoch !== controlEpoch) return;
    const verified = command === 'settings' ? sameSettings(settings, control.settings)
      : command === 'start' ? Boolean(control.worker && !control.worker.closed && control.worker.runId !== expectedRunId)
        : command === 'close' ? !control.worker || (control.worker.runId === expectedRunId && control.worker.closed)
          : command === 'stop' ? control.worker?.runId === expectedRunId && control.worker.automationStopped
            : control.worker?.runId === expectedRunId && control.worker.slots.some((item) => item.slot === slot && item.handedOff);
    if (!verified) throw new UserMessage('操作已送出，但 Mac 尚未確認完成。請查看最新狀態或到 Mac 確認。');
    if (command === 'start') selectDashboardPanel('progress', true, true);
    const messages = {
      settings: '設定已儲存。確認後即可開始搶位。',
      start: 'Mac 搶位程式已啟動，各時段進度會自動更新。',
      stop: '已停止自動搶位，預約頁面保留在 Mac。',
      close: '程式與預約瀏覽器已結束，控制台仍可使用。',
      handoff: `${slot} 已交接。請在 Mac 原本的瀏覽器填單、確認及付款；另一時段會依原設定繼續。`,
    };
    if (epoch === controlEpoch) controlFeedback(`${control.demo ? '演示：' : ''}${messages[command]}`, true);
  } catch (error) {
    if (epoch === controlEpoch) controlFeedback(error instanceof UserMessage ? error.message : '無法連到 Mac，操作結果尚未確認。請重新連線後查看。');
    await refreshControl();
  } finally {
    if (epoch === controlEpoch) { commandBusy = false; renderControl(); }
  }
}

function pushSupported() {
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && (!iphone || standalone);
}

function renderPush() {
  const supported = pushSupported();
  elements['push-enable'].hidden = Boolean(pushSubscription);
  elements['push-enable'].disabled = !authenticated || pushBusy || !navigator.onLine || !supported || !pushConfig?.available || window.Notification.permission === 'denied';
  elements['push-test'].hidden = !pushSubscription;
  elements['push-disable'].hidden = !pushSubscription;
  elements['push-test'].disabled = pushBusy || !navigator.onLine || !pushConfig?.available;
  elements['push-disable'].disabled = pushBusy || !navigator.onLine;
  let copy = '官方確認暫留後提醒你回到 Mac 接手確認、填單及付款。';
  if (!supported) copy = 'iPhone 需使用 iOS 16.4 以上：在 Safari「分享 → 加入主畫面」，再從主畫面開啟此 PWA 並啟用通知。';
  else if (window.Notification.permission === 'denied') copy = '通知權限已關閉。請到裝置設定允許此 PWA 通知，再重新開啟。';
  else if (pushSubscription) copy = '這台裝置已啟用通知。官方確認暫留後，會提醒你回到 Mac 確認、填單及付款。';
  else if (pushConfig && !pushConfig.available) copy = 'Mac 的推播服務尚未就緒，請在 Mac 完成通知設定後再啟用。';
  if (pushNeedsRenew) copy = 'Mac 通知金鑰已更新，請按「啟用通知」重新登記這台裝置。';
  else if (pushSyncError) copy = '這台裝置尚未成功登記到 Mac，請按「啟用通知」重試。';
  if (control?.demo) copy += ' 演示模式不發送真實推播。';
  elements['push-copy'].textContent = copy;
}

async function refreshPush() {
  if (!authenticated || !navigator.onLine) { renderPush(); return; }
  const epoch = controlEpoch;
  try {
    const response = await api('/api/push');
    if (response.status === 401 || !response.ok) return;
    const value = await response.json();
    if (!authenticated || epoch !== controlEpoch) return;
    pushConfig = value;
    if (pushSupported()) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!authenticated || epoch !== controlEpoch) return;
      pushNeedsRenew = Boolean(subscription && pushConfig.available && !matchingPushKey(subscription, pushConfig.publicKey));
      pushSubscription = null;
      pushSyncError = false;
      if (subscription && pushConfig.available && !pushNeedsRenew && window.Notification.permission === 'granted') {
        // An existing browser subscription alone does not prove the Mac has it.
        const registered = await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
        if (!authenticated || epoch !== controlEpoch) return;
        if (registered.ok) pushSubscription = subscription;
        else pushSyncError = true;
      }
    }
  } catch {
    if (epoch === controlEpoch) { pushSubscription = null; pushSyncError = true; }
  } finally {
    if (epoch === controlEpoch) renderPush();
  }
}

function decodePushKey(value) {
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = window.atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function matchingPushKey(subscription, publicKey) {
  if (typeof publicKey !== 'string' || !subscription.options?.applicationServerKey) return false;
  try {
    const existing = new Uint8Array(subscription.options.applicationServerKey);
    const expected = decodePushKey(publicKey);
    return existing.length === expected.length && existing.every((value, index) => value === expected[index]);
  } catch { return false; }
}

async function runPushCommand(command) {
  if (pushBusy || !authenticated || !navigator.onLine || !pushSupported()) return;
  const epoch = controlEpoch;
  // Permission is requested directly from the user's button gesture.
  const permission = command === 'subscribe' && window.Notification.permission === 'default' ? window.Notification.requestPermission() : Promise.resolve(window.Notification.permission);
  pushBusy = true;
  elements['push-feedback'].textContent = '正在處理通知設定…';
  renderPush();
  let createdSubscription = null;
  try {
    if (command === 'subscribe' && await permission !== 'granted') throw new UserMessage('尚未允許通知。你可以稍後再按「啟用通知」。');
    const registration = await navigator.serviceWorker.ready;
    if (!authenticated || epoch !== controlEpoch) return;
    let subscription = await registration.pushManager.getSubscription();
    if (command === 'subscribe') {
      await refreshPush();
      if (!authenticated || epoch !== controlEpoch) return;
      if (!pushConfig?.available || typeof pushConfig.publicKey !== 'string') throw new UserMessage('Mac 推播服務尚未就緒，請稍後再試。');
      if (subscription && !matchingPushKey(subscription, pushConfig.publicKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePushKey(pushConfig.publicKey) });
        createdSubscription = subscription;
      }
    }
    if (!authenticated || epoch !== controlEpoch) return;
    if (!subscription) throw new UserMessage('這台裝置尚未啟用通知，請先按「啟用通知」。');
    const payload = command === 'subscribe' ? { subscription: subscription.toJSON() } : { endpoint: subscription.endpoint };
    const response = await api(`/api/push/${command}`, { method: 'POST', body: JSON.stringify(payload) });
    if (!authenticated || epoch !== controlEpoch) return;
    if (response.status === 401) { showLogin('登入已到期，請重新輸入監控密碼。', true); return; }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (command === 'test' && response.status === 410) {
        await subscription.unsubscribe().catch(() => {});
        pushSubscription = null;
        pushNeedsRenew = false;
        pushSyncError = true;
      }
      throw new UserMessage(typeof failure.error === 'string' ? failure.error.slice(0, 400) : '通知操作未完成，請稍後再試。');
    }
    createdSubscription = null;
    pushNeedsRenew = false;
    pushSyncError = false;
    if (command === 'unsubscribe') { await subscription.unsubscribe(); pushSubscription = null; }
    else pushSubscription = subscription;
    elements['push-feedback'].textContent = command === 'subscribe' ? '已啟用這台裝置的通知。可按「測試通知」確認。' : command === 'unsubscribe' ? '已停用這台裝置的通知。' : '測試通知已送出，請確認手機是否收到。';
  } catch (error) {
    if (createdSubscription) await createdSubscription.unsubscribe().catch(() => {});
    if (epoch === controlEpoch) elements['push-feedback'].textContent = error instanceof UserMessage ? error.message : '無法更新通知設定，請稍後再試。';
  } finally {
    if (createdSubscription && epoch !== controlEpoch) await createdSubscription.unsubscribe().catch(() => {});
    if (epoch === controlEpoch) { pushBusy = false; renderPush(); }
  }
}

function scheduleReconnect() {
  if (!authenticated || reconnectTimer !== null || !navigator.onLine) return;
  const currentGeneration = generation;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (currentGeneration === generation) void connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

async function connect() {
  if (!authenticated || connecting || !navigator.onLine) {
    updateConnection();
    return;
  }
  stopConnection();
  connecting = true;
  const currentGeneration = generation;
  try {
    const response = await api('/api/status');
    if (currentGeneration !== generation) return;
    if (response.status === 401) {
      showLogin('登入已到期，請重新輸入監控密碼。', true);
      return;
    }
    if (!response.ok) throw new Error('Status unavailable');
    const value = await response.json();
    if (currentGeneration !== generation) return;
    receiveSnapshot(value);
    eventSource = new EventSource('/api/events');
    eventSource.addEventListener('unauthenticated', () => {
      if (currentGeneration === generation) showLogin('登入已到期，請重新輸入監控密碼。', true);
    });
    eventSource.addEventListener('status', (event) => {
      if (currentGeneration !== generation) return;
      try {
        receiveSnapshot(JSON.parse(event.data));
      } catch {
        eventSource?.close();
        eventSource = null;
        scheduleReconnect();
      }
    });
    eventSource.onerror = () => {
      if (currentGeneration !== generation) return;
      eventSource?.close();
      eventSource = null;
      scheduleReconnect();
      updateConnection();
    };
  } catch {
    if (currentGeneration !== generation) return;
    scheduleReconnect();
    updateConnection();
  } finally {
    if (currentGeneration === generation) connecting = false;
  }
}

async function checkSession() {
  if (elements['login-submit'].disabled) return;
  const authVersion = ++authGeneration;
  if (pendingLogout) {
    try {
      const response = await api('/api/logout', { method: 'POST', body: '{}' });
      if (authVersion !== authGeneration) return;
      if (!response.ok) throw new Error('Logout unavailable');
      pendingLogout = false;
      showLogin('已登出。');
    } catch {
      if (authVersion !== authGeneration) return;
      showLogin('尚未完成登出，請恢復連線。恢復後會自動完成登出。');
    }
    return;
  }
  try {
    const response = await api('/api/session');
    if (authVersion !== authGeneration) return;
    if (!response.ok) throw new Error('Session unavailable');
    const session = await response.json();
    if (authVersion !== authGeneration) return;
    if (session.authenticated === true) {
      showStatus();
      await connect();
    } else {
      showLogin();
    }
  } catch {
    if (authVersion !== authGeneration) return;
    if (authenticated) updateConnection();
    else showLogin(navigator.onLine ? '暫時無法連到 Mac，請稍候再試。' : '手機目前離線。連線恢復後即可登入查看進度。');
  }
}

elements['login-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (elements['login-submit'].disabled) return;
  const authVersion = ++authGeneration;
  elements['login-submit'].disabled = true;
  elements['login-submit'].textContent = '正在登入…';
  setLoginFeedback('');
  try {
    const response = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: elements.password.value }) });
    if (authVersion !== authGeneration) return;
    elements.password.value = '';
    if (response.status === 429) {
      setLoginFeedback('嘗試次數較多，請稍候再登入。', true);
    } else if (response.status === 401) {
      setLoginFeedback('無法登入，請確認監控密碼。', true);
      elements.password.focus();
    } else if (!response.ok) {
      setLoginFeedback('暫時無法登入，請稍候再試。');
    } else {
      const session = await response.json();
      if (authVersion !== authGeneration) return;
      if (session.authenticated !== true) throw new Error('Session unavailable');
      pendingLogout = false;
      showStatus();
      document.getElementById('main').focus();
      await connect();
    }
  } catch {
    if (authVersion !== authGeneration) return;
    elements.password.value = '';
    setLoginFeedback(navigator.onLine ? '無法連到 Mac，請確認監控服務與網路連線。' : '手機目前離線，請恢復連線後再登入。');
  } finally {
    elements['login-submit'].disabled = false;
    elements['login-submit'].textContent = '查看進度 →';
  }
});

elements.logout.addEventListener('click', async () => {
  pendingLogout = true;
  showLogin('正在登出…');
  await checkSession();
});

elements.refresh.addEventListener('click', () => {
  reconnectDelay = 1500;
  void connect();
  void refreshControl();
  void refreshPush();
});

for (const name of ['progress', 'settings']) {
  elements[`${name}-tab`].addEventListener('click', () => selectDashboardPanel(name));
  elements[`${name}-tab`].addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'progress' : event.key === 'End' ? 'settings' : name === 'progress' ? 'settings' : 'progress';
    selectDashboardPanel(next, true, true);
  });
}
elements['review-settings'].addEventListener('click', () => selectDashboardPanel('settings', true, true));
elements['attention-open'].addEventListener('click', () => selectDashboardPanel('progress', true, true));

elements['control-form'].addEventListener('invalid', (event) => {
  let details = event.target.closest('details');
  while (details) {
    details.open = true;
    details = details.parentElement.closest('details');
  }
  controlFeedback('請檢查標示的欄位，填妥後再儲存設定。');
}, true);
elements['control-form'].addEventListener('input', (event) => {
  settingsDirty = true;
  if (event.target !== elements['setting-date'] || !updateScheduleForDate()) controlFeedback('');
  renderControl();
});
elements['control-form'].addEventListener('change', (event) => {
  settingsDirty = true;
  if (event.target === elements['setting-date']) updateScheduleForDate();
  renderControl();
});
elements['setting-schedule-reset'].addEventListener('click', () => {
  if (resetSchedule()) renderControl();
});
elements['control-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  void runControlCommand('settings');
});
elements['control-start'].addEventListener('click', () => void runControlCommand('start'));
elements['control-stop'].addEventListener('click', () => void runControlCommand('stop'));
elements['control-close'].addEventListener('click', () => {
  if (elements['control-close'].disabled || !controlFresh() || elements['close-dialog'].open) return;
  pendingCloseRunId = control.worker?.runId || null;
  if (!pendingCloseRunId) return;
  const held = control.worker.slots.filter((slot) => slot.holdConfirmed).map((slot) => slot.slot);
  elements['close-copy'].textContent = `${held.length ? `${held.join('、')} 已暫留。` : ''}Mac 的預約瀏覽器會關閉。請先確認原頁面與船位；關閉瀏覽器不代表立即取消暫留船位。結束後才能修改設定或重新啟動。`;
  elements['close-dialog'].showModal();
});
elements['close-cancel'].addEventListener('click', () => elements['close-dialog'].close());
elements['close-dialog'].addEventListener('close', () => { pendingCloseRunId = null; });
elements['close-confirm'].addEventListener('click', () => {
  const runId = pendingCloseRunId;
  elements['close-dialog'].close();
  pendingCloseRunId = null;
  if (!runId) return;
  if (!controlFresh()) { controlFeedback('控制狀態已過期，請重新連線並確認本次執行後再結束。'); return; }
  void runControlCommand('close', undefined, runId);
});
elements['push-enable'].addEventListener('click', () => void runPushCommand('subscribe'));
elements['push-test'].addEventListener('click', () => void runPushCommand('test'));
elements['push-disable'].addEventListener('click', () => void runPushCommand('unsubscribe'));

window.addEventListener('offline', () => {
  stopConnection();
  if (authenticated) updateConnection();
  else setLoginFeedback('手機目前離線，請恢復連線後再登入。');
  renderControl();
  renderPush();
});
window.addEventListener('online', () => {
  if (authenticated) { void connect(); void refreshControl(); void refreshPush(); }
  else void checkSession();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (authenticated) { void connect(); void refreshControl(); void refreshPush(); }
  else void checkSession();
});
window.setInterval(updateConnection, 1000);
window.setInterval(() => { if (authenticated && document.visibilityState === 'visible') void refreshControl(); }, 3000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Live monitoring remains usable when shell caching is unavailable.
  });
}
void checkSession();

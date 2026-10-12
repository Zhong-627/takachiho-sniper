const elements = Object.fromEntries([
  'login-view', 'status-view', 'login-form', 'password', 'login-feedback',
  'login-submit', 'logout', 'refresh', 'connection-banner', 'connection-title',
  'connection-copy', 'last-received', 'target-date', 'run-mode', 'monitor-from',
  'release-at', 'monitor-until', 'slots', 'slot-template', 'empty-state',
  'events', 'event-count', 'no-events', 'demo-badge',
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
  snapshot = null;
  lastReceivedAt = 0;
  slotViews = [];
  elements.slots.replaceChildren();
  elements.events.replaceChildren();
  elements['status-view'].hidden = true;
  elements['login-view'].hidden = false;
  elements.logout.hidden = true;
  elements.password.value = '';
  setLoginFeedback(message);
  if (focus) elements.password.focus();
}

function showStatus() {
  authenticated = true;
  elements['login-view'].hidden = true;
  elements['status-view'].hidden = false;
  elements.logout.hidden = false;
  elements.password.value = '';
  updateConnection();
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
}

function renderSnapshot() {
  const run = snapshot.run;
  if (run && typeof run.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(run.targetDate)) {
    const parsed = Date.parse(`${run.targetDate}T00:00:00+09:00`);
    elements['target-date'].textContent = Number.isFinite(parsed) ? dateFormatter.format(parsed) : '日期待確認';
    elements['run-mode'].textContent = `${run.targetDate.slice(0, 4)} 年 · ${snapshot.connection === 'ended' ? '本次執行已結束' : '自動搶位進度'}`;
    elements['monitor-from'].textContent = readableTime(run.monitorFrom, true);
    elements['release-at'].textContent = readableTime(run.releaseAt, true);
    elements['monitor-until'].textContent = readableTime(run.monitorUntil, true);
  } else {
    elements['target-date'].textContent = '等待搶位程式';
    elements['run-mode'].textContent = '尚未收到執行資訊';
    ['monitor-from', 'release-at', 'monitor-until'].forEach((id) => { elements[id].textContent = '—'; });
  }
  elements['demo-badge'].hidden = run?.id !== 'demo';
  const cards = document.createDocumentFragment();
  slotViews = snapshot.slots.slice(0, 10).map((slot) => {
    const card = elements['slot-template'].content.firstElementChild.cloneNode(true);
    const [phase, description, tone] = phaseDetails[slot.phase];
    card.dataset.phase = slot.phase;
    card.querySelector('.slot-time').textContent = slot.slot;
    card.querySelector('.phase-badge').textContent = phase;
    card.querySelector('.phase-badge').className = `phase-badge ${tone}`.trim();
    card.querySelector('.phase-description').textContent = description;
    card.querySelector('.attempts').textContent = Number.isFinite(slot.attempts) && slot.attempts >= 0 ? numberFormatter.format(slot.attempts) : '—';
    card.querySelector('.availability').textContent = Object.hasOwn(availabilityLabels, slot.availability) ? availabilityLabels[slot.availability] : '尚未查詢';
    card.querySelector('.response').textContent = typeof slot.responseMs === 'number' && Number.isFinite(slot.responseMs) && slot.responseMs >= 0 ? `${numberFormatter.format(Math.round(slot.responseMs))} ms` : '—';
    cards.append(card);
    return {
      slot, retry: card.querySelector('.retry'), updated: card.querySelector('.slot-updated'),
      badge: card.querySelector('.phase-badge'), description: card.querySelector('.phase-description'),
    };
  });
  elements.slots.replaceChildren(cards);
  elements['empty-state'].hidden = snapshot.slots.length > 0;
  renderEvents();
  updateTimers();
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
});

window.addEventListener('offline', () => {
  stopConnection();
  if (authenticated) updateConnection();
  else setLoginFeedback('手機目前離線，請恢復連線後再登入。');
});
window.addEventListener('online', () => {
  if (authenticated) void connect();
  else void checkSession();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (authenticated) void connect();
  else void checkSession();
});
window.setInterval(updateConnection, 1000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Live monitoring remains usable when shell caching is unavailable.
  });
}
void checkSession();

// ===================== Identity generation =====================
const ADJECTIVES = ['Swift','Calm','Bright','Gentle','Bold','Quiet','Sunny','Lucky','Clever','Merry','Cosmic','Amber','Velvet','Golden','Silver','Quick','Brave','Witty','Breezy','Mellow','Sharp','Jolly','Nimble','Frosty','Radiant'];
const ANIMALS = ['Falcon','Otter','Panda','Fox','Heron','Lynx','Sparrow','Dolphin','Koala','Tiger','Rabbit','Wolf','Owl','Panther','Robin','Badger','Whale','Hawk','Seal','Deer','Raven','Puma','Finch','Bison','Marten'];
const AVATAR_COLORS = ['#F08C4B','#4FB0A5','#7C83FD','#E85D75','#3CA6A6','#F2B84B','#8D6AE0','#4E9BF5','#F76C5E','#5CC29E'];

function generateRandomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a} ${n} ${num}`;
}

function colorForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function generateClientId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ===================== State =====================
const state = {
  clientId: null,
  name: '',
  avatarColor: '',
  socket: null,
  selfId: null,
  currentScreen: 'setup',

  onlineUsers: new Map(), // id -> { name, avatarColor, online, lastMessage, lastMessageFromMe, lastActivity, unread }
  activeChatId: null,
  chatCache: new Map(),   // id -> [{id, from, text, ts, system}]
  myTypingTimeout: null,

  groupSelectMode: false,
  selectedIds: new Set(),

  currentRoomId: null,
  currentCallType: null,  // 'audio' | 'video'
  isCaller: false,
  chatLogTargetId: null,  // other person's id, only set for direct 1:1 calls (for call-log chat entries)
  pendingTargetIds: [],
  incomingCall: null,     // { roomId, from, callType, groupSize }
  outgoingTimeout: null,
  incomingTimeout: null,

  localStream: null,
  peers: new Map(),       // socketId -> { pc, name, tileEl }
  localTileEl: null,
  micOn: true,
  camOn: true,
  speakerMuted: false,
  facingMode: 'user',
  callStartedAt: null,
  callTimerInterval: null,
  qualityInterval: null,
};

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ===================== DOM / small utilities =====================
const el = (id) => document.getElementById(id);

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function formatClockTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
}

const screens = ['setup', 'home', 'chat', 'outgoing', 'incoming', 'call', 'ended'];
function showScreen(name) {
  screens.forEach((s) => el(`screen-${s}`).classList.toggle('active', s === name));
  state.currentScreen = name;
}

let toastTimeout = null;
function showToast(msg, duration = 3200) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), duration);
}

// ===================== Sound (WebAudio — no external assets) =====================
let audioCtx = null;
function getAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* audio unsupported — fine, sounds just won't play */ }
  return audioCtx;
}
function playTone(freq, duration, delay = 0, gainVal = 0.05) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = gainVal;
    osc.connect(gain).connect(ctx.destination);
    const startAt = ctx.currentTime + delay;
    osc.start(startAt);
    osc.stop(startAt + duration);
  } catch (e) { /* ignore — non-critical */ }
}
function playMessagePop() {
  playTone(880, 0.08, 0, 0.04);
  playTone(1320, 0.08, 0.06, 0.03);
}
let ringtoneInterval = null;
function startRingtone() {
  stopRingtone();
  const ring = () => { playTone(480, 0.35, 0, 0.05); playTone(600, 0.35, 0.4, 0.05); };
  ring();
  ringtoneInterval = setInterval(ring, 1600);
}
function stopRingtone() {
  if (ringtoneInterval) { clearInterval(ringtoneInterval); ringtoneInterval = null; }
}

// ===================== Identity bootstrap =====================
function loadIdentity() {
  let clientId = localStorage.getItem('vc_clientId');
  let name = localStorage.getItem('vc_name');
  if (!clientId) {
    clientId = generateClientId();
    localStorage.setItem('vc_clientId', clientId);
  }
  if (!name) {
    name = generateRandomName();
    localStorage.setItem('vc_name', name);
  }
  state.clientId = clientId;
  state.name = name;
  state.avatarColor = colorForId(clientId);
}
loadIdentity();

function renderSetupScreen() {
  el('input-name').value = state.name;
  const preview = el('setup-avatar-preview');
  preview.textContent = initials(state.name);
  preview.style.background = state.avatarColor;
}
renderSetupScreen();

el('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-join').click(); });

el('btn-join').addEventListener('click', () => {
  getAudioCtx(); // warm up audio on a real user gesture so later ringtones aren't blocked
  const name = el('input-name').value.trim();
  if (!name) { el('setup-error').textContent = 'Enter a name to continue.'; return; }
  state.name = name;
  localStorage.setItem('vc_name', name);
  el('setup-error').textContent = '';
  renderHomeHeader();
  connectSocket();
  showScreen('home');
});

// ===================== Home screen =====================
function renderHomeHeader() {
  el('home-my-name').textContent = state.name;
  const av = el('home-my-avatar');
  av.textContent = initials(state.name);
  av.style.background = state.avatarColor;
}

function upsertOnlineUser(u, isOnline) {
  const existing = state.onlineUsers.get(u.id) || {};
  state.onlineUsers.set(u.id, { ...existing, name: u.name, avatarColor: u.avatarColor, online: isOnline });
}

function renderOnlineList() {
  const container = el('online-list');
  container.innerHTML = '';

  const entries = [...state.onlineUsers.entries()];
  entries.sort((a, b) => {
    const ua = a[1], ub = b[1];
    if ((ub.unread ? 1 : 0) !== (ua.unread ? 1 : 0)) return (ub.unread || 0) - (ua.unread || 0);
    const ta = ua.lastActivity || 0, tb = ub.lastActivity || 0;
    if (tb !== ta) return tb - ta;
    if (ua.online !== ub.online) return ua.online ? -1 : 1;
    return (ua.name || '').localeCompare(ub.name || '');
  });

  entries.forEach(([id, u]) => container.appendChild(buildUserRow(id, u)));
  el('home-empty').classList.toggle('show', entries.length === 0);
}

function buildUserRow(id, u) {
  const row = document.createElement('div');
  row.className = 'user-row' + (state.selectedIds.has(id) ? ' selected' : '');
  row.dataset.userId = id;

  const checkbox = document.createElement('div');
  checkbox.className = 'user-row-checkbox';
  checkbox.textContent = state.selectedIds.has(id) ? '✓' : '';

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'user-row-avatar-wrap';
  const avatar = document.createElement('div');
  avatar.className = 'avatar-circle sm';
  avatar.textContent = initials(u.name);
  avatar.style.background = u.avatarColor || '';
  const dot = document.createElement('div');
  dot.className = 'presence-dot' + (u.online ? ' online' : '');
  avatarWrap.append(avatar, dot);

  const main = document.createElement('div');
  main.className = 'user-row-main';
  const nameEl = document.createElement('div');
  nameEl.className = 'user-row-name';
  nameEl.textContent = u.name;
  const subEl = document.createElement('div');
  subEl.className = 'user-row-sub';
  subEl.textContent = u.lastMessage ? (u.lastMessageFromMe ? `You: ${u.lastMessage}` : u.lastMessage) : (u.online ? 'Online' : 'Offline');
  main.append(nameEl, subEl);

  const meta = document.createElement('div');
  meta.className = 'user-row-meta';
  if (u.lastActivity) {
    const timeEl = document.createElement('div');
    timeEl.className = 'user-row-time';
    timeEl.textContent = formatClockTime(u.lastActivity);
    meta.appendChild(timeEl);
  }
  if (u.unread) {
    const badge = document.createElement('div');
    badge.className = 'unread-badge';
    badge.textContent = String(u.unread);
    meta.appendChild(badge);
  }

  row.append(checkbox, avatarWrap, main, meta);
  row.addEventListener('click', () => {
    if (state.groupSelectMode) toggleSelectUser(id);
    else openChat(id);
  });
  return row;
}

el('btn-group-mode').addEventListener('click', () => {
  state.groupSelectMode = true;
  state.selectedIds.clear();
  el('group-select-bar').classList.add('show');
  updateGroupSelectBar();
  renderOnlineList();
});
el('btn-group-cancel').addEventListener('click', exitGroupSelectMode);
function exitGroupSelectMode() {
  state.groupSelectMode = false;
  state.selectedIds.clear();
  el('group-select-bar').classList.remove('show');
  renderOnlineList();
}
function toggleSelectUser(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  updateGroupSelectBar();
  renderOnlineList();
}
function updateGroupSelectBar() {
  const n = state.selectedIds.size;
  el('group-select-count').textContent = `${n} selected`;
  el('btn-group-audio').disabled = n === 0;
  el('btn-group-video').disabled = n === 0;
}
el('btn-group-audio').addEventListener('click', () => {
  const ids = [...state.selectedIds];
  exitGroupSelectMode();
  startCall(ids, 'audio');
});
el('btn-group-video').addEventListener('click', () => {
  const ids = [...state.selectedIds];
  exitGroupSelectMode();
  startCall(ids, 'video');
});

el('btn-edit-name').addEventListener('click', () => {
  el('input-edit-name').value = state.name;
  el('edit-name-row').classList.add('show');
  el('input-edit-name').focus();
});
el('input-edit-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-save-name').click(); });
el('btn-save-name').addEventListener('click', () => {
  const newName = el('input-edit-name').value.trim();
  if (!newName) return;
  state.name = newName;
  localStorage.setItem('vc_name', newName);
  el('edit-name-row').classList.remove('show');
  renderHomeHeader();
  if (state.socket) state.socket.emit('update-profile', { name: newName });
});

// ===================== Chat screen =====================
function openChat(id) {
  state.activeChatId = id;
  const u = state.onlineUsers.get(id);
  if (!u) return;

  el('chat-header-avatar').textContent = initials(u.name);
  el('chat-header-avatar').style.background = u.avatarColor || '';
  el('chat-header-name').textContent = u.name;
  updateChatHeaderStatus();

  if (u.unread) { u.unread = 0; renderOnlineList(); }

  el('typing-indicator').classList.remove('show');
  el('chat-input').value = '';
  el('chat-messages').innerHTML = '';
  if (state.chatCache.has(id)) renderChatMessages(id);
  state.socket.emit('get-history', { withId: id });

  showScreen('chat');
}

function updateChatHeaderStatus() {
  const u = state.onlineUsers.get(state.activeChatId);
  el('chat-header-status').textContent = u?.online ? 'Online' : 'Offline';
  el('btn-chat-audio-call').disabled = !u?.online;
  el('btn-chat-video-call').disabled = !u?.online;
}

el('btn-chat-back').addEventListener('click', () => {
  state.activeChatId = null;
  showScreen('home');
});
el('btn-chat-audio-call').addEventListener('click', () => { if (state.activeChatId) startCall([state.activeChatId], 'audio'); });
el('btn-chat-video-call').addEventListener('click', () => { if (state.activeChatId) startCall([state.activeChatId], 'video'); });

function renderChatMessages(id) {
  const container = el('chat-messages');
  container.innerHTML = '';
  (state.chatCache.get(id) || []).forEach((m) => container.appendChild(buildMessageBubble(m)));
  container.scrollTop = container.scrollHeight;
}

function buildMessageBubble(m) {
  const div = document.createElement('div');
  if (m.system) {
    div.className = 'msg msg-system';
    div.textContent = m.text;
    return div;
  }
  const mine = m.from === state.clientId;
  div.className = 'msg ' + (mine ? 'msg-out' : 'msg-in');
  const textSpan = document.createElement('span');
  textSpan.textContent = m.text;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-time';
  timeSpan.textContent = formatClockTime(m.ts);
  div.append(textSpan, timeSpan);
  return div;
}

function appendMessageToCache(id, msg) {
  if (!state.chatCache.has(id)) state.chatCache.set(id, []);
  state.chatCache.get(id).push(msg);
}

function touchLastMessage(id, text, fromMe, ts) {
  const u = state.onlineUsers.get(id);
  if (!u) return;
  u.lastMessage = text;
  u.lastMessageFromMe = fromMe;
  u.lastActivity = ts || Date.now();
}

function sendChatMessage() {
  const input = el('chat-input');
  const text = input.value.trim();
  if (!text || !state.activeChatId) return;
  const targetId = state.activeChatId;

  state.socket.emit('chat-message', { to: targetId, text });
  const localMsg = { id: 'local-' + Date.now(), from: state.clientId, text, ts: Date.now() };
  appendMessageToCache(targetId, localMsg);
  touchLastMessage(targetId, text, true, localMsg.ts);
  renderChatMessages(targetId);
  renderOnlineList();

  input.value = '';
  stopTypingSignal();
}
el('btn-send-message').addEventListener('click', sendChatMessage);
el('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); } });
el('chat-input').addEventListener('input', () => {
  if (!state.activeChatId) return;
  state.socket.emit('typing', { to: state.activeChatId, isTyping: true });
  clearTimeout(state.myTypingTimeout);
  state.myTypingTimeout = setTimeout(stopTypingSignal, 2000);
});
function stopTypingSignal() {
  if (state.activeChatId && state.socket) state.socket.emit('typing', { to: state.activeChatId, isTyping: false });
  clearTimeout(state.myTypingTimeout);
}

function handleIncomingMessage(msg) {
  appendMessageToCache(msg.from, msg);
  touchLastMessage(msg.from, msg.text, false, msg.ts);

  if (state.activeChatId === msg.from && state.currentScreen === 'chat') {
    renderChatMessages(msg.from);
  } else {
    const u = state.onlineUsers.get(msg.from);
    if (u) u.unread = (u.unread || 0) + 1;
    if (!msg.system) playMessagePop();
  }
  renderOnlineList();
}

function logCallSystemMessage(text) {
  if (!state.chatLogTargetId || !state.socket) return;
  const targetId = state.chatLogTargetId;
  state.socket.emit('chat-message', { to: targetId, text, system: true });
  const localMsg = { id: 'local-' + Date.now(), from: state.clientId, text, ts: Date.now(), system: true };
  appendMessageToCache(targetId, localMsg);
  touchLastMessage(targetId, text, true, localMsg.ts);
  if (state.activeChatId === targetId) renderChatMessages(targetId);
  renderOnlineList();
}

// ===================== Call invite / ring layer =====================
async function startCall(targetIds, callType) {
  if (!targetIds || targetIds.length === 0) return;
  if (state.currentScreen === 'call' || state.currentScreen === 'outgoing') {
    showToast('You are already in a call.');
    return;
  }

  const roomId = generateClientId();
  state.currentRoomId = roomId;
  state.currentCallType = callType;
  state.isCaller = true;
  state.pendingTargetIds = [...targetIds];
  state.chatLogTargetId = targetIds.length === 1 ? targetIds[0] : null;

  try {
    await acquireLocalMedia(callType);
  } catch (e) {
    showToast('Camera/microphone permission is needed to place a call.');
    return;
  }

  if (targetIds.length === 1) {
    const u = state.onlineUsers.get(targetIds[0]);
    el('outgoing-avatar-initial').textContent = initials(u?.name);
    el('outgoing-avatar-initial').style.background = u?.avatarColor || '';
    el('outgoing-title').textContent = `Calling ${u?.name || 'user'}…`;
  } else {
    el('outgoing-avatar-initial').textContent = String(targetIds.length);
    el('outgoing-avatar-initial').style.background = '';
    el('outgoing-title').textContent = `Calling ${targetIds.length} people…`;
  }
  el('outgoing-subtitle').textContent = callType === 'audio' ? 'Audio call' : 'Video call';
  showScreen('outgoing');

  state.socket.emit('call-invite', { roomId, targetIds, callType });
  state.socket.emit('join-room', { roomId, name: state.name, callType });

  clearTimeout(state.outgoingTimeout);
  state.outgoingTimeout = setTimeout(() => {
    if (state.currentScreen === 'outgoing') {
      state.socket.emit('cancel-call', { roomId, targetIds: state.pendingTargetIds });
      logCallSystemMessage('📵 No answer.');
      state.socket.emit('leave-room');
      endCallCleanup();
      showScreen(state.activeChatId ? 'chat' : 'home');
      showToast('No answer.');
    }
  }, 40000);
}

el('btn-cancel-call').addEventListener('click', () => {
  clearTimeout(state.outgoingTimeout);
  state.socket.emit('cancel-call', { roomId: state.currentRoomId, targetIds: state.pendingTargetIds });
  state.socket.emit('leave-room');
  endCallCleanup();
  showScreen(state.activeChatId ? 'chat' : 'home');
});

function handleIncomingCall(payload) {
  if (state.currentScreen === 'call' || state.currentScreen === 'outgoing' || state.currentScreen === 'incoming') {
    state.socket.emit('call-decline', { roomId: payload.roomId, callerId: payload.from.id });
    return;
  }
  state.incomingCall = payload;
  el('incoming-avatar-initial').textContent = initials(payload.from.name);
  el('incoming-avatar-initial').style.background = payload.from.avatarColor || '';
  el('incoming-title').textContent = payload.groupSize > 1 ? `${payload.from.name} (group call)` : payload.from.name;
  el('incoming-subtitle').textContent = payload.callType === 'audio' ? 'Incoming audio call…' : 'Incoming video call…';
  showScreen('incoming');
  startRingtone();

  clearTimeout(state.incomingTimeout);
  state.incomingTimeout = setTimeout(() => { if (state.currentScreen === 'incoming') declineCall(); }, 30000);
}

function declineCall() {
  stopRingtone();
  clearTimeout(state.incomingTimeout);
  if (state.incomingCall) state.socket.emit('call-decline', { roomId: state.incomingCall.roomId, callerId: state.incomingCall.from.id });
  state.incomingCall = null;
  showScreen(state.activeChatId ? 'chat' : 'home');
}
el('btn-decline').addEventListener('click', declineCall);

el('btn-accept').addEventListener('click', async () => {
  stopRingtone();
  clearTimeout(state.incomingTimeout);
  const { roomId, callType, from, groupSize } = state.incomingCall;
  state.currentRoomId = roomId;
  state.currentCallType = callType;
  state.isCaller = false;
  state.chatLogTargetId = groupSize === 1 ? from.id : null;
  state.incomingCall = null;

  try {
    await acquireLocalMedia(callType);
  } catch (e) {
    showToast('Camera/microphone permission is needed to join the call.');
    showScreen(state.activeChatId ? 'chat' : 'home');
    return;
  }
  state.socket.emit('join-room', { roomId, name: state.name, callType });
});

function handleCallDeclined(roomId, by) {
  if (roomId !== state.currentRoomId) return;
  state.pendingTargetIds = state.pendingTargetIds.filter((id) => id !== by.id);
  showToast(`${by.name} declined.`);
  if (state.peers.size === 0 && state.pendingTargetIds.length === 0) {
    clearTimeout(state.outgoingTimeout);
    logCallSystemMessage('📵 Call declined.');
    state.socket.emit('leave-room');
    endCallCleanup();
    showScreen(state.activeChatId ? 'chat' : 'home');
  }
}

function handleCallUnavailable(targetIds) {
  state.pendingTargetIds = state.pendingTargetIds.filter((id) => !targetIds.includes(id));
  const names = targetIds.map((id) => state.onlineUsers.get(id)?.name || 'They').join(', ');
  showToast(`${names} ${targetIds.length > 1 ? "aren't" : "isn't"} available right now.`);
  if (state.peers.size === 0 && state.pendingTargetIds.length === 0) {
    clearTimeout(state.outgoingTimeout);
    state.socket.emit('leave-room');
    endCallCleanup();
    showScreen(state.activeChatId ? 'chat' : 'home');
  }
}

function handleCallCancelled() {
  if (state.currentScreen === 'incoming') {
    stopRingtone();
    clearTimeout(state.incomingTimeout);
    state.incomingCall = null;
    showScreen(state.activeChatId ? 'chat' : 'home');
    showToast('Missed call — the caller cancelled.');
  }
}

// ===================== Local media =====================
async function acquireLocalMedia(callType) {
  const constraints = callType === 'audio'
    ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }
    : {
        video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      };
  state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  state.camOn = callType !== 'audio';
  state.micOn = true;
}

// ===================== Bandwidth / quality tuning =====================
function computeVideoMaxBitrate(peerCount) {
  if (peerCount <= 1) return 2_500_000;
  if (peerCount <= 3) return 1_200_000;
  if (peerCount <= 5) return 700_000;
  return 400_000;
}
const AUDIO_MAX_BITRATE = 32_000;

function preferCodecs(pc) {
  if (!window.RTCRtpTransceiver || !('setCodecPreferences' in RTCRtpTransceiver.prototype)) return;
  pc.getTransceivers().forEach((t) => {
    const kind = t.sender && t.sender.track && t.sender.track.kind;
    if (kind !== 'video' && kind !== 'audio') return;
    try {
      const caps = RTCRtpSender.getCapabilities(kind);
      if (!caps || !caps.codecs) return;
      const codecs = caps.codecs.slice();
      const rank = (c) => {
        const mt = c.mimeType.toLowerCase();
        if (kind === 'video') {
          if (mt.includes('av1')) return 0;
          if (mt.includes('vp9')) return 1;
          if (mt.includes('vp8')) return 2;
          if (mt.includes('h264')) return 3;
          return 9;
        }
        return mt.includes('opus') ? 0 : 9;
      };
      codecs.sort((a, b) => rank(a) - rank(b));
      t.setCodecPreferences(codecs);
    } catch (e) { /* unsupported in this browser — falls back to default */ }
  });
}

function tuneAudioSdp(sdp) {
  const rtpmapMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
  if (!rtpmapMatch) return sdp;
  const pt = rtpmapMatch[1];
  const fmtpRegex = new RegExp(`a=fmtp:${pt} (.*)`);
  if (fmtpRegex.test(sdp)) {
    return sdp.replace(fmtpRegex, (match, params) => {
      let updated = params.trim();
      if (!/usedtx=/.test(updated)) updated += ';usedtx=1';
      if (!/stereo=/.test(updated)) updated += ';stereo=0';
      if (!/maxaveragebitrate=/.test(updated)) updated += `;maxaveragebitrate=${AUDIO_MAX_BITRATE}`;
      return `a=fmtp:${pt} ${updated}`;
    });
  }
  return sdp.replace(`a=rtpmap:${pt} opus/48000`, `a=rtpmap:${pt} opus/48000\r\na=fmtp:${pt} usedtx=1;stereo=0;maxaveragebitrate=${AUDIO_MAX_BITRATE}`);
}

async function applyBitrateToPc(pc) {
  const peerCount = Math.max(state.peers.size, 1);
  const videoMax = computeVideoMaxBitrate(peerCount);
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      if (sender.track.kind === 'video') {
        params.encodings[0].maxBitrate = videoMax;
        if ('degradationPreference' in params) params.degradationPreference = 'balanced';
      } else if (sender.track.kind === 'audio') {
        params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
      }
      await sender.setParameters(params);
    } catch (e) { /* rejected before negotiation completes — safe to ignore */ }
  }
}
function applyBitrateToAllPeers() {
  state.peers.forEach((peer) => { if (peer.pc) applyBitrateToPc(peer.pc); });
}

// ===================== Mesh WebRTC engine =====================
function createPeerConnection(id) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (evt) => {
    if (evt.candidate) state.socket.emit('signal', { to: id, data: { type: 'candidate', candidate: evt.candidate } });
  };
  pc.ontrack = (evt) => {
    const peer = state.peers.get(id);
    if (peer?.tileEl) {
      const videoEl = peer.tileEl.querySelector('video');
      if (videoEl.srcObject !== evt.streams[0]) videoEl.srcObject = evt.streams[0];
      videoEl.muted = state.speakerMuted;
    }
  };
  return pc;
}

function ensurePeerPlaceholder(id, name, avatarColor) {
  if (state.peers.has(id)) return state.peers.get(id);
  const tileEl = createTile(id, name, false, avatarColor);
  const peer = { pc: null, name, tileEl };
  state.peers.set(id, peer);
  relayoutGrid();
  return peer;
}

async function callPeer(id, name, avatarColor) {
  const peer = ensurePeerPlaceholder(id, name, avatarColor);
  const pc = createPeerConnection(id);
  peer.pc = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  preferCodecs(pc);
  const offer = await pc.createOffer();
  offer.sdp = tuneAudioSdp(offer.sdp);
  await pc.setLocalDescription(offer);
  state.socket.emit('signal', { to: id, data: offer });
  applyBitrateToAllPeers();
}

async function answerPeer(id, name, avatarColor, offerData) {
  const existing = state.peers.get(id);
  if (existing && existing.pc) return;
  const peer = ensurePeerPlaceholder(id, name, avatarColor);
  peer.name = name;
  const pc = createPeerConnection(id);
  peer.pc = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  preferCodecs(pc);
  await pc.setRemoteDescription(new RTCSessionDescription(offerData));
  const answer = await pc.createAnswer();
  answer.sdp = tuneAudioSdp(answer.sdp);
  await pc.setLocalDescription(answer);
  state.socket.emit('signal', { to: id, data: answer });

  ensureLocalTile();
  enterCallScreen();
  applyBitrateToAllPeers();
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  if (peer.pc) peer.pc.close();
  peer.tileEl?.remove();
  state.peers.delete(id);
  applyBitrateToAllPeers();
}

// ===================== Grid / tiles =====================
function createTile(id, name, isLocal, avatarColor) {
  const tpl = el('tile-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.peerId = id;
  node.classList.toggle('is-local', isLocal);
  node.querySelector('.tile-name').textContent = isLocal ? `${name} (You)` : name;
  const avatarEl = node.querySelector('.avatar-circle');
  avatarEl.textContent = initials(name);
  const color = isLocal ? state.avatarColor : avatarColor;
  if (color) avatarEl.style.background = color;
  el('video-grid').appendChild(node);
  return node;
}

function ensureLocalTile() {
  if (state.localTileEl) return;
  state.localTileEl = createTile(state.selfId || 'local', state.name, true);
  state.localTileEl.querySelector('video').srcObject = state.localStream;
  state.localTileEl.classList.toggle('cam-off', !state.camOn);
  state.localTileEl.classList.toggle('mic-off', !state.micOn);
}

function relayoutGrid() {
  const grid = el('video-grid');
  const total = 1 + state.peers.size;
  grid.className = 'video-grid';
  if (state.currentCallType === 'audio') grid.classList.add('call-audio-mode');

  if (total <= 2) {
    grid.classList.add('mode-pair');
    const [onlyPeer] = state.peers.values();
    if (state.localTileEl) { state.localTileEl.classList.add('tile-pip'); state.localTileEl.classList.remove('tile-main'); }
    if (onlyPeer?.tileEl) { onlyPeer.tileEl.classList.add('tile-main'); onlyPeer.tileEl.classList.remove('tile-pip'); }
  } else {
    grid.classList.add('mode-grid', `count-${Math.min(total, 9)}`);
    if (state.localTileEl) state.localTileEl.classList.remove('tile-main', 'tile-pip');
    state.peers.forEach((p) => p.tileEl?.classList.remove('tile-main', 'tile-pip'));
  }

  el('participant-count').textContent = `${total} in call`;
  el('active-name-label').textContent = total === 2 ? ([...state.peers.values()][0]?.name || 'Connected') : 'Group call';
}

// ===================== Active call screen =====================
function enterCallScreen() {
  ensureLocalTile();
  relayoutGrid();
  el('call-bottom-bar').classList.toggle('is-audio-call', state.currentCallType === 'audio');
  showScreen('call');
  if (!state.callTimerInterval) startCallTimer();
  if (!state.qualityInterval) startQualityMonitor();
}

function startCallTimer() {
  state.callStartedAt = state.callStartedAt || Date.now();
  state.callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - state.callStartedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    el('call-timer').textContent = `${mm}:${ss}`;
  }, 1000);
}

function startQualityMonitor() {
  state.qualityInterval = setInterval(async () => {
    if (state.peers.size === 0) return;
    let worstRtt = 0, sawStats = false;
    for (const peer of state.peers.values()) {
      if (!peer.pc) continue;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
            sawStats = true;
            worstRtt = Math.max(worstRtt, report.currentRoundTripTime * 1000);
          }
        });
      } catch (e) { /* ignore */ }
    }
    if (!sawStats) return;
    const indicator = el('quality-indicator');
    indicator.classList.remove('good', 'fair', 'poor');
    if (worstRtt < 150) { indicator.classList.add('good'); indicator.textContent = 'Good connection'; }
    else if (worstRtt < 350) { indicator.classList.add('fair'); indicator.textContent = 'Fair connection'; }
    else { indicator.classList.add('poor'); indicator.textContent = 'Weak connection'; }
  }, 4000);
}

// ---- Controls ----
function applyMicState() {
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
  el('active-toggle-mic').classList.toggle('active', state.micOn);
  el('active-toggle-mic').classList.toggle('off', !state.micOn);
  if (state.localTileEl) state.localTileEl.classList.toggle('mic-off', !state.micOn);
  if (state.socket && state.currentRoomId) state.socket.emit('media-state', { micOn: state.micOn, camOn: state.camOn });
}
function applyCamState() {
  state.localStream?.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
  el('active-toggle-cam').classList.toggle('active', state.camOn);
  el('active-toggle-cam').classList.toggle('off', !state.camOn);
  if (state.localTileEl) state.localTileEl.classList.toggle('cam-off', !state.camOn);
  if (state.socket && state.currentRoomId) state.socket.emit('media-state', { micOn: state.micOn, camOn: state.camOn });
}
el('active-toggle-mic').addEventListener('click', () => { state.micOn = !state.micOn; applyMicState(); });
el('active-toggle-cam').addEventListener('click', () => { state.camOn = !state.camOn; applyCamState(); });

el('active-toggle-speaker').addEventListener('click', () => {
  state.speakerMuted = !state.speakerMuted;
  el('active-toggle-speaker').classList.toggle('active', !state.speakerMuted);
  el('active-toggle-speaker').classList.toggle('off', state.speakerMuted);
  state.peers.forEach((peer) => {
    const v = peer.tileEl?.querySelector('video');
    if (v) v.muted = state.speakerMuted;
  });
});

el('active-switch-cam').addEventListener('click', async () => {
  state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    state.peers.forEach((peer) => {
      const sender = peer.pc?.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newVideoTrack);
    });
    state.localStream.getVideoTracks().forEach((t) => t.stop());
    state.localStream.removeTrack(state.localStream.getVideoTracks()[0]);
    state.localStream.addTrack(newVideoTrack);
    if (state.localTileEl) state.localTileEl.querySelector('video').srcObject = state.localStream;
  } catch (e) { showToast('Could not switch camera.'); }
});

el('btn-fullscreen').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (e) { showToast('Full screen is not available here.'); }
});
document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  el('btn-fullscreen').classList.toggle('active', active);
  el('icon-fs-enter').style.display = active ? 'none' : '';
  el('icon-fs-exit').style.display = active ? '' : 'none';
});

// ---- Ending a call ----
function finishCallScreen(message) {
  const durationMs = state.callStartedAt ? Date.now() - state.callStartedAt : 0;
  if (state.isCaller && state.chatLogTargetId && durationMs > 0) {
    const icon = state.currentCallType === 'audio' ? '📞' : '📹';
    const label = state.currentCallType === 'audio' ? 'Audio' : 'Video';
    logCallSystemMessage(`${icon} ${label} call · ${formatDuration(durationMs)}`);
  }
  endCallCleanup();
  el('ended-summary').textContent = message;
  showScreen('ended');
}

function endCallCleanup() {
  clearInterval(state.callTimerInterval);
  clearInterval(state.qualityInterval);
  state.callTimerInterval = null;
  state.qualityInterval = null;
  state.callStartedAt = null;
  state.peers.forEach((peer) => peer.pc && peer.pc.close());
  state.peers.clear();
  if (state.localTileEl) { state.localTileEl.remove(); state.localTileEl = null; }
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.currentRoomId = null;
  state.currentCallType = null;
  state.isCaller = false;
  state.pendingTargetIds = [];
  state.chatLogTargetId = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

el('btn-hangup').addEventListener('click', () => {
  state.socket.emit('leave-room');
  finishCallScreen('You left the call.');
});
el('btn-back-to-home').addEventListener('click', () => {
  showScreen(state.activeChatId ? 'chat' : 'home');
});

// ===================== Socket / signaling =====================
function connectSocket() {
  if (state.socket) return;
  state.socket = io();

  state.socket.on('connect', () => {
    state.socket.emit('hello', { clientId: state.clientId, name: state.name, avatarColor: state.avatarColor });
  });

  state.socket.on('online-list', ({ users }) => {
    users.forEach((u) => upsertOnlineUser(u, true));
    renderOnlineList();
  });

  state.socket.on('user-online', (u) => {
    upsertOnlineUser(u, true);
    renderOnlineList();
    if (state.activeChatId === u.id) updateChatHeaderStatus();
  });

  state.socket.on('user-offline', ({ id }) => {
    const u = state.onlineUsers.get(id);
    if (u) { u.online = false; renderOnlineList(); }
    if (state.activeChatId === id) updateChatHeaderStatus();
  });

  state.socket.on('chat-message', (msg) => handleIncomingMessage(msg));

  state.socket.on('typing', ({ from, isTyping }) => {
    if (state.activeChatId === from) el('typing-indicator').classList.toggle('show', isTyping);
  });

  state.socket.on('history', ({ withId, messages }) => {
    state.chatCache.set(withId, messages);
    if (state.activeChatId === withId) renderChatMessages(withId);
  });

  state.socket.on('incoming-call', (payload) => handleIncomingCall(payload));
  state.socket.on('call-declined', ({ roomId, by }) => handleCallDeclined(roomId, by));
  state.socket.on('call-unavailable', ({ targetIds }) => handleCallUnavailable(targetIds));
  state.socket.on('call-cancelled', () => handleCallCancelled());

  state.socket.on('room-full', ({ max }) => {
    showToast(`That call already has the max of ${max} people.`);
    endCallCleanup();
    showScreen(state.activeChatId ? 'chat' : 'home');
  });

  state.socket.on('joined', ({ selfId, others }) => {
    state.selfId = selfId;
    ensureLocalTile();
    clearTimeout(state.outgoingTimeout);
    if (others.length > 0) {
      enterCallScreen();
      others.forEach(({ id, name, avatarColor }) => callPeer(id, name, avatarColor));
    }
  });

  state.socket.on('user-joined', ({ id, name, avatarColor }) => {
    clearTimeout(state.outgoingTimeout);
    ensurePeerPlaceholder(id, name, avatarColor);
    if (state.currentScreen === 'outgoing') enterCallScreen();
  });

  state.socket.on('signal', async ({ from, name, avatarColor, data }) => {
    if (data.type === 'offer') {
      await answerPeer(from, name, avatarColor, data);
    } else if (data.type === 'answer') {
      const peer = state.peers.get(from);
      if (peer?.pc) await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.type === 'candidate') {
      const peer = state.peers.get(from);
      if (peer?.pc) { try { await peer.pc.addIceCandidate(data.candidate); } catch (e) { /* ignore */ } }
    }
  });

  state.socket.on('media-state', ({ from, micOn, camOn }) => {
    const peer = state.peers.get(from);
    if (!peer?.tileEl) return;
    peer.tileEl.classList.toggle('mic-off', !micOn);
    peer.tileEl.classList.toggle('cam-off', !camOn);
  });

  state.socket.on('peer-left', ({ id }) => {
    removePeer(id);
    if (state.peers.size === 0 && state.currentScreen === 'call') {
      finishCallScreen('The other person left the call.');
    } else {
      relayoutGrid();
    }
  });
}

window.addEventListener('beforeunload', () => {
  if (state.socket) state.socket.emit('leave-room');
});

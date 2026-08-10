// ===================== State =====================
const state = {
  name: '',
  roomId: '',
  socket: null,
  localStream: null,
  pc: null,
  peerId: null,
  peerName: '',
  micOn: true,
  camOn: true,
  callTimerInterval: null,
  callStartedAt: null,
  facingMode: 'user',
  isCaller: false,
};

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ===================== Screen helpers =====================
const screens = ['setup', 'lobby', 'ringing', 'incoming', 'active', 'ended'];
function showScreen(name) {
  screens.forEach((s) => {
    document.getElementById(`screen-${s}`).classList.toggle('active', s === name);
  });
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

// ===================== Elements =====================
const el = (id) => document.getElementById(id);

// ===================== Setup screen =====================
el('btn-generate').addEventListener('click', () => {
  el('input-room').value = 'call-' + Math.random().toString(36).slice(2, 8);
});

el('btn-join').addEventListener('click', async () => {
  const name = el('input-name').value.trim();
  const roomId = el('input-room').value.trim();
  el('setup-error').textContent = '';

  if (!name) { el('setup-error').textContent = 'Enter your name to continue.'; return; }
  if (!roomId) { el('setup-error').textContent = 'Enter a call ID to continue.'; return; }

  state.name = name;
  state.roomId = roomId;

  try {
    await setupLocalMedia();
  } catch (err) {
    el('setup-error').textContent = 'Camera/microphone access is needed to place calls.';
    return;
  }

  el('lobby-room-id').textContent = roomId;
  connectSocket();
  showScreen('lobby');
});

// ===================== Media setup =====================
async function setupLocalMedia() {
  state.localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: state.facingMode },
    audio: true,
  });
  el('lobby-preview').srcObject = state.localStream;
  el('local-video').srcObject = state.localStream;
}

function applyMicState() {
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
  [el('lobby-toggle-mic'), el('active-toggle-mic')].forEach((btn) => {
    btn.classList.toggle('active', state.micOn);
    btn.classList.toggle('off', !state.micOn);
  });
}

function applyCamState() {
  state.localStream?.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
  [el('lobby-toggle-cam'), el('active-toggle-cam')].forEach((btn) => {
    btn.classList.toggle('active', state.camOn);
    btn.classList.toggle('off', !state.camOn);
  });
  el('lobby-novideo').classList.toggle('show', !state.camOn);
}

el('lobby-toggle-mic').addEventListener('click', () => { state.micOn = !state.micOn; applyMicState(); });
el('lobby-toggle-cam').addEventListener('click', () => { state.camOn = !state.camOn; applyCamState(); });
el('active-toggle-mic').addEventListener('click', () => { state.micOn = !state.micOn; applyMicState(); });
el('active-toggle-cam').addEventListener('click', () => { state.camOn = !state.camOn; applyCamState(); });

el('active-switch-cam').addEventListener('click', async () => {
  state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode },
      audio: true,
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    const sender = state.pc?.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newVideoTrack);

    state.localStream.getVideoTracks().forEach((t) => t.stop());
    state.localStream.removeTrack(state.localStream.getVideoTracks()[0]);
    state.localStream.addTrack(newVideoTrack);
    el('local-video').srcObject = state.localStream;
  } catch (err) {
    console.warn('Could not switch camera', err);
  }
});

el('btn-leave-lobby').addEventListener('click', () => {
  teardownMedia();
  if (state.socket) state.socket.disconnect();
  showScreen('setup');
});

// ===================== Socket / signaling =====================
function connectSocket() {
  if (state.socket) return;
  state.socket = io();

  state.socket.on('connect', () => {
    state.socket.emit('join-room', { roomId: state.roomId, name: state.name });
  });

  state.socket.on('room-full', () => {
    el('setup-error').textContent = 'That call ID already has two people in it.';
    showScreen('setup');
  });

  state.socket.on('joined', ({ others }) => {
    // If someone is already waiting in the room, this is treated as an incoming call once they signal us.
    // Nothing to do yet — we wait for 'user-joined' or an incoming 'signal'.
  });

  state.socket.on('user-joined', ({ id, name }) => {
    // Someone joined our room after us -> if we already pressed "Call", we ring them.
    state.peerId = id;
    state.peerName = name;
    if (state.pendingCall) {
      startCallAsCaller();
    }
  });

  state.socket.on('signal', async ({ from, name, data }) => {
    if (data.type === 'offer') {
      state.peerId = from;
      state.peerName = name;
      showIncomingCall();
      state.pendingOffer = data;
    } else if (data.type === 'answer') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.type === 'candidate') {
      try { await state.pc.addIceCandidate(data.candidate); } catch (e) { /* ignore */ }
    }
  });

  state.socket.on('call-cancelled', () => {
    if (document.getElementById('screen-incoming').classList.contains('active')) {
      endCall('Missed call');
    }
  });

  state.socket.on('peer-hung-up', () => {
    endCall(`Call with ${state.peerName || 'peer'} ended`);
  });
}

// ===================== Placing a call =====================
el('btn-start-call').addEventListener('click', () => {
  state.pendingCall = true;
  el('btn-start-call').disabled = true;
  el('btn-start-call-label').textContent = 'Calling…';

  el('ringing-room-id').textContent = state.roomId;
  el('ringing-name').textContent = 'Calling…';
  el('ringing-avatar-initial').textContent = initials(state.name);
  showScreen('ringing');

  // If a peer is already in the room, call immediately.
  if (state.peerId) {
    startCallAsCaller();
  }
});

async function startCallAsCaller() {
  state.pendingCall = false;
  state.isCaller = true;
  createPeerConnection();
  state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));

  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  state.socket.emit('signal', { to: state.peerId, data: offer });

  el('ringing-name').textContent = state.peerName || 'Calling…';
  el('ringing-avatar-initial').textContent = initials(state.peerName);
}

el('btn-cancel-call').addEventListener('click', () => {
  state.pendingCall = false;
  state.socket.emit('call-cancelled');
  cleanupPeerConnection();
  el('btn-start-call').disabled = false;
  el('btn-start-call-label').textContent = 'Call';
  showScreen('lobby');
});

// ===================== Receiving a call =====================
function showIncomingCall() {
  el('incoming-name').textContent = state.peerName || 'Unknown';
  el('incoming-avatar-initial').textContent = initials(state.peerName);
  showScreen('incoming');
}

el('btn-decline').addEventListener('click', () => {
  state.socket.emit('hang-up');
  state.pendingOffer = null;
  showScreen('lobby');
});

el('btn-accept').addEventListener('click', async () => {
  createPeerConnection();
  state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));

  await state.pc.setRemoteDescription(new RTCSessionDescription(state.pendingOffer));
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);
  state.socket.emit('signal', { to: state.peerId, data: answer });
  state.pendingOffer = null;

  enterActiveCall();
});

// ===================== Peer connection =====================
function createPeerConnection() {
  state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  state.pc.onicecandidate = (evt) => {
    if (evt.candidate && state.peerId) {
      state.socket.emit('signal', { to: state.peerId, data: { type: 'candidate', candidate: evt.candidate } });
    }
  };

  state.pc.ontrack = (evt) => {
    const remoteVideo = el('remote-video');
    if (remoteVideo.srcObject !== evt.streams[0]) {
      remoteVideo.srcObject = evt.streams[0];
    }
    el('remote-placeholder').style.display = 'none';
    if (!document.getElementById('screen-active').classList.contains('active')) {
      enterActiveCall();
    }
  };

  state.pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(state.pc.connectionState)) {
      // handled via explicit hang-up / peer-hung-up mostly; this is a safety net
    }
  };
}

function cleanupPeerConnection() {
  if (state.pc) {
    state.pc.getSenders().forEach((s) => s.track && s.track.stop && null);
    state.pc.close();
    state.pc = null;
  }
  el('remote-video').srcObject = null;
  el('remote-placeholder').style.display = 'flex';
}

// ===================== Active call =====================
function enterActiveCall() {
  el('active-name-label').textContent = state.peerName || 'Connected';
  el('active-peer-name').textContent = state.peerName || 'Connecting…';
  el('active-avatar-initial').textContent = initials(state.peerName);
  el('remote-placeholder').style.display = 'flex';
  applyMicState();
  applyCamState();
  showScreen('active');
  startCallTimer();
}

function startCallTimer() {
  state.callStartedAt = Date.now();
  clearInterval(state.callTimerInterval);
  state.callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - state.callStartedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    el('call-timer').textContent = `${mm}:${ss}`;
  }, 1000);
}

el('btn-hangup').addEventListener('click', () => {
  state.socket.emit('hang-up');
  endCall(`Call with ${state.peerName || 'peer'} ended`);
});

function endCall(message) {
  clearInterval(state.callTimerInterval);
  cleanupPeerConnection();
  el('ended-summary').textContent = message || 'The call has ended.';
  el('btn-start-call').disabled = false;
  el('btn-start-call-label').textContent = 'Call';
  state.peerId = null;
  state.peerName = '';
  showScreen('ended');
}

el('btn-back-to-lobby').addEventListener('click', () => {
  showScreen('lobby');
});

// ===================== Cleanup =====================
function teardownMedia() {
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  cleanupPeerConnection();
}

window.addEventListener('beforeunload', () => {
  if (state.socket) state.socket.emit('hang-up');
});

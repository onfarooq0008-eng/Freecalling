const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ===================== In-memory state =====================
// Everything here lives in server memory only — it resets on restart/redeploy.
// That's a deliberate simplicity trade-off for a Koyeb-friendly single
// container with no database. See README for what a persistent version
// would need.

// clientId -> { name, avatarColor, socketId }
// clientId is generated and persisted client-side (localStorage), so a
// browser keeps the same identity across reloads even though the
// underlying socket connection is ephemeral.
const onlineUsers = new Map();

// pairKey(a,b) -> [{ id, from, text, ts, system? }]
const chatHistories = new Map();
const MAX_HISTORY_PER_PAIR = 200;

// Mesh call rooms — same shape as before, now created on-demand by the
// call-invite flow instead of a manually typed room code.
// roomId -> { members: Map<socketId, { name, clientId }>, callType }
const rooms = new Map();
const MAX_ROOM_SIZE = 8;

function pairKey(a, b) {
  return [a, b].sort().join('::');
}

function publicUser(clientId) {
  const u = onlineUsers.get(clientId);
  if (!u) return null;
  return { id: clientId, name: u.name, avatarColor: u.avatarColor };
}

io.on('connection', (socket) => {
  let currentRoom = null;

  // ---------- Presence ----------
  socket.on('hello', ({ clientId, name, avatarColor }) => {
    if (!clientId || !name) return;
    socket.data.clientId = clientId;
    onlineUsers.set(clientId, { name: String(name).slice(0, 40), avatarColor, socketId: socket.id });

    const others = [...onlineUsers.keys()]
      .filter((id) => id !== clientId)
      .map((id) => publicUser(id));
    socket.emit('online-list', { users: others });

    socket.broadcast.emit('user-online', publicUser(clientId));
  });

  socket.on('update-profile', ({ name }) => {
    const clientId = socket.data.clientId;
    if (!clientId || !onlineUsers.has(clientId) || !name) return;
    onlineUsers.get(clientId).name = String(name).slice(0, 40);
    socket.broadcast.emit('user-online', publicUser(clientId));
  });

  // ---------- Chat ----------
  socket.on('chat-message', ({ to, text, system }) => {
    const clientId = socket.data.clientId;
    if (!clientId || !to || !text || !String(text).trim()) return;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: clientId,
      text: String(text).trim().slice(0, 2000),
      ts: Date.now(),
      system: !!system,
    };

    const key = pairKey(clientId, to);
    if (!chatHistories.has(key)) chatHistories.set(key, []);
    const history = chatHistories.get(key);
    history.push(msg);
    if (history.length > MAX_HISTORY_PER_PAIR) history.shift();

    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('chat-message', msg);
  });

  socket.on('typing', ({ to, isTyping }) => {
    const clientId = socket.data.clientId;
    if (!clientId || !to) return;
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('typing', { from: clientId, isTyping: !!isTyping });
  });

  socket.on('get-history', ({ withId }) => {
    const clientId = socket.data.clientId;
    if (!clientId || !withId) return;
    const key = pairKey(clientId, withId);
    socket.emit('history', { withId, messages: chatHistories.get(key) || [] });
  });

  // ---------- Call invite / ring layer ----------
  socket.on('call-invite', ({ roomId, targetIds, callType }) => {
    const clientId = socket.data.clientId;
    const caller = clientId && onlineUsers.get(clientId);
    if (!caller || !roomId || !Array.isArray(targetIds) || targetIds.length === 0) return;

    const unavailable = [];
    targetIds.forEach((tid) => {
      const target = onlineUsers.get(tid);
      if (target) {
        io.to(target.socketId).emit('incoming-call', {
          roomId,
          callType,
          from: publicUser(clientId),
          groupSize: targetIds.length,
        });
      } else {
        unavailable.push(tid);
      }
    });
    if (unavailable.length > 0) socket.emit('call-unavailable', { targetIds: unavailable });
  });

  socket.on('call-decline', ({ roomId, callerId }) => {
    const clientId = socket.data.clientId;
    const caller = onlineUsers.get(callerId);
    if (caller) io.to(caller.socketId).emit('call-declined', { roomId, by: publicUser(clientId) });
  });

  socket.on('cancel-call', ({ roomId, targetIds }) => {
    (targetIds || []).forEach((tid) => {
      const target = onlineUsers.get(tid);
      if (target) io.to(target.socketId).emit('call-cancelled', { roomId });
    });
  });

  // ---------- Mesh call room signaling ----------
  socket.on('join-room', ({ roomId, name, callType }) => {
    if (!roomId || !name) return;
    if (currentRoom && currentRoom !== roomId) leaveCurrentRoom();

    const room = rooms.has(roomId) ? rooms.get(roomId) : { members: new Map(), callType };
    rooms.set(roomId, room);

    if (room.members.size >= MAX_ROOM_SIZE) {
      socket.emit('room-full', { max: MAX_ROOM_SIZE });
      return;
    }

    const avatarColor = onlineUsers.get(socket.data.clientId)?.avatarColor;

    currentRoom = roomId;
    socket.join(roomId);
    room.members.set(socket.id, { name, clientId: socket.data.clientId, avatarColor });

    const others = [...room.members.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, info]) => ({ id, name: info.name, avatarColor: info.avatarColor }));

    socket.emit('joined', { selfId: socket.id, others, callType: room.callType });
    socket.to(roomId).emit('user-joined', { id: socket.id, name, avatarColor });
  });

  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    const senderUser = onlineUsers.get(socket.data.clientId);
    io.to(to).emit('signal', { from: socket.id, name: senderUser?.name, avatarColor: senderUser?.avatarColor, data });
  });

  socket.on('media-state', ({ micOn, camOn }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('media-state', { from: socket.id, micOn, camOn });
  });

  socket.on('leave-room', () => leaveCurrentRoom());

  socket.on('disconnect', () => {
    leaveCurrentRoom();
    const clientId = socket.data.clientId;
    if (clientId && onlineUsers.get(clientId)?.socketId === socket.id) {
      onlineUsers.delete(clientId);
      socket.broadcast.emit('user-offline', { id: clientId });
    }
  });

  function leaveCurrentRoom() {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.members.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
      if (room.members.size === 0) rooms.delete(currentRoom);
    }
    currentRoom = null;
  }
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

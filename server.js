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

// roomId -> { members: Map<socketId, { name }> }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { members: new Map() });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;

    const room = getRoom(roomId);

    // Simple 1:1 cap — reject a 3rd caller
    if (room.members.size >= 2) {
      socket.emit('room-full');
      return;
    }

    currentRoom = roomId;
    currentName = name;
    socket.join(roomId);
    room.members.set(socket.id, { name });

    const others = [...room.members.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, info]) => ({ id, name: info.name }));

    // Tell the newcomer who is already in the room
    socket.emit('joined', { selfId: socket.id, others });

    // Tell existing members someone new joined (they'll place the call / send the offer)
    socket.to(roomId).emit('user-joined', { id: socket.id, name });
  });

  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, name: currentName, data });
  });

  socket.on('call-cancelled', () => {
    if (currentRoom) socket.to(currentRoom).emit('call-cancelled');
  });

  socket.on('hang-up', () => {
    if (currentRoom) socket.to(currentRoom).emit('peer-hung-up');
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.members.delete(socket.id);
      socket.to(currentRoom).emit('peer-hung-up');
      if (room.members.size === 0) rooms.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

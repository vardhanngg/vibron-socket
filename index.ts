import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://vibronmax.vercel.app',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

interface RoomState {
  currentSong: string | null; // Song URL
  currentSongId: string | null; // Song ID
  currentTime: number; // Current playback time
  isPlaying: boolean; // Play/pause state
  users: string[]; // Connected user socket IDs
  mood?: string; // For mood.js: detected or selected mood
  language?: string; // For mood.js: selected language
}

const rooms: { [roomId: string]: RoomState } = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create a new room
  socket.on('createRoom', (isMoodMode: boolean) => {
    const roomId = Math.random().toString(36).substring(2, 8); // e.g., abc123
    rooms[roomId] = {
      currentSong: null,
      currentSongId: null,
      currentTime: 0,
      isPlaying: false,
      users: [socket.id],
      mood: isMoodMode ? 'neutral' : undefined,
      language: isMoodMode ? 'english' : undefined,
    };
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
  });

  // Join an existing room
  socket.on('joinRoom', (roomId: string) => {
    if (rooms[roomId]) {
      rooms[roomId].users.push(socket.id);
      socket.join(roomId);
      socket.emit('roomJoined', { roomId, state: rooms[roomId] });
    } else {
      socket.emit('error', 'Room not found');
    }
  });

  // Play/pause
  socket.on('playPause', ({ roomId, isPlaying, currentTime }: { roomId: string; isPlaying: boolean; currentTime: number }) => {
    if (rooms[roomId]) {
      rooms[roomId].isPlaying = isPlaying;
      rooms[roomId].currentTime = currentTime;
      io.to(roomId).emit('updateState', rooms[roomId]);
    }
  });

  // Change song (normal.js)
  socket.on('changeSong', ({ roomId, songUrl, songId }: { roomId: string; songUrl: string; songId: string }) => {
    if (rooms[roomId]) {
      rooms[roomId].currentSong = songUrl;
      rooms[roomId].currentSongId = songId;
      rooms[roomId].currentTime = 0;
      rooms[roomId].isPlaying = true;
      io.to(roomId).emit('updateState', rooms[roomId]);
    }
  });

  // Seek
  socket.on('seek', ({ roomId, currentTime }: { roomId: string; currentTime: number }) => {
    if (rooms[roomId]) {
      rooms[roomId].currentTime = currentTime;
      io.to(roomId).emit('updateState', rooms[roomId]);
    }
  });

  // Mood-based song change (mood.js)
  socket.on('changeMoodSong', ({ roomId, songUrl, songId, mood, language }: { roomId: string; songUrl: string; songId: string; mood: string; language: string }) => {
    if (rooms[roomId]) {
      rooms[roomId].currentSong = songUrl;
      rooms[roomId].currentSongId = songId;
      rooms[roomId].mood = mood;
      rooms[roomId].language = language;
      rooms[roomId].currentTime = 0;
      rooms[roomId].isPlaying = true;
      io.to(roomId).emit('updateState', rooms[roomId]);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      rooms[roomId].users = rooms[roomId].users.filter((id) => id !== socket.id);
      if (rooms[roomId].users.length === 0) {
        delete rooms[roomId];
      }
    }
  });
});

// Periodic sync to handle drift
setInterval(() => {
  for (const roomId in rooms) {
    io.to(roomId).emit('updateState', rooms[roomId]);
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Socket server running on port ${PORT}`));
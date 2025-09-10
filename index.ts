import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createClient } from 'redis';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://vibronmax.vercel.app',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Initialize Redis
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[redis] Error:', err));
await redis.connect();

interface RoomState {
  currentSong: string | null;
  currentSongId: string | null;
  currentTime: number;
  isPlaying: boolean;
  users: string[];
  mood?: string;
  language?: string;
  leaderId: string;
  title?: string;
  artist?: string;
  image?: string;
}

io.on('connection', (socket) => {
  console.log(`[socket] User connected: ${socket.id}`);

  socket.on('createRoom', async (isMoodMode: boolean) => {
    const roomId = Math.random().toString(36).substring(2, 8);
    const roomState: RoomState = {
      currentSong: null,
      currentSongId: null,
      currentTime: 0,
      isPlaying: false,
      users: [socket.id],
      mood: isMoodMode ? 'neutral' : undefined,
      language: isMoodMode ? 'english' : undefined,
      leaderId: socket.id,
    };
    await redis.set(`room:${roomId}`, JSON.stringify(roomState), { EX: 24 * 60 * 60 }); // Expire after 24 hours
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
    console.log(`[socket] Room created: ${roomId}, Mood Mode: ${isMoodMode}`);
  });

  socket.on('joinRoom', async (roomId: string) => {
    if (typeof roomId !== 'string' || !/^[a-z0-9]{6}$/.test(roomId)) {
      socket.emit('error', 'Invalid room ID');
      return;
    }
    const roomState = await redis.get(`room:${roomId}`);
    if (roomState) {
      const state: RoomState = JSON.parse(roomState);
      state.users.push(socket.id);
      await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
      socket.join(roomId);
      socket.emit('roomJoined', { roomId, state });
      console.log(`[socket] User ${socket.id} joined room ${roomId}`);
    } else {
      socket.emit('error', 'Room not found');
    }
  });

  socket.on('playPause', async ({ roomId, isPlaying, currentTime }: { roomId: string; isPlaying: boolean; currentTime: number }) => {
    const roomState = await redis.get(`room:${roomId}`);
    if (roomState && socket.id === JSON.parse(roomState).leaderId) {
      const state: RoomState = JSON.parse(roomState);
      state.isPlaying = isPlaying;
      state.currentTime = currentTime;
      await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
      io.to(roomId).emit('updateState', state);
      console.log(`[socket] Room ${roomId} play/pause: ${isPlaying}, time: ${currentTime}`);
    } else {
      socket.emit('error', 'Only the room leader can control playback');
    }
  });

  socket.on('changeSong', async ({ roomId, songUrl, songId, title, artist, image }: { roomId: string; songUrl: string; songId: string; title?: string; artist?: string; image?: string }) => {
    const roomState = await redis.get(`room:${roomId}`);
    if (roomState && socket.id === JSON.parse(roomState).leaderId) {
      const state: RoomState = JSON.parse(roomState);
      state.currentSong = songUrl;
      state.currentSongId = songId;
      state.currentTime = 0;
      state.isPlaying = true;
      state.title = title;
      state.artist = artist;
      state.image = image;
      await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
      io.to(roomId).emit('updateState', state);
      console.log(`[socket] Room ${roomId} changed song: ${songId}`);
    } else {
      socket.emit('error', 'Only the room leader can change songs');
    }
  });

  socket.on('changeMoodSong', async ({ roomId, songUrl, songId, mood, language, title, artist }: { roomId: string; songUrl: string; songId: string; mood: string; language: string; title?: string; artist?: string }) => {
    const roomState = await redis.get(`room:${roomId}`);
    if (roomState && socket.id === JSON.parse(roomState).leaderId) {
      const state: RoomState = JSON.parse(roomState);
      state.currentSong = songUrl;
      state.currentSongId = songId;
      state.mood = mood;
      state.language = language;
      state.currentTime = 0;
      state.isPlaying = true;
      state.title = title;
      state.artist = artist;
      await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
      io.to(roomId).emit('updateState', state);
      console.log(`[socket] Room ${roomId} changed mood song: ${songId}, mood: ${mood}, language: ${language}`);
    } else {
      socket.emit('error', 'Only the room leader can change songs');
    }
  });

  socket.on('seek', async ({ roomId, currentTime }: { roomId: string; currentTime: number }) => {
    const roomState = await redis.get(`room:${roomId}`);
    if (roomState && socket.id === JSON.parse(roomState).leaderId) {
      const state: RoomState = JSON.parse(roomState);
      state.currentTime = currentTime;
      await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
      io.to(roomId).emit('updateState', state);
      console.log(`[socket] Room ${roomId} seeked to: ${currentTime}`);
    } else {
      socket.emit('error', 'Only the room leader can seek');
    }
  });

  socket.on('disconnect', async () => {
    for (const key of await redis.keys('room:*')) {
      const roomState = await redis.get(key);
      if (roomState) {
        const state: RoomState = JSON.parse(roomState);
        state.users = state.users.filter((id) => id !== socket.id);
        if (state.users.length === 0) {
          await redis.del(key);
          console.log(`[socket] Room ${key.replace('room:', '')} deleted (empty)`);
        } else {
          await redis.set(key, JSON.stringify(state), { EX: 24 * 60 * 60 });
          io.to(key.replace('room:', '')).emit('updateState', state);
        }
      }
    }
    console.log(`[socket] User disconnected: ${socket.id}`);
  });
});

setInterval(async () => {
  for (const key of await redis.keys('room:*')) {
    const roomState = await redis.get(key);
    if (roomState) {
      const state: RoomState = JSON.parse(roomState);
      io.to(key.replace('room:', '')).emit('updateState', state);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[server] Socket server running on port ${PORT}`));
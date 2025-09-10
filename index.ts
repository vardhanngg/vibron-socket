import express, { Request, Response } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { createClient, RedisClientType } from 'redis';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://vibronmax.vercel.app',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Health check endpoint to prevent spin-down
app.get('/healthz', (req: Request, res: Response) => res.status(200).send('OK'));

// Initialize Redis
const redis: RedisClientType = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err: Error) => console.error('[redis] Error:', err));

// Wrap top-level async code
async function initializeRedis() {
  try {
    await redis.connect();
    console.log('[redis] Connected successfully');
  } catch (err) {
    console.error('[redis] Connection failed:', err);
    process.exit(1);
  }
}
initializeRedis();

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

io.on('connection', (socket: Socket) => {
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
    try {
      await redis.set(`room:${roomId}`, JSON.stringify(roomState), { EX: 24 * 60 * 60 });
      socket.join(roomId);
      socket.emit('roomCreated', roomId);
      console.log(`[socket] Room created: ${roomId}, Mood Mode: ${isMoodMode}`);
    } catch (err) {
      console.error('[redis] Error creating room:', err);
      socket.emit('error', 'Failed to create room');
    }
  });

  socket.on('joinRoom', async (roomId: string) => {
    if (typeof roomId !== 'string' || !/^[a-z0-9]{6}$/.test(roomId)) {
      socket.emit('error', 'Invalid room ID');
      return;
    }
    try {
      const roomStateStr = await redis.get(`room:${roomId}`);
      if (roomStateStr) {
        const state: RoomState = JSON.parse(roomStateStr) as RoomState;
        state.users.push(socket.id);
        await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
        socket.join(roomId);
        socket.emit('roomJoined', { roomId, state });
        console.log(`[socket] User ${socket.id} joined room ${roomId}`);
      } else {
        socket.emit('error', 'Room not found');
      }
    } catch (err) {
      console.error('[redis] Error joining room:', err);
      socket.emit('error', 'Failed to join room');
    }
  });

  socket.on('playPause', async ({ roomId, isPlaying, currentTime }: { roomId: string; isPlaying: boolean; currentTime: number }) => {
    try {
      const roomStateStr = await redis.get(`room:${roomId}`);
      if (roomStateStr && socket.id === JSON.parse(roomStateStr).leaderId) {
        const state: RoomState = JSON.parse(roomStateStr) as RoomState;
        state.isPlaying = isPlaying;
        state.currentTime = currentTime;
        await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
        io.to(roomId).emit('updateState', state);
        console.log(`[socket] Room ${roomId} play/pause: ${isPlaying}, time: ${currentTime}`);
      } else {
        socket.emit('error', 'Only the room leader can control playback');
      }
    } catch (err) {
      console.error('[redis] Error updating play/pause:', err);
      socket.emit('error', 'Failed to update playback');
    }
  });

  socket.on('changeSong', async ({ roomId, songUrl, songId, title, artist, image }: { roomId: string; songUrl: string; songId: string; title?: string; artist?: string; image?: string }) => {
    try {
      const roomStateStr = await redis.get(`room:${roomId}`);
      if (roomStateStr && socket.id === JSON.parse(roomStateStr).leaderId) {
        const state: RoomState = JSON.parse(roomStateStr) as RoomState;
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
    } catch (err) {
      console.error('[redis] Error changing song:', err);
      socket.emit('error', 'Failed to change song');
    }
  });

  socket.on('changeMoodSong', async ({ roomId, songUrl, songId, mood, language, title, artist }: { roomId: string; songUrl: string; songId: string; mood: string; language: string; title?: string; artist?: string }) => {
    try {
      const roomStateStr = await redis.get(`room:${roomId}`);
      if (roomStateStr && socket.id === JSON.parse(roomStateStr).leaderId) {
        const state: RoomState = JSON.parse(roomStateStr) as RoomState;
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
    } catch (err) {
      console.error('[redis] Error changing mood song:', err);
      socket.emit('error', 'Failed to change mood song');
    }
  });

  socket.on('seek', async ({ roomId, currentTime }: { roomId: string; currentTime: number }) => {
    try {
      const roomStateStr = await redis.get(`room:${roomId}`);
      if (roomStateStr && socket.id === JSON.parse(roomStateStr).leaderId) {
        const state: RoomState = JSON.parse(roomStateStr) as RoomState;
        state.currentTime = currentTime;
        await redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 24 * 60 * 60 });
        io.to(roomId).emit('updateState', state);
        console.log(`[socket] Room ${roomId} seeked to: ${currentTime}`);
      } else {
        socket.emit('error', 'Only the room leader can seek');
      }
    } catch (err) {
      console.error('[redis] Error seeking:', err);
      socket.emit('error', 'Failed to seek');
    }
  });

  socket.on('disconnect', async () => {
    try {
      const keys = await redis.keys('room:*');
      for (const key of keys) {
        const roomStateStr = await redis.get(key);
        if (roomStateStr) {
          const state: RoomState = JSON.parse(roomStateStr) as RoomState;
          state.users = state.users.filter((id) => id !== socket.id);
          if (state.leaderId === socket.id && state.users.length > 0) {
            state.leaderId = state.users[0];
            console.log(`[socket] Room ${key.replace('room:', '')} leader reassigned to ${state.leaderId}`);
          }
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
    } catch (err) {
      console.error('[redis] Error handling disconnect:', err);
    }
  });
});

setInterval(async () => {
  try {
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const roomStateStr = await redis.get(key);
      if (roomStateStr) {
        const state: RoomState = JSON.parse(roomStateStr) as RoomState;
        io.to(key.replace('room:', '')).emit('updateState', state);
      }
    }
  } catch (err) {
    console.error('[redis] Error in periodic sync:', err);
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[server] Socket server running on port ${PORT}`));
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '.env.local' });

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = process.env.PORT || 3001;

// Initialize Express app
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

app.get('/', (req, res) => {
  res.send('✅ Standalone Chat Server is Running!');
});

const server = http.createServer(app);

// MongoDB connection setup
let db;
let mongoClient;

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('Please add your MongoDB URI to .env.local');
  }

  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    await mongoClient.connect();
    db = mongoClient.db('speicher');
    console.log('✅ Connected to MongoDB');

    await db.admin().ping();
    console.log('✅ MongoDB connection verified');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    throw error;
  }
};

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('🔄 Shutting down gracefully...');
  if (mongoClient) {
    try {
      await mongoClient.close();
      console.log('✅ MongoDB connection closed');
    } catch (error) {
      console.error('❌ Error closing MongoDB connection:', error);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

(async () => {
  try {
    await connectDB();

    const io = new Server(server, {
      cors: {
        origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
      upgradeTimeout: 30000,
      maxHttpBufferSize: 1e6,
    });

    io.on('connection', (socket) => {
      console.log(`🔌 Client connected: ${socket.id}`);
      socket.clientType = null;
      socket.joinedSessions = new Set();

      const handleSocketError = (eventName, error) => {
        console.error(`❌ Socket error in ${eventName}:`, error);
        socket.emit('session-error', {
          event: eventName,
          message: error.message || 'An unexpected error occurred',
          timestamp: new Date().toISOString(),
        });
      };

      socket.on('register-client', (clientData) => {
        try {
          if (!clientData || !clientData.type) throw new Error('Invalid client registration data');

          socket.clientType = clientData.type;
          console.log(`📋 Client ${socket.id} registered as ${clientData.type}`);

          if (clientData.type === 'dashboard') {
            socket.join('dashboard-clients');
            console.log(`📊 Dashboard client ${socket.id} joined dashboard room`);
          }

          socket.emit('client-registered', {
            clientId: socket.id,
            type: clientData.type,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          handleSocketError('register-client', error);
        }
      });

      socket.on('join-session', (sessionId, callback) => {
        try {
          if (!sessionId || typeof sessionId !== 'string') throw new Error('Invalid session ID');

          socket.join(sessionId);
          socket.joinedSessions.add(sessionId);
          console.log(`📥 Socket ${socket.id} joined session ${sessionId}`);

          const response = { sessionId, success: true, timestamp: new Date().toISOString() };
          if (callback) callback(response);
          else socket.emit('joined-session', response);
        } catch (error) {
          const errorResponse = {
            sessionId,
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          };
          if (callback) callback(errorResponse);
          else handleSocketError('join-session', error);
        }
      });

      socket.on('create-session', async (sessionData, callback) => {
        try {
          if (!sessionData || !sessionData.id || !sessionData.userEmail)
            throw new Error('Invalid session data: missing required fields');

          console.log('📝 Creating session:', sessionData.id);

          const existingSession = await db.collection('chatSessions').findOne({ id: sessionData.id });
          if (existingSession) throw new Error('Session already exists');

          const sessionDocument = {
            ...sessionData,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          const result = await db.collection('chatSessions').insertOne(sessionDocument);
          const newSession = { _id: result.insertedId.toString(), ...sessionDocument };

          socket.join(sessionData.id);
          socket.joinedSessions.add(sessionData.id);

          io.to('dashboard-clients').emit('new-chat-session', newSession);
          console.log('📢 Notified dashboard clients of new session:', newSession.id);

          const response = { session: newSession, success: true, timestamp: new Date().toISOString() };
          if (callback) callback(response);
          else socket.emit('session-created', response);
        } catch (error) {
          console.error('❌ Error creating chat session:', error);
          const errorResponse = {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          };
          if (callback) callback(errorResponse);
          else handleSocketError('create-session', error);
        }
      });

      socket.on('send-message', async (messageData, callback) => {
        try {
          if (!messageData || !messageData.sessionId || !messageData.message || !messageData.sender)
            throw new Error('Invalid message data: missing required fields');

          console.log('💬 Sending message to session:', messageData.sessionId);
          const session = await db.collection('chatSessions').findOne({ id: messageData.sessionId });
          if (!session) throw new Error('Session not found');
          if (session.status === 'closed') throw new Error('Cannot send message to closed session');

          if (messageData.id) {
            const existingMessage = await db.collection('chatMessages').findOne({ id: messageData.id });
            if (existingMessage) {
              console.log('⚠️ Duplicate message detected:', messageData.id);
              const response = { success: true, message: existingMessage, duplicate: true };
              if (callback) callback(response);
              return;
            }
          }

          const serverTimestamp = new Date().toISOString();
          const messageDocument = {
            ...messageData,
            createdAt: serverTimestamp,
            serverReceivedAt: serverTimestamp,
          };

          const result = await db.collection('chatMessages').insertOne(messageDocument);
          const newMessage = { _id: result.insertedId.toString(), ...messageDocument };

          io.to(messageData.sessionId).emit('new-message', newMessage);
          await db.collection('chatSessions').updateOne(
            { id: messageData.sessionId },
            { $set: { updatedAt: serverTimestamp } }
          );

          console.log('✅ Message delivered to session:', messageData.sessionId);
          const response = { success: true, message: newMessage, timestamp: serverTimestamp };
          if (callback) callback(response);
        } catch (error) {
          console.error('❌ Error sending message:', error);
          const errorResponse = { success: false, error: error.message, timestamp: new Date().toISOString() };
          if (callback) callback(errorResponse);
          else handleSocketError('send-message', error);
        }
      });

      socket.on('agent-join-session', async (data, callback) => {
        try {
          if (!data || !data.sessionId || !data.agentId || !data.agentName)
            throw new Error('Invalid agent join data: missing required fields');

          console.log('👤 Agent joining session:', data.sessionId);
          const session = await db.collection('chatSessions').findOne({ id: data.sessionId });
          if (!session) throw new Error('Session not found');
          if (session.status === 'active') throw new Error('Session already active');
          if (session.status === 'closed') throw new Error('Session closed');

          const updateResult = await db.collection('chatSessions').updateOne(
            { id: data.sessionId, status: 'waiting' },
            {
              $set: {
                status: 'active',
                agentId: data.agentId,
                agentName: data.agentName,
                updatedAt: new Date().toISOString(),
              },
            }
          );

          if (updateResult.matchedCount === 0)
            throw new Error('Session not available for joining');

          socket.join(data.sessionId);
          socket.joinedSessions.add(data.sessionId);
          const updatedSession = await db.collection('chatSessions').findOne({ id: data.sessionId });

          io.to(data.sessionId).emit('agent-joined', {
            sessionId: data.sessionId,
            agentId: data.agentId,
            agentName: data.agentName,
            timestamp: new Date().toISOString(),
          });

          io.to('dashboard-clients').emit('session-updated', {
            session: updatedSession,
            timestamp: new Date().toISOString(),
          });

          const response = { success: true, session: updatedSession };
          if (callback) callback(response);
        } catch (error) {
          console.error('❌ Error agent joining session:', error);
          const errorResponse = {
            success: false,
            error: error.message,
            sessionId: data?.sessionId,
          };
          if (callback) callback(errorResponse);
          else handleSocketError('agent-join-session', error);
        }
      });

      socket.on('close-session', async (sessionId) => {
        try {
          if (!sessionId || typeof sessionId !== 'string') throw new Error('Invalid session ID');

          console.log('🔒 Closing session:', sessionId);
          const updateResult = await db.collection('chatSessions').updateOne(
            { id: sessionId },
            { $set: { status: 'closed', updatedAt: new Date().toISOString() } }
          );

          if (updateResult.matchedCount === 0) throw new Error('Session not found');
          io.to(sessionId).emit('session-closed', { sessionId });
        } catch (error) {
          handleSocketError('close-session', error);
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id}, reason: ${reason}`);
        if (socket.joinedSessions) socket.joinedSessions.clear();
      });

      socket.on('error', (error) => {
        console.error(`❌ Socket error for ${socket.id}:`, error);
      });
    });

    server.listen(port, hostname, () => {
      console.log(`🚀 Standalone server running at http://${hostname}:${port}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
})();


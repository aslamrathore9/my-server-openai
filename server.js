import dotenv from "dotenv";
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config();

// ==========================================
// CONSTANTS & CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_REALTIME = "gpt-4o-mini-realtime-preview";
const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${MODEL_REALTIME}`;

const SYSTEM_INSTRUCTIONS = `You are an English-speaking partner. Your job is to:

1. Listen to the user's spoken sentence.
2. Check how incorrect the grammar is.
3. If the user's sentence has only a small mistake — DO NOT correct it. Just reply normally.
4. If the user's sentence has big/clear grammar mistakes — do two things:
     A) First, provide the corrected sentence in this format:
        "You can say: <corrected sentence>"
     B) Then give a natural conversational reply.

5. Always be friendly, short, and conversational.
6. Only correct when needed.
7. If unclear, ask for clarification.

Output format for correction:
You can say: "Corrected sentence"
<Reply>

Output format for normal reply:
<Reply>

CRITICAL RULES FOR AUDIO:
1. Never treat your own generated audio as user input.
2. Only respond to real human speech.
3. Stop speaking immediately if interrupted.`;

/**
 * Creates the initial session configuration for OpenAI
 */
const createSessionConfig = () => ({
  type: 'session.update',
  session: {
    modalities: ['text', 'audio'],
    input_audio_transcription: { model: 'whisper-1' },
    voice: 'alloy',
    output_audio_format: 'pcm16',
    instructions: SYSTEM_INSTRUCTIONS,
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500
    }
  }
});

// ==========================================
// SERVER SETUP
// ==========================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Minimal Health Check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ==========================================
// WEBSOCKET HANDLER
// ==========================================
wss.on('connection', (clientWs) => {
  console.log("Client connected. Initializing OpenAI Realtime...");

  let openaiWs = null;
  let isConnected = false;
  let retryCount = 0;
  const MAX_RETRIES = 5;

  const connectToOpenAI = () => {
    try {
      openaiWs = new WebSocket(OPENAI_WS_URL, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      openaiWs.on('open', () => {
        console.log("Connected to OpenAI Realtime.");
        isConnected = true;
        retryCount = 0;
        openaiWs.send(JSON.stringify(createSessionConfig()));
      });

      openaiWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
      });

      openaiWs.on('error', (e) => console.error("OpenAI WS Error:", e.message));

      openaiWs.on('close', () => {
        console.log("OpenAI WS Closed.");
        isConnected = false;
        handleReconnect();
      });

    } catch (e) {
      console.error("Connection setup error:", e);
      closeClient(1011, "Internal Error");
    }
  };

  const handleReconnect = () => {
    if (clientWs.readyState === WebSocket.OPEN && retryCount < MAX_RETRIES) {
      retryCount++;
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
      console.log(`Reconnecting to OpenAI in ${delay}ms (Attempt ${retryCount}/${MAX_RETRIES})...`);
      setTimeout(connectToOpenAI, delay);
    } else {
      closeClient(1011, "OpenAI Service Unavailable");
    }
  };

  const closeClient = (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
  };

  // Start Connection
  connectToOpenAI();

  // Handle Client Messages
  clientWs.on('message', (message) => {
    if (!isConnected || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    try {
      const msgStr = message.toString();
      // Send JSON control messages directly, wrap binary audio in event
      if (msgStr.trim().startsWith('{')) {
        openaiWs.send(msgStr);
      } else {
        const audioBase64 = message.toString('base64');
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audioBase64
        }));
      }
    } catch (e) {
      console.error("Relay error:", e);
    }
  });

  clientWs.on('close', () => {
    console.log("Client disconnected.");
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket Server running on port ${PORT}`);
});

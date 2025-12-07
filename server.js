import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";

import OpenAI from "openai";
import pkg from "agora-access-token";
const { RtcTokenBuilder, RtcRole } = pkg;

const app = express();
const port = process.env.PORT || 3000;

// Agora configuration
// Get these from: https://console.agora.io/
const AGORA_APP_ID = process.env.AGORA_APP_ID || "744d03da04924c529c29920155b46765"; // Using the ID found in previous docs
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "dummy_cert"; // Needs real cert for production

// Middleware
app.use(cors());
app.use(express.json());

// File upload
const upload = multer({ storage: multer.memoryStorage() });

// New OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// TRANSCRIBE ENDPOINT with optimization and validation
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  console.log('File info:', req.file);

  try {
    // Validation: Check if file exists
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    // Validation: File size limit (5 MB max for fast uploads)
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
    if (req.file.size > MAX_FILE_SIZE) {
      fs.unlinkSync(req.file.path); // Clean up
      return res.status(400).json({
        error: `File too large: ${(req.file.size / 1024 / 1024).toFixed(2)} MB. Maximum allowed: 5 MB. Please record shorter clips (max 30 seconds).`
      });
    }

    // Validation: Minimum file size (prevent empty/corrupt files)
    if (req.file.size < 1000) { // Less than 1 KB is suspicious
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Audio file appears to be empty or corrupted" });
    }

    // Detect and handle file extension based on mimetype or original filename
    let fileExtension = 'wav';
    const originalName = req.file.originalname?.toLowerCase() || '';
    const mimetype = req.file.mimetype?.toLowerCase() || '';

    // Supported formats by OpenAI Whisper
    if (originalName.includes('.ogg') || originalName.includes('.opus') || mimetype.includes('ogg') || mimetype.includes('opus')) {
      fileExtension = 'ogg';
    } else if (originalName.includes('.flac') || mimetype.includes('flac')) {
      fileExtension = 'flac';
    } else if (originalName.includes('.mp3') || mimetype.includes('mp3')) {
      fileExtension = 'mp3';
    } else if (originalName.includes('.m4a') || mimetype.includes('m4a')) {
      fileExtension = 'm4a';
    } else {
      fileExtension = 'wav'; // Default to WAV
    }

    // Estimate duration for logging (rough estimate: 16kHz mono 16-bit = 32KB per second)
    const estimatedDuration = Math.round((req.file.size / 32000) * 100) / 100;
    console.log(`Processing audio (RAM): ${(req.file.size / 1024).toFixed(2)} KB, estimated duration: ~${estimatedDuration}s`);

    // Create a File object-like structure that OpenAI accepts
    // We can use the 'toFile' helper from OpenAI if available, or just construct a Blob/File if Node environment supports it.
    // However, the simplest way compatible with the v4 SDK that expects a 'file' argument is to pass a ReadStream if using 'fs',
    // OR use the 'toFile' helper from openai/uploads.

    // Since we are in Node and want to avoid disk I/O, we can convert the buffer to a helper file object.
    const file = await OpenAI.toFile(req.file.buffer, `audio.${fileExtension}`, { type: mimetype || 'audio/wav' });

    const openaiResponse = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
    });

    res.json({ text: openaiResponse.text });
  } catch (e) {
    console.error('Transcription error:', e);
    res.status(500).json({ error: e.message });
  }
});

// TTS (Text-to-Speech) ENDPOINT
app.post('/tts', async (req, res) => {
  try {
    const { model = "tts-1", voice = "alloy", input } = req.body;

    if (!input) {
      return res.status(400).json({ error: "Text input is required" });
    }

    // Call OpenAI TTS API with streaming
    const response = await openai.audio.speech.create({
      model: model,
      voice: voice,
      input: input,
      response_format: 'mp3',
    });

    // Set headers for partial content / streaming
    res.setHeader('Content-Type', 'audio/mpeg');

    // Pipe the stream directly to the response
    // For Node-compatible formatting from OpenAI V4 SDK:
    const stream = response.body;
    stream.pipe(res);
  } catch (e) {
    console.error('TTS error:', e);
    res.status(500).json({ error: e.message });
  }
});

// CHAT ENDPOINT
app.post("/chat", async (req, res) => {
  try {
    const { userText, conversationHistory } = req.body;

    const systemPrompt = `You are a friendly English tutor helping a student practice speaking English through natural conversation.

CRITICAL: You MUST ALWAYS respond in this EXACT format (no exceptions):

Corrected: [the corrected version of the user's sentence]
Reply: [your short conversational reply]

IMPORTANT RULES:
1. ALWAYS start with "Corrected:" followed by the corrected sentence
2. ALWAYS follow with "Reply:" followed by your response
3. If the user's sentence is already correct, repeat it exactly in the "Corrected:" line
4. Keep replies short (1-2 sentences maximum)
5. Be warm, encouraging, and supportive
6. Maintain conversation context from previous messages

Example format:
Corrected: How are you doing today?
Reply: I'm doing great! How about you? What are you up to?

REMEMBER: Your response MUST start with "Corrected:" and include "Reply:" - this format is mandatory!`;

    let messages = [{ role: "system", content: systemPrompt }];

    // OPTIMIZATION: Limit conversation history to reduce cost and improve performance
    // Only keep the most recent conversation turns for context
    // Configurable via environment variable (default: 5 turns - optimal for sentence corrections)
    const MAX_HISTORY_TURNS = parseInt(process.env.MAX_CONVERSATION_HISTORY_TURNS || "5", 10);

    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      // Take only the last MAX_HISTORY_TURNS turns
      const limitedHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);

      console.log(`Conversation history: ${conversationHistory.length} turns, using last ${limitedHistory.length} turns`);

      limitedHistory.forEach((turn) => {
        // Truncate very long messages to prevent excessive tokens
        const MAX_MESSAGE_LENGTH = 500; // characters
        const userMsg = turn.user && turn.user.length > MAX_MESSAGE_LENGTH
          ? turn.user.substring(0, MAX_MESSAGE_LENGTH) + "..."
          : turn.user;
        const aiMsg = turn.ai && turn.ai.length > MAX_MESSAGE_LENGTH
          ? turn.ai.substring(0, MAX_MESSAGE_LENGTH) + "..."
          : turn.ai;

        messages.push({ role: "user", content: userMsg });
        messages.push({ role: "assistant", content: aiMsg });
      });

      // Log token estimation (rough: ~4 characters per token)
      const estimatedTokens = messages.reduce((sum, msg) => sum + (msg.content?.length || 0) / 4, 0);
      console.log(`Estimated tokens: ~${Math.round(estimatedTokens)} (history: ${limitedHistory.length} turns)`);
    }

    messages.push({ role: "user", content: userText });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7, // Lower temperature for more consistent format following
      max_tokens: 200, // Limit response length to keep it concise
    });

    const content = completion.choices[0].message.content;

    // More robust parsing with multiple fallback strategies
    let corrected = "";
    let reply = "";

    // Strategy 1: Look for explicit "Corrected:" and "Reply:" labels
    const correctedMatch = /Corrected:\s*([\s\S]*?)(?=\s*Reply:|$)/i.exec(content);
    const replyMatch = /Reply:\s*([\s\S]*?)$/i.exec(content);

    if (correctedMatch && replyMatch) {
      corrected = correctedMatch[1].trim();
      reply = replyMatch[1].trim();
    } else {
      // Strategy 2: If format not found, try to extract from lines
      const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().startsWith('corrected:')) {
          corrected = lines[i].substring(10).trim();
        } else if (lines[i].toLowerCase().startsWith('reply:')) {
          reply = lines[i].substring(6).trim();
          // Also check next lines in case reply spans multiple lines
          if (reply === "" && i + 1 < lines.length) {
            reply = lines.slice(i + 1).join(' ').trim();
          }
          break;
        }
      }

      // Strategy 3: If still no format, use the original text as corrected and entire response as reply
      if (!corrected && !reply) {
        corrected = userText; // Fallback to original user text
        reply = content.trim();
        console.warn('Warning: AI response did not follow format. Using fallback parsing.');
      }
    }

    // Final validation - ensure we have at least something
    if (!corrected || corrected.length === 0) {
      corrected = userText; // Fallback to original if empty
    }
    if (!reply || reply.length === 0) {
      reply = content.trim() || "I understand!"; // Fallback reply
    }

    res.json({
      corrected: corrected,
      reply: reply,
      raw: content
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CONVERSE ENDPOINT (One-Shot: Audio -> Audio)
// Combines Transcribe + Chat + TTS for lowest latency
app.post('/converse', upload.single('audio'), async (req, res) => {
  try {
    console.log(`Converse Request received`);

    // 1. Transcribe
    if (!req.file) return res.status(400).json({ error: "No audio file" });

    // Quick validation
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ error: "File too large" });

    const file = await OpenAI.toFile(req.file.buffer, "audio.wav");

    // Start Transcription
    const transcriptResponse = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
    });

    const userText = transcriptResponse.text;
    console.log(`Transcribed: "${userText}"`);

    // 2. Set Header for Client UI (Instant "You said")
    // Use Base64 to avoid encoding issues with special chars
    res.setHeader('X-Transcript-B64', Buffer.from(userText).toString('base64'));
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');

    // 3. Chat & Stream
    // Parse history from body text field (Multer puts text fields in req.body)
    let conversationHistory = [];
    try {
      if (req.body.conversationHistory) {
        conversationHistory = JSON.parse(req.body.conversationHistory);
      }
    } catch (e) { console.warn("History parse error", e); }

    const messages = [{
      role: "system",
      content: `You are a friendly English tutor. Respond with a short conversational reply only. No corrections. Keep it natural and under 2 sentences.`
    }];

    // Add history
    const MAX_HISTORY_TURNS = 5;
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      conversationHistory.slice(-MAX_HISTORY_TURNS).forEach(t => {
        messages.push({ role: "user", content: t.user });
        messages.push({ role: "assistant", content: t.ai });
      });
    }
    messages.push({ role: "user", content: userText });

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      stream: true,
      max_tokens: 200,
    });

    let sentenceBuffer = "";

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || "";
      sentenceBuffer += token;

      if (/[.?!]\s/.test(sentenceBuffer) || (sentenceBuffer.length > 50 && /[.?!]$/.test(sentenceBuffer))) {
        const sentence = sentenceBuffer.trim();
        if (sentence.length > 0) {
          console.log(`Converse TTS: "${sentence}"`);
          await streamTtsToResponse(sentence, res);
          sentenceBuffer = "";
        }
      }
    }

    if (sentenceBuffer.trim().length > 0) {
      console.log(`Converse TTS (Final): "${sentenceBuffer}"`);
      await streamTtsToResponse(sentenceBuffer, res);
    }

    res.end();

  } catch (e) {
    console.error('Converse Error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
});

// SMART STREAMING ENDPOINT for low latency (<4s)
// 1. Streams text from GPT-4
// 2. Detects 'Reply:'
// 3. Sentences are sent to TTS immediately
// 4. Audio is streamed back to client
app.post('/chat-audio-stream', async (req, res) => {
  try {
    const { userText, conversationHistory } = req.body;
    console.log(`Smart Stream Request: "${userText}"`);

    // Prepare messages
    const systemPrompt = `You are a friendly English tutor.
CRITICAL: You MUST ALWAYS respond with a short conversational reply only.
Rules:
1. Do NOT provide corrections.
2. Keep replies short (1-2 sentences).
3. Be natural and encouraging.`;

    let messages = [{ role: "system", content: systemPrompt }];

    // History handling (same as before)
    const MAX_HISTORY_TURNS = 5;
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      const limited = conversationHistory.slice(-MAX_HISTORY_TURNS);
      limited.forEach(t => {
        messages.push({ role: "user", content: t.user });
        messages.push({ role: "assistant", content: t.ai });
      });
    }
    messages.push({ role: "user", content: userText });

    // Header for streaming audio
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');

    // State machine for parsing
    let buffer = "";
    let isReply = false;
    let sentenceBuffer = "";
    let correctedSentence = ""; // We might want to send this back in a header or separate event, but for now we focus on audio.
    // Actually, client needs the text too.
    // PROBLEM: We are streaming AUDIO data. We can't easily mix JSON text data in the same stream without a custom protocol.
    // COMPROMISE: We will log the text on server, and maybe send it as a custom HTTP header at the end?
    // No, HTTP headers must be sent first.
    // SOLUTION for now: We only stream audio. The client will just play audio.
    // The "transcript" update on UI will be delayed or we can use a separate call?
    // OR: We can use Multipart response? Too complex for Android client.
    // SIMPLEST: This endpoint returns AUDIO. The client updates UI with "Listening..." -> "Playing...".
    // We lose the text display update for "Corrected" text immediately, but we gain speed.
    // We can send the "Corrected" and "Reply" text in a HEADER if it's short enough?
    // Yes, we can set headers before the first audio chunk if we buffer just enough to find the "Corrected" part.
    // GPT-4 generates "Corrected:" FIRST. So we can grab that, set header, then stream audio.

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      stream: true,
      max_tokens: 200,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || "";
      buffer += token;
      sentenceBuffer += token;

      // Detect sentence end (. ? !)
      if (/[.?!]\s/.test(sentenceBuffer) || (sentenceBuffer.length > 50 && /[.?!]$/.test(sentenceBuffer))) {
        const sentence = sentenceBuffer.trim();
        if (sentence.length > 0) {
          console.log(`TTS Processing: "${sentence}"`);
          await streamTtsToResponse(sentence, res);
          sentenceBuffer = "";
        }
      }
    }

    // Process remaining buffer
    // Process remaining buffer
    if (sentenceBuffer.trim().length > 0) {
      console.log(`TTS Processing (Final): "${sentenceBuffer}"`);
      await streamTtsToResponse(sentenceBuffer, res);
    }

    // Add valid JSON object at the end? No, MP3 stream.
    res.end();

  } catch (e) {
    console.error('Smart Stream Error:', e);
    // If headers sent, we can't send JSON error.
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.end();
    }
  }
});

// Helper to send TTS audio to response stream
async function streamTtsToResponse(text, res) {
  try {
    const mp3Response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
      response_format: "mp3"
    });

    // We get a ReadableStream (web standard) or buffer.
    // V4 SDK returns a Response-like object.
    // We can get buffer() or body (stream).
    const buffer = Buffer.from(await mp3Response.arrayBuffer());
    res.write(buffer);
    // Note: We are writing MP3 frames back-to-back.
    // Most players (ExoPlayer, VLC) handle concatenated MP3s fine!
  } catch (e) {
    console.error("TTS Segment Error:", e);
  }
}

/**
 * AGORA TOKEN GENERATION ENDPOINT (Optional - for production)
 *
 * This endpoint generates Agora RTC tokens for secure channel access.
 * In production, use tokens instead of joining channels without authentication.
 *
 * GET /agora/token?channelName=<channel>&uid=<uid>
 *
 * Returns: { token: string, appId: string, channelName: string, uid: number }
 */
app.get('/agora/token', (req, res) => {
  try {
    const channelName = req.query.channelName || `channel-${Date.now()}`;
    const uid = parseInt(req.query.uid) || 0;
    const expirationTimeInSeconds = 3600; // Token valid for 1 hour

    // If Agora credentials are not configured, return error
    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
      return res.status(500).json({
        error: "Agora credentials not configured. Set AGORA_APP_ID and AGORA_APP_CERTIFICATE environment variables."
      });
    }

    // Generate token
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER, // Role: PUBLISHER can publish and subscribe
      privilegeExpiredTs
    );

    res.json({
      token: token,
      appId: AGORA_APP_ID,
      channelName: channelName,
      uid: uid,
      expirationTime: privilegeExpiredTs
    });
  } catch (e) {
    console.error('Agora token generation error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    agoraConfigured: !!(AGORA_APP_ID && AGORA_APP_CERTIFICATE)
  });
});

// ==========================================
// REALTIME WEBSOCKET SETUP
// ==========================================
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// Create HTTP server from Express app
const server = http.createServer(app);

// Attach WebSocket Server to the same HTTP server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log("Client connected to WebSocket");

  let isOpenAIConnected = false;

  // Connect to OpenAI Realtime API
  // Updated to latest model version (as of December 2024)
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
  const openaiWs = new WebSocket(url, {
    headers: {
      "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Relay: Client -> OpenAI
  ws.on('message', (message) => {
    try {
      if (!isOpenAIConnected) {
        console.log("Buffering message until OpenAI connects...");
        return; // Or buffer? For simplicity, we drop or client should wait.
      }

      const msgStr = message.toString();
      // Check if it's raw binary data?
      // Our client sends raw bytes.
      // BUT the WS lib usually gives us a Buffer.
      // If it's a Buffer, we assume it's audio.

      // However, we need to wrap it in the JSON event for OpenAI: 'input_audio_buffer.append'
      // If the client implemented `sendRealtimeAudio` sending raw bytes:
      if (Buffer.isBuffer(message) || (typeof message !== 'string' && !msgStr.trim().startsWith('{'))) {
        // It's likely audio bytes
        const audioBase64 = message.toString('base64');
        const audioEvent = {
          type: 'input_audio_buffer.append',
          audio: audioBase64
        };
        openaiWs.send(JSON.stringify(audioEvent));
      } else {
        // It's likely a JSON control message (if we implement those later)
        // Check if it's valid JSON
        if (msgStr.trim().startsWith('{')) {
          openaiWs.send(msgStr);
        }
      }
    } catch (e) {
      console.error("Relay error client->openai", e);
    }
  });

  // Relay: OpenAI -> Client
  openaiWs.on('open', () => {
    console.log("Connected to OpenAI Realtime");
    isOpenAIConnected = true;

    // Initialize Session
    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_transcription: {
          model: 'whisper-1'
        },
        voice: 'alloy',
        instructions: `You are a friendly English tutor helping students practice speaking English.

CRITICAL RULES - STRICT AUDIO FEEDBACK PREVENTION:
1. NEVER treat the assistant's generated audio or text as user input
2. REJECT any input that matches, resembles, or contains phrases from your last response
3. REJECT input that appears to come from synthetic or non-human speech
4. ONLY accept inputs with clear human vocal patterns, pauses, breathing, or natural noise
5. If detected input has 70% or more similarity to your previous output, IGNORE it entirely
6. Stay SILENT unless real human input is detected
7. Do NOT respond to echoes, playback, or any audio that sounds like your own voice
8. Wait for genuine, new human speech with natural vocal characteristics
9. If unsure whether input is human or synthetic, default to SILENCE

HUMAN SPEECH INDICATORS (Accept only if present):
- Natural pauses and hesitations
- Breathing sounds
- Background noise
- Varied pitch and tone
- Imperfect pronunciation
- Conversational fillers (um, uh, etc.)

REJECT IMMEDIATELY IF:
- Input matches your recent response (even partially)
- Audio sounds too clean/synthetic
- No natural human vocal characteristics
- Repetition of your own words or phrases

CONVERSATION RULES (Only when genuine human input detected):
- Keep replies short, natural, and encouraging (1-2 sentences max)
- Be conversational and supportive
- Help with English practice in a friendly way
- Respond quickly for natural conversation flow`,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    };
    openaiWs.send(JSON.stringify(sessionConfig));
  });

  openaiWs.on('message', (data) => {
    try {
      const eventStr = data.toString();
      // Forward everything to client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(eventStr);
      }
    } catch (e) {
      console.error("Relay error openai->client", e);
    }
  });

  openaiWs.on('error', (e) => console.error("OpenAI WS Error", e));

  openaiWs.on('close', () => {
    console.log("OpenAI WS Closed");
    // Close client too?
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('close', () => {
    console.log("Client disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

// Start the HTTP+WS server
server.listen(port, () => {
  console.log(`Server (HTTP+WS) live on port ${port}`);
  console.log(`Agora configured: ${!!(AGORA_APP_ID && AGORA_APP_CERTIFICATE)}`);
});


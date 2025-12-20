import dotenv from "dotenv";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

dotenv.config();

// ==========================================
// CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// API Configuration
const GPT_MODEL = "gpt-4o-mini";
const TTS_MODEL = "tts-1";
const TTS_VOICE = "alloy"; // alloy, echo, fable, onyx, nova, shimmer

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==========================================
// SESSION STATE
// ==========================================
// Map to hold session data for each connected client
const sessions = new Map();

// VAD Constants (Simple Energy based)
const VAD_THRESHOLD = 0.01;      // Root Mean Square amplitude threshold
const SILENCE_DURATION_MS = 1000; // How long to wait before processing speech
const MAX_RECORDING_MS = 15000;   // Force process after 15s to avoid huge buffers

// ==========================================
// SYSTEM INSTRUCTIONS
// ==========================================
const BASE_SYSTEM_PROMPT = `
You are a helpful and friendly English language tutor named Lyra.
- Your goal is to help the user practice English conversation.
- Keep your responses concise (1-3 sentences) to keep the conversation flowing.
- Correct major grammatical errors gently, but prioritize fluency.
- If the user asks to change the topic, adapt immediately.
- Be encouraging and supportive.
`;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Calculates the Root Mean Square (RMS) amplitude of a PCM buffer.
 * Assumes 16-bit PCM (audio/pcm; rate=16000; channels=1)
 */
function calculateRMS(buffer) {
  if (!buffer || buffer.length === 0) return 0;

  // Create an Int16Array view on the buffer
  // Note: If buffer.length is odd (byte count), we might lose 1 byte at end, which is fine for VAD.
  const numSamples = Math.floor(buffer.length / 2);
  const int16View = new Int16Array(buffer.buffer, buffer.byteOffset, numSamples);

  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    // Normalize to -1.0 ... 1.0 (16-bit signed integer range is -32768 to 32767)
    const sample = int16View[i] / 32768.0;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / numSamples);
}

/**
 * Converts raw PCM16 buffer to a WAV file buffer (in memory)
 * Required because OpenAI Whisper API expects a file format (wav, mp3, ogg, etc.)
 */
function createWavBuffer(pcmData, sampleRate = 16000) {
  const numChannels = 1;
  const bitDepth = 16;

  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const dataSize = pcmData.length;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write("RIFF", 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

// ==========================================
// AUDIO PROCESSING PIPELINE
// ==========================================

async function processAudioPipeline(sessionId, socket) {
  const session = sessions.get(sessionId);
  if (!session || session.audioBuffer.length === 0) return;

  // 1. Prepare Audio
  console.log(`[${sessionId}] Processing Audio Pipeline...`);
  const audioData = Buffer.concat(session.audioBuffer);
  session.audioBuffer = []; // Clear buffer immediately

  // Create WAV file from PCM data
  const wavFile = await OpenAI.toFile(createWavBuffer(audioData, 16000), "input.wav");

  try {
    // 2. Transcription (STT) - Whisper
    console.log(`[${sessionId}] Transcribing...`);
    const transcription = await openai.audio.transcriptions.create({
      file: wavFile,
      model: "whisper-1",
      language: "en"
    });

    const userText = transcription.text.trim();
    console.log(`[${sessionId}] User said: "${userText}"`);

    if (!userText || userText.length < 2) {
      console.log(`[${sessionId}] Transcription empty or too short. Ignoring.`);
      return;
    }

    // Send 'speaking' event to client so they know we heard them
    socket.send(JSON.stringify({ type: "assistant.thinking", text: userText }));

    // 3. Intelligence (LLM) - GPT-4o-mini
    session.history.push({ role: "user", content: userText });

    console.log(`[${sessionId}] Generating response...`);
    const completion = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: "system", content: session.systemPrompt },
        ...session.history
      ],
      max_tokens: 150, // Keep responses short for conversational feel
    });

    const aiText = completion.choices[0].message.content;
    session.history.push({ role: "assistant", content: aiText });
    console.log(`[${sessionId}] AI response: "${aiText}"`);

    // Send text to client immediately (for UI)
    socket.send(JSON.stringify({ type: "assistant.response.text", text: aiText }));

    // 4. Voice (TTS)
    console.log(`[${sessionId}] Generating audio...`);
    const mp3Response = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: aiText,
      response_format: "pcm" // We want raw PCM for easier streaming/playback if possible, but 'pcm' isn't standard in Node SDK?
      // Actually openai.audio.speech supports 'pcm' (raw 16-bit 24kHz pcm).
      // Let's verify documentation memory... yes, 'pcm' is supported.
    });

    const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());

    // 5. Stream Audio Back
    console.log(`[${sessionId}] Sending ${audioBuffer.length} bytes of audio.`);

    // Send a header or just raw data. Let's send a JSON header first, then binary.
    // Actually, to keep it simple, let's send binary frames with a custom prefix or just pure binary if we control the protocol.
    // Better: Send a JSON message saying "Incoming Audio", then send binary chunks.
    // OR: Interleave.
    // Simple approach: Send JSON message "audio_start", then binary, then "audio_end".

    socket.send(JSON.stringify({ type: "assistant.audio.start" }));

    // Gate: Mark AI as speaking so we ignore incoming echoed audio
    session.isAiSpeaking = true;

    // Chunking the response to simulate valid streaming if needed, or just send it all.
    // Sending in 4kb chunks
    const CHUNK_SIZE = 4096;
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      const chunk = audioBuffer.subarray(i, i + CHUNK_SIZE);
      socket.send(chunk);
    }

    socket.send(JSON.stringify({ type: "assistant.audio.end" }));

    // Gate: Unmark AI speaking (allow some buffer for playback to finish on client?)
    setTimeout(() => {
      session.isAiSpeaking = false;
    }, 500);

  } catch (error) {
    console.error(`[${sessionId}] Pipeline Error:`, error);
    socket.send(JSON.stringify({ type: "error", message: "Processing failed" }));
  }
}


// ==========================================
// WEBSOCKET SERVER
// ==========================================
wss.on('connection', (ws, req) => {
  const sessionId = Date.now().toString();
  console.log(`[${sessionId}] Client connected`);

  // Initialize Session
  sessions.set(sessionId, {
    history: [], // Conversation history
    audioBuffer: [], // Buffer for incoming user audio (PCM16 chunks)
    silenceStart: null, // Timestamp when silence began
    silenceStart: null, // Timestamp when silence began
    isSpeaking: false, // Is the user currently speaking?
    isAiSpeaking: false, // Echo Gate
    systemPrompt: BASE_SYSTEM_PROMPT,
    silenceTimer: null // Timeout for silence detection
  });

  ws.on('message', async (message, isBinary) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    if (isBinary) {
      if (session.isAiSpeaking) return; // Echo/Gate check
      // --- AUDIO DATA ---
      // Received Audio Chunk (PCM 16bit, 16kHz, Mono) from Android
      const pcmChunk = message;
      session.audioBuffer.push(pcmChunk);

      // VAD Logic
      const rms = calculateRMS(pcmChunk);

      if (rms > VAD_THRESHOLD) {
        // Speech Detected
        if (!session.isSpeaking) {
          session.isSpeaking = true;
          console.log(`[${sessionId}] Speaking started...`);
          ws.send(JSON.stringify({ type: "vad.speech_start" })); // Tell client to stop playing audio
        }
        session.silenceStart = null;

        // Clear any pending silence timer
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
        }

      } else {
        // Silence Detected
        if (session.isSpeaking && !session.silenceTimer) {
          // Start silence timer
          session.silenceTimer = setTimeout(() => {
            console.log(`[${sessionId}] Silence detected (${SILENCE_DURATION_MS}ms). Processing...`);
            session.isSpeaking = false;
            session.silenceTimer = null;
            ws.send(JSON.stringify({ type: "vad.speech_end" }));

            // Trigger Pipeline
            processAudioPipeline(sessionId, ws);

          }, SILENCE_DURATION_MS);
        }
      }

    } else {
      // --- TEXT / JSON CONTROL MESSAGES ---
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'config') {
          // Update configuration (e.g., topic)
          if (data.topic) {
            console.log(`[${sessionId}] Topic set to: ${data.topic}`);
            session.systemPrompt = BASE_SYSTEM_PROMPT + `\nThe current topic is: ${data.topic}`;
          }
        } else if (data.type === 'greeting') {
          // Generate initial greeting
          console.log(`[${sessionId}] Generating greeting...`);
          // Mock a user "hello" to get things started or just prompt the LLM
          session.history.push({ role: "user", content: "Hello, I am ready to start." });

          // Run pipeline logic partially? No, let's just do a direct completion call
          const completion = await openai.chat.completions.create({
            model: GPT_MODEL,
            messages: [
              { role: "system", content: session.systemPrompt },
              { role: "user", content: "Assume I just joined. Please introduce yourself and the topic briefly." }
            ],
            max_tokens: 100,
          });
          const aiText = completion.choices[0].message.content;
          session.history.push({ role: "assistant", content: aiText });

          ws.send(JSON.stringify({ type: "assistant.response.text", text: aiText }));

          const mp3 = await openai.audio.speech.create({
            model: TTS_MODEL, voice: TTS_VOICE, input: aiText, response_format: "pcm"
          });
          const buffer = Buffer.from(await mp3.arrayBuffer());

          ws.send(JSON.stringify({ type: "assistant.audio.start" }));
          session.isAiSpeaking = true;
          ws.send(buffer); // Send all at once or chunk
          ws.send(JSON.stringify({ type: "assistant.audio.end" }));
          setTimeout(() => { session.isAiSpeaking = false; }, 500);
        }

      } catch (e) {
        console.error(`[${sessionId}] Invalid JSON:`, e);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[${sessionId}] Client disconnected`);
    sessions.delete(sessionId);
  });
});


// ==========================================
// HTTP ROUTES (Health / Legacy)
// ==========================================
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0-standard-api' }));

server.listen(PORT, () => {
  console.log(`Standard API Server running on port ${PORT}`);
});

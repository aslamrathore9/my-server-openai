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
const VAD_THRESHOLD = 0.02;      // Lowered to 0.02 (0.05 was too deaf)
const SILENCE_DURATION_MS = 800;  // Reduced to 0.8s for faster response (saving ~0.4s)
const MAX_RECORDING_MS = 15000;   // Force process after 15s to avoid huge buffers

// ==========================================
// SYSTEM INSTRUCTIONS
// ==========================================
const BASE_SYSTEM_PROMPT = `
You are a helpful and friendly English language tutor named Lyra.
- Your goal is to help the user practice English conversation.
- Keep your responses VERY concise (1 sentence). Speed is priority.
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

  // 1. Prepare Audio (WAV from PCM)
  console.log(`[${sessionId}] Processing Audio Pipeline...`);
  const audioData = Buffer.concat(session.audioBuffer);
  session.audioBuffer = []; // Clear buffer immediately

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
      console.log(`[${sessionId}] Transcription empty/short. Ignoring.`);
      return;
    }

    // Notify client: Thinking with user text
    socket.send(JSON.stringify({ type: "assistant.thinking", text: userText }));
    session.history.push({ role: "user", content: userText });

    // 3. Streaming Intelligence (LLM) & TTS
    console.log(`[${sessionId}] Starting Stream...`);

    const stream = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: "system", content: session.systemPrompt },
        ...session.history
      ],
      max_tokens: 150, // Increase slightly for streaming (sentences)
      stream: true,
    });

    let fullText = "";
    let sentenceBuffer = "";
    let isFirstAudioChunk = true;
    session.isAiSpeaking = true; // Gate early

    // Regex to split sentences (., !, ?, or newlines)
    // We want to capture the delimiter too.
    const sentenceDelimiters = /[.!?\n]+/;

    for await (const chunk of stream) {
      if (session.isSpeaking) {
        // Barge-in detected (User started speaking again), abort stream?
        // For complexity, let's just finish current logic or check flag
        // Ideally breaks, but let's let it flow for now or implement break
      }

      const content = chunk.choices[0]?.delta?.content || "";
      if (!content) continue;

      fullText += content;
      sentenceBuffer += content;

      // Check for sentence completion
      // We look for a delimiter followed by space or end of string logic (but here purely distinct chars)
      // Simple heuristic: If buffer contains a delimiter, split and process

      let match = sentenceBuffer.match(sentenceDelimiters);
      if (match) {
        // Found a sentence end.
        // It's possible we have "Hello! How are..."
        // We want to take "Hello!" and leave " How are..."

        const delimiterIndex = match.index + match[0].length;
        const completeSentence = sentenceBuffer.substring(0, delimiterIndex);
        const remaining = sentenceBuffer.substring(delimiterIndex);

        if (completeSentence.trim().length > 0) {
          console.log(`[${sessionId}] Sentence Ready: "${completeSentence.trim()}"`);

          // Send full text update for UI
          socket.send(JSON.stringify({ type: "assistant.response.text", text: fullText }));

          // Generate TTS for this sentence
          await generateAndStreamTTS(sessionId, socket, completeSentence, isFirstAudioChunk);
          isFirstAudioChunk = false;
        }

        sentenceBuffer = remaining;
      }
    }

    // Process remaining buffer (last sentence, maybe no punctuation)
    if (sentenceBuffer.trim().length > 0) {
      console.log(`[${sessionId}] Final Sentence: "${sentenceBuffer.trim()}"`);
      socket.send(JSON.stringify({ type: "assistant.response.text", text: fullText }));
      await generateAndStreamTTS(sessionId, socket, sentenceBuffer, isFirstAudioChunk);
    }

    // stream finished
    session.history.push({ role: "assistant", content: fullText });
    console.log(`[${sessionId}] Stream Complete. Full response: "${fullText}"`);

    socket.send(JSON.stringify({ type: "assistant.audio.end" }));

    setTimeout(() => {
      session.isAiSpeaking = false;
    }, 500);

  } catch (error) {
    console.error(`[${sessionId}] Pipeline Error:`, error);
    socket.send(JSON.stringify({ type: "error", message: "Processing failed" }));
    session.isAiSpeaking = false;
  }
}

async function generateAndStreamTTS(sessionId, socket, text, isFirst) {
  try {
    const mp3Response = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: "pcm"
    });
    const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());

    if (isFirst) {
      socket.send(JSON.stringify({ type: "assistant.audio.start" }));
    }

    console.log(`[${sessionId}] Streaming TTS (${audioBuffer.length} bytes)`);

    // Send in chunks to avoid overwhelming socket?
    // 4KB chunks is standard
    const CHUNK_SIZE = 4096;
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      const chunk = audioBuffer.subarray(i, i + CHUNK_SIZE);
      socket.send(chunk);
    }

  } catch (e) {
    console.error(`[${sessionId}] TTS Error for "${text}":`, e);
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
           // ... (existing greeting logic)
           console.log(`[${sessionId}] Generating greeting...`);
           // ... (rest of greeting logic)
           session.history.push({ role: "user", content: "Hello, I am ready to start." });
           // ... (rest of logic)

        } else if (data.type === 'request_hint') {
           console.log(`[${sessionId}] Generating hint...`);

           try {
               const completion = await openai.chat.completions.create({
                   model: GPT_MODEL,
                   messages: [
                       { role: "system", content: session.systemPrompt + "\n\nProvide 1 short, simple sentence the user could say next to continue the conversation naturally. Do not start with 'You could say'. Just the sentence." },
                       ...session.history
                   ],
                   max_tokens: 50,
               });

               const hintText = completion.choices[0]?.message?.content?.trim() || "Tell me more about that.";
               console.log(`[${sessionId}] Hint: "${hintText}"`);

               ws.send(JSON.stringify({ type: "hint", suggestion: hintText }));

           } catch (e) {
               console.error(`[${sessionId}] Hint Error:`, e);
           }
        }
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

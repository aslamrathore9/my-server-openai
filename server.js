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
      threshold: 0.8, // Increased to 0.8 to ignore echo/background noise
      prefix_padding_ms: 300,
      silence_duration_ms: 800 // Changed to 800ms to avoid cutting off too early
    }
  }
});

// ==========================================
// SERVER SETUP
// ==========================================
const app = express();
const server = http.createServer(app);

// Minimal Health Check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ==========================================
// EPHEMERAL TOKEN ENDPOINT
// ==========================================
app.get('/session', async (req, res) => {
  try {
    const { topic } = req.query;
    let currentInstructions = SYSTEM_INSTRUCTIONS;

    if (topic) {
        console.log(`Setting up session for topic: ${topic}`);
        switch (topic) {
            case 'daily_routine':
                currentInstructions += "\n\nCONTEXT: The user wants to talk about their daily routine. Ask them about their day, what they do in the morning, etc.";
                break;
            case 'improve_vocabulary':
                currentInstructions += "\n\nCONTEXT: The user wants to improve vocabulary. Use more advanced words in your replies and explain them if needed. Suggest better synonyms for words the user uses.";
                break;
            case 'childhood_memory':
                currentInstructions += "\n\nCONTEXT: The user wants to talk about childhood memories. Ask them about their favorite memory, school days, or friends from childhood.";
                break;
            case 'intro_practice':
                currentInstructions += "\n\nCONTEXT: This is an interview practice. Ask the user to introduce themselves. Provide feedback on their introduction.";
                break;
            case 'career_plans':
                currentInstructions += "\n\nCONTEXT: This is an interview practice. Ask the user about their short-term and long-term career plans.";
                break;
            case 'govt_interview':
                currentInstructions += "\n\nCONTEXT: This is a UPSC (Civil Services) interview practice. Be formal, strict, and ask general knowledge or situational questions. Address the user as 'Candidate'.";
                break;
            case 'job_interview':
                currentInstructions += "\n\nCONTEXT: This is a standard Job Interview practice. Act as a Hiring Manager. Ask about experience, strengths, and weaknesses.";
                break;
            case 'talk_about_anything':
            default:
                // Default context
                break;
        }
    }

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_REALTIME,
        voice: "alloy",
        instructions: currentInstructions,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    res.json(data);

  } catch (e) {
    console.error("Token generation error:", e);
    res.status(500).json({ error: "Failed to generate session token" });
  }
});

server.listen(PORT, () => {
  console.log(`Token Server running on port ${PORT}`);
});

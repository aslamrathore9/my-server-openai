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

const SYSTEM_INSTRUCTIONS = `
English Tutor. Speak ONLY English.
Unclear audio? Say "Could you repeat?".
Don't switch languages.
Fix grammar naturally. Be brief.
`;

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
          currentInstructions += "\nTopic: Daily routine. Stay on topic.";
          break;

        case 'improve_vocabulary':
          currentInstructions += "\nTopic: Vocab. Use better words, explain simply.";
          break;

        case 'childhood_memory':
          currentInstructions += "\nTopic: Childhood memories. Stay on topic.";
          break;

        case 'intro_practice':
          currentInstructions += "\nTopic: Intro practice. Stay on topic.";
          break;

        case 'career_plans':
          currentInstructions += "\nTopic: Career plans. Stay on topic.";
          break;

        case 'govt_interview':
          currentInstructions += "\nTopic: UPSC Interview. Formal. Call user 'Candidate'.";
          break;

        case 'job_interview':
          currentInstructions += "\nTopic: Job interview. Stay on topic.";
          break;

        case 'seasons_weather':
          currentInstructions += "\nTopic: Seasons & Weather. Stay on topic.";
          break;

        case 'family_relationship':
          currentInstructions += "\nTopic: Family & Relationships. Stay on topic.";
          break;

        case 'hobbies_interests':
          currentInstructions += "\nTopic: Hobbies & Interests. Stay on topic.";
          break;

        case 'talk_about_your_workplace':
          currentInstructions += "\nTopic: Workplace. Stay on topic.";
          break;

        case 'talk_about_anything':
        default:
          // No extra context needed
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

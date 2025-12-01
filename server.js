import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// File upload
const upload = multer({ dest: "uploads/" });

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
    let fileExtension = '.wav';
    const originalName = req.file.originalname?.toLowerCase() || '';
    const mimetype = req.file.mimetype?.toLowerCase() || '';

    // Supported formats by OpenAI Whisper
    if (originalName.includes('.ogg') || originalName.includes('.opus') || mimetype.includes('ogg') || mimetype.includes('opus')) {
      fileExtension = '.ogg';
    } else if (originalName.includes('.flac') || mimetype.includes('flac')) {
      fileExtension = '.flac';
    } else if (originalName.includes('.mp3') || mimetype.includes('mp3')) {
      fileExtension = '.mp3';
    } else if (originalName.includes('.m4a') || mimetype.includes('m4a')) {
      fileExtension = '.m4a';
    } else {
      fileExtension = '.wav'; // Default to WAV
    }

    // Rename file with appropriate extension
    const oldPath = req.file.path;
    const newPath = oldPath + fileExtension;
    fs.renameSync(oldPath, newPath);

    // Estimate duration for logging (rough estimate: 16kHz mono 16-bit = 32KB per second)
    const estimatedDuration = Math.round((req.file.size / 32000) * 100) / 100;
    console.log(`Processing audio: ${(req.file.size / 1024).toFixed(2)} KB, estimated duration: ~${estimatedDuration}s`);

    // Warning if estimated duration exceeds 30 seconds (but still process it)
    if (estimatedDuration > 30) {
      console.warn(`Warning: Audio clip is longer than recommended (${estimatedDuration}s). Consider limiting to 30 seconds for better performance.`);
    }

    const fileStream = fs.createReadStream(newPath);

    const openaiResponse = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
    });

    // Clean up temp file
    fs.unlinkSync(newPath);

    res.json({ text: openaiResponse.text });
  } catch (e) {
    // Clean up file on error
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
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

    // Call OpenAI TTS API
    const mp3 = await openai.audio.speech.create({
      model: model,
      voice: voice,
      input: input,
    });

    // Convert response to buffer
    const buffer = Buffer.from(await mp3.arrayBuffer());

    // Set headers for audio response
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);

    // Send audio data
    res.send(buffer);
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

app.listen(port, () => {
  console.log(`Server live on port ${port}`);
});


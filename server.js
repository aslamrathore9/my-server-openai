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

// File uploade
const upload = multer({ dest: "uploads/" });

// New OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// TRANSCRIBE ENDPOINT
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  console.log('File info:', req.file);
  
  try {
    // Ensure .wav extension (critical for OpenAI Whisper)
    const oldPath = req.file.path;
    const newPath = oldPath + '.wav';
    fs.renameSync(oldPath, newPath);

    const fileStream = fs.createReadStream(newPath);

    const openaiResponse = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
    });

    fs.unlinkSync(newPath);
    res.json({ text: openaiResponse.text });
  } catch (e) {
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

    if (Array.isArray(conversationHistory)) {
      conversationHistory.forEach((turn) => {
        messages.push({ role: "user", content: turn.user });
        messages.push({ role: "assistant", content: turn.ai });
      });
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


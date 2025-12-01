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

// TRANSCRIBE ENDPOINT
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const fileStream = fs.createReadStream(filePath);

    const openaiResponse = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
    });

    fs.unlinkSync(filePath);
    res.json({ text: openaiResponse.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CHAT ENDPOINT
app.post("/chat", async (req, res) => {
  try {
    const { userText, conversationHistory } = req.body;

    const systemPrompt = `
You are a friendly English tutor helping a student practice speaking English through natural conversation.

YOUR PERSONALITY:
- Be warm, encouraging, and supportive
- Act like a friendly teacher who genuinely cares
- Keep the conversation natural and flowing
- Show enthusiasm about the student's progress

MAIN TASKS:
1. The user sends a sentence converted from voice using Whisper.
2. First, correct the user's sentence so it becomes natural and proper English.
3. Then generate a conversational reply that:
   - Responds naturally to what they said
   - Gently corrects mistakes (mention briefly if needed)
   - Encourages them to continue
   - Keeps the conversation going

OUTPUT FORMAT (always follow this exactly):
Corrected: <corrected sentence>
Reply: <your conversational reply>

CONVERSATION RULES:
- Keep replies short and natural (1–2 sentences)
- If the sentence is already correct, repeat it as-is in "Corrected:"
- Be encouraging: "Great!", "Nice!", "Well done!"
- Gently point out corrections: "That's close! The correct way is..."
- Ask follow-up questions to keep conversation flowing
- Maintain conversation context from previous turns
- Do NOT explain corrections in detail
- Do NOT write long paragraphs
`;

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
    });

    const content = completion.choices[0].message.content;

    const correctedMatch = /Corrected:\s*([\s\S]*?)\s*Reply:/i.exec(content);
    const replyMatch = /Reply:\s*([\s\S]*)/i.exec(content);

    res.json({
      corrected: correctedMatch ? correctedMatch[1].trim() : "",
      reply: replyMatch ? replyMatch[1].trim() : "",
      raw: content
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => {
  console.log(`Server live on port ${port}`);
});

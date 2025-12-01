require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Configuration, OpenAIApi } = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// For handling audio uploads
const upload = multer({ dest: 'uploads/' });

const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
}));

// TRANSCRIBE ENDPOINT
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const audioFilePath = req.file.path;
    const transcription = await openai.createTranscription(
      fs.createReadStream(audioFilePath),
      "whisper-1"
    );
    fs.unlinkSync(audioFilePath); // Clean up

    res.json({ text: transcription.data.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CHAT ENDPOINT
app.post('/chat', async (req, res) => {
  try {
    const { userText, conversationHistory } = req.body;

    // Compose messages array with system prompt and conversation history
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

    // Prepare messages in OpenAI format
    let messages = [
      { role: "system", content: systemPrompt }
    ];
    if (conversationHistory && Array.isArray(conversationHistory)) {
      conversationHistory.forEach(turn => {
        messages.push({ role: "user", content: turn.user });
        messages.push({ role: "assistant", content: turn.ai });
      });
    }
    messages.push({ role: "user", content: userText });

    const completion = await openai.createChatCompletion({
      model: "gpt-4o",
      messages,
    });

    const content = completion.data.choices[0].message.content;

    // Parse the correction/reply from AI's content
    const correctedMatch = /Corrected:\s*([\s\S]*?)\s*Reply:/i.exec(content);
    const replyMatch = /Reply:\s*([\s\S]*)/i.exec(content);

    res.json({
      corrected: correctedMatch ? correctedMatch[1].trim() : "",
      reply: replyMatch ? replyMatch[1].trim() : "",
      raw: content // For debugging
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => {
  console.log(`Server live on port ${port}`);
});
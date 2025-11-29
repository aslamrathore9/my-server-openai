import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import fileUpload from 'express-fileupload';

const app = express();
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// 1️⃣ TRANSCRIBE AUDIO (speech → text)
app.post("/transcribe", async (req, res) => {
  try {
    const audio = req.files?.audio;
    if (!audio) return res.status(400).json({ error: "No audio file" });

    const formData = new FormData();
    formData.append("file", audio.data, audio.name);
    formData.append("model", "gpt-4o-mini-transcribe");  // best STT model

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: formData
    });

    const data = await response.json();
    res.json({ text: data.text });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2️⃣ GPT-5-nano RESPONSE (text → reply)
app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-nano",     // your Android app uses this
        messages: [
          { role: "system", content: "You are an English speaking tutor. Keep replies short and interactive." },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await response.json();

    res.json({
      reply: data.choices?.[0]?.message?.content ?? ""
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3️⃣ TTS (text → speech)
app.post("/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "No text provided" });

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: text,
        voice: "alloy"
      })
    });

    const buf = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4000, () => console.log("Server running on port 4000"));

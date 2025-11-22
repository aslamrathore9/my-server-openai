import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 4000;

// ----------------------
// 1️⃣ Create GA Realtime client secret
// ----------------------
app.get("/session-token", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        modalities: ["audio", "text"],
        instructions: "You are an English tutor who corrects grammar and responds naturally.",
        voice: "alloy",
        output_audio_format: "pcm16"
      })
    });

    const data = await response.json();

    if (response.ok) {
      res.json(data); // This has client_secret.value for WebSocket
    } else {
      console.error("OpenAI error:", data);
      res.status(500).json({ error: data.error });
    }
  } catch (err) {
    console.error("Server crash:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 2️⃣ WebSocket proxy (optional)
// ----------------------
const server = app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);

// Optional: if you want a proxy to OpenAI Realtime
// Make sure you use the client_secret.value from /session-token
const wss = new WebSocketServer({ server, path: "/session" });

wss.on("connection", async (clientWs) => {
  console.log("Client connected");

  // Fetch a new client secret for this WebSocket connection
  const secretResp = await fetch("http://localhost:4000/session-token");
  const secretJson = await secretResp.json();
  const clientSecret = secretJson.client_secret.value;

  const upstream = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: {
      "Authorization": `Bearer ${clientSecret}`,
    }
  });

  upstream.on("message", (msg) => clientWs.send(msg));
  clientWs.on("message", (msg) => upstream.send(msg));

  upstream.on("close", () => clientWs.close());
  clientWs.on("close", () => upstream.close());
});

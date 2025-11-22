import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 4000;

app.get("/session-token", async (req, res) => {
    try {
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "gpt-4o-realtime-preview",
                modalities: ["audio", "text"],
                instructions: "You are an English tutor who corrects grammar and responds naturally.",
                voice: "alloy"
            })
        });

        const data = await response.json();

        if (response.ok) {
            res.json(data);
        } else {
            console.error("OpenAI error:", data);
            res.status(500).json({ error: data.error });
        }
    } catch (err) {
        console.error("Server crash:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- WebSocket proxy for OpenAI Realtime ---
const server = app.listen(PORT, () =>
    console.log(`Server running on port ${PORT}`)
);

const wss = new WebSocketServer({ server, path: "/session" });

wss.on("connection", async (clientWs) => {
    console.log("Client connected");

    const upstream = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        }
    });

    upstream.on("message", (msg) => clientWs.send(msg));
    clientWs.on("message", (msg) => upstream.send(msg));

    upstream.on("close", () => clientWs.close());
    clientWs.on("close", () => upstream.close());
});

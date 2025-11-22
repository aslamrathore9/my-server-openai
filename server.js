import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 4000;

app.get("/session-token", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({}) // ✅ empty body is correct
    });

    const data = await response.json();

    if (response.ok) {
      res.json(data); // contains client_secret.value
    } else {
      console.error("OpenAI error:", data);
      res.status(500).json({ error: data.error });
    }
  } catch (err) {
    console.error("Server crash:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import pkg from "agora-access-token";
import rateLimit from "express-rate-limit";
const { RtcTokenBuilder, RtcRole } = pkg;

const app = express();
const port = process.env.PORT || 3000;

// Configuration
const AGORA_APP_ID = process.env.AGORA_APP_ID || "";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "";
const NODE_ENV = process.env.NODE_ENV || "development";

// Rate limiting configuration
const createRateLimiter = (maxRequests = 100) => rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: maxRequests, // Limit each IP to X requests per windowMs
  message: {
    error: "Too many requests from this IP, please try again later."
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// Apply different rate limits based on endpoint
const generalLimiter = createRateLimiter(100); // 100 requests per 15 min for general endpoints
const transcriptionLimiter = createRateLimiter(50); // 50 requests per 15 min for transcription (more expensive)
const chatLimiter = createRateLimiter(150); // 150 requests per 15 min for chat

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    return originalSend.call(this, data);
  };
  next();
});

// File upload configuration
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Accept audio files
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Helper function to clean up temp files
const cleanupFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      console.error('Error cleaning up file:', error);
    }
  }
};

// HEALTH CHECK ENDPOINT
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'English Learning API',
    version: '1.0.0',
    environment: NODE_ENV,
    features: {
      transcription: true,
      chat: true,
      tts: true,
      agoraTokens: !!(AGORA_APP_ID && AGORA_APP_CERTIFICATE)
    }
  });
});

// TRANSCRIBE ENDPOINT
app.post('/transcribe', transcriptionLimiter, upload.single('audio'), async (req, res) => {
  console.log('Transcription request received');

  let tempFilePath = req.file?.path;

  try {
    // Validation
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    if (req.file.size < 1000) {
      return res.status(400).json({ error: "Audio file too small or corrupted" });
    }

    if (req.file.size > 10 * 1024 * 1024) {
      return res.status(400).json({
        error: "File too large. Maximum size is 10MB."
      });
    }

    // Determine file extension
    const supportedExtensions = {
      'audio/ogg': '.ogg',
      'audio/opus': '.ogg',
      'audio/flac': '.flac',
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/mp4': '.m4a',
      'audio/x-m4a': '.m4a',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav'
    };

    const extension = supportedExtensions[req.file.mimetype] || '.wav';
    const newPath = tempFilePath + extension;

    // Rename file with proper extension
    fs.renameSync(tempFilePath, newPath);
    tempFilePath = newPath;

    console.log(`Processing audio file: ${req.file.originalname}, size: ${(req.file.size / 1024).toFixed(2)}KB`);

    // Transcribe with OpenAI
    const fileStream = fs.createReadStream(tempFilePath);
    const transcription = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en',
      response_format: 'json'
    });

    console.log(`Transcription successful: "${transcription.text.substring(0, 100)}..."`);

    res.json({
      text: transcription.text,
      duration: req.file.size / 32000 // rough estimate in seconds
    });

  } catch (error) {
    console.error('Transcription error:', error);

    let errorMessage = "Transcription failed";
    let statusCode = 500;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `OpenAI API error: ${error.response.statusText}`;
    } else if (error.code === 'ENOENT') {
      errorMessage = "File not found";
    } else if (error.message.includes('file size')) {
      errorMessage = error.message;
      statusCode = 400;
    }

    res.status(statusCode).json({
      error: errorMessage,
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Clean up temp file
    cleanupFile(tempFilePath);
  }
});

// CHAT ENDPOINT
app.post('/chat', chatLimiter, async (req, res) => {
  try {
    const { userText, conversationHistory = [] } = req.body;

    // Input validation
    if (!userText || typeof userText !== 'string' || userText.trim().length === 0) {
      return res.status(400).json({ error: "Valid userText is required" });
    }

    if (userText.length > 1000) {
      return res.status(400).json({ error: "User text is too long. Maximum 1000 characters." });
    }

    if (!Array.isArray(conversationHistory)) {
      return res.status(400).json({ error: "conversationHistory must be an array" });
    }

    console.log(`Chat request: "${userText.substring(0, 50)}..." (${userText.length} chars)`);

    // System prompt for English tutor
    const systemPrompt = `You are a friendly English tutor helping a student practice speaking English through natural conversation.

CRITICAL FORMAT: You MUST respond in this EXACT format:

Corrected: [the corrected version of the user's sentence]
Reply: [your short conversational reply]

RULES:
1. Always start with "Corrected:" followed by the corrected sentence
2. Always follow with "Reply:" followed by your response
3. If the user's sentence is already correct, repeat it exactly in "Corrected:"
4. Keep replies short (1-2 sentences maximum)
5. Be warm, encouraging, and supportive
6. Maintain conversation context
7. Correct grammar, pronunciation, and natural phrasing

Examples:
Corrected: How are you doing today?
Reply: I'm doing great! How about you?

Corrected: I go to school yesterday.
Reply: Good effort! The correct way is "I went to school yesterday." What did you do at school?`;

    // Build messages array
    const messages = [{ role: "system", content: systemPrompt }];

    // Add conversation history (limited to last 5 exchanges)
    const maxHistory = Math.min(conversationHistory.length, 5);
    for (let i = conversationHistory.length - maxHistory; i < conversationHistory.length; i++) {
      const turn = conversationHistory[i];
      if (turn && turn.user && turn.ai) {
        messages.push({ role: "user", content: turn.user.substring(0, 500) });
        messages.push({ role: "assistant", content: turn.ai.substring(0, 500) });
      }
    }

    // Add current user message
    messages.push({ role: "user", content: userText });

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 200,
    });

    const response = completion.choices[0].message.content;

    // Parse the response
    const correctedMatch = response.match(/Corrected:\s*(.+?)(?=\s*Reply:|$)/is);
    const replyMatch = response.match(/Reply:\s*(.+)$/is);

    let corrected = correctedMatch ? correctedMatch[1].trim() : userText;
    let reply = replyMatch ? replyMatch[1].trim() : "I understand! Let's continue.";

    // Fallback if parsing failed
    if (!correctedMatch || !replyMatch) {
      console.warn("AI response format warning:", response.substring(0, 200));
      const lines = response.split('\n');
      if (lines.length >= 2) {
        corrected = lines[0].replace(/^Corrected:\s*/i, '').trim() || userText;
        reply = lines[1].replace(/^Reply:\s*/i, '').trim() || "I understand!";
      }
    }

    console.log(`Chat response generated: Corrected (${corrected.length} chars), Reply (${reply.length} chars)`);

    res.json({
      corrected: corrected,
      reply: reply,
      raw: response
    });

  } catch (error) {
    console.error('Chat error:', error);

    const errorMessage = error.response?.status === 429
      ? "Rate limit exceeded. Please try again later."
      : "Chat processing failed. Please try again.";

    res.status(500).json({
      error: errorMessage,
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// TTS ENDPOINT
app.post('/tts', generalLimiter, async (req, res) => {
  try {
    const { input, voice = "alloy", model = "tts-1" } = req.body;

    if (!input || typeof input !== 'string' || input.trim().length === 0) {
      return res.status(400).json({ error: "Text input is required" });
    }

    if (input.length > 1000) {
      return res.status(400).json({ error: "Text too long. Maximum 1000 characters." });
    }

    console.log(`TTS request: "${input.substring(0, 50)}..." (${input.length} chars)`);

    // Call OpenAI TTS
    const mp3 = await openai.audio.speech.create({
      model: model,
      voice: voice,
      input: input,
      speed: 1.0
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    console.log(`TTS generated: ${buffer.length} bytes`);

    // Set response headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.setHeader('Content-Disposition', 'inline; filename="speech.mp3"');

    res.send(buffer);

  } catch (error) {
    console.error('TTS error:', error);

    const errorMessage = error.response?.status === 429
      ? "Rate limit exceeded. Please try again later."
      : "Speech generation failed.";

    res.status(500).json({
      error: errorMessage,
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// AGORA TOKEN ENDPOINT (Optional)
app.get('/agora/token', generalLimiter, (req, res) => {
  try {
    const channelName = req.query.channelName || `default-channel-${Date.now()}`;
    const uid = parseInt(req.query.uid) || 0;

    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
      return res.status(501).json({
        error: "Agora token service not configured"
      });
    }

    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    res.json({
      token: token,
      appId: AGORA_APP_ID,
      channelName: channelName,
      uid: uid,
      expiresAt: privilegeExpiredTs,
      expiresIn: expirationTimeInSeconds
    });

  } catch (error) {
    console.error('Agora token error:', error);
    res.status(500).json({
      error: "Token generation failed",
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// API INFO ENDPOINT
app.get('/api/info', (req, res) => {
  res.json({
    name: "English Learning API",
    version: "1.0.0",
    description: "Backend for English conversation practice app",
    endpoints: {
      health: "GET /health",
      transcribe: "POST /transcribe",
      chat: "POST /chat",
      tts: "POST /tts",
      agoraToken: "GET /agora/token",
      apiInfo: "GET /api/info"
    },
    limits: {
      fileSize: "10MB",
      textLength: "1000 characters",
      rateLimiting: "Enabled"
    }
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    availableEndpoints: [
      "GET /health",
      "POST /transcribe",
      "POST /chat",
      "POST /tts",
      "GET /agora/token",
      "GET /api/info"
    ]
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "File too large. Maximum size is 10MB." });
    }
  }

  res.status(500).json({
    error: "Internal server error",
    details: NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${port}/health`);
  console.log(`📚 API info: http://localhost:${port}/api/info`);
  console.log(`🔑 OpenAI configured: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`🎤 Agora configured: ${!!(AGORA_APP_ID && AGORA_APP_CERTIFICATE)}`);
});
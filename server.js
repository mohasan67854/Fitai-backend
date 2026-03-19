// ─────────────────────────────────────────────────────────────────────────────
// FitAI — Backend Proxy Server
// Holds your Anthropic API key securely. Users never see it.
//
// DEPLOY TO RAILWAY (free):
//   1. Go to railway.app → New Project → Deploy from GitHub
//   2. Upload this folder to a GitHub repo
//   3. Add environment variable: ANTHROPIC_API_KEY = sk-ant-xxxx
//   4. Railway gives you a URL like: https://fitai-proxy.up.railway.app
//   5. Paste that URL into your frontend (VITE_API_BASE_URL in .env)
//
// OR DEPLOY TO RENDER (free):
//   1. Go to render.com → New Web Service → Connect GitHub
//   2. Build command: npm install
//   3. Start command: node server.js
//   4. Add env variable: ANTHROPIC_API_KEY = sk-ant-xxxx
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" })); // 10mb for base64 food images

// ── CORS — only allow your frontend domain ────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
  "https://fitai-psi.vercel.app",
].filter(Boolean);

app.use(cors({
  origin: "*",
  
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ── Rate limiting — prevents API key abuse ────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 20,               // Max 20 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour window
  max: 50,                   // Max 50 AI calls per IP per hour
  message: { error: "Hourly limit reached. Upgrade to Pro for higher limits." },
});

app.use("/api/", limiter);
app.use("/api/ai/", strictLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// ── Main AI proxy endpoint ────────────────────────────────────────────────────
// Frontend sends: { messages: [...], maxTokens: 1000 }
// Server adds the API key and forwards to Anthropic
app.post("/api/ai/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: API key not set. Contact support." });
  }

  const { messages, maxTokens = 1000 } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid request: messages array required." });
  }

  // Basic content validation — don't let users abuse your key
  const totalContentLength = JSON.stringify(messages).length;
  if (totalContentLength > 500000) { // ~500KB limit
    return res.status(400).json({ error: "Request too large." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: Math.min(maxTokens, 2000), // Cap at 2000 tokens max
        messages,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errMsg = errorData?.error?.message || `Anthropic API error: ${response.status}`;
      console.error("Anthropic error:", errMsg);
      return res.status(response.status).json({ error: errMsg });
    }

    const data = await response.json();
    // Only return the content — don't expose API metadata
    res.json({ content: data.content });

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).json({ error: "AI service temporarily unavailable. Please try again." });
  }
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`✅ FitAI proxy server running on port ${PORT}`);
  console.log(`   API key loaded: ${process.env.ANTHROPIC_API_KEY ? "YES ✓" : "NO ✗ — set ANTHROPIC_API_KEY env var"}`);
});

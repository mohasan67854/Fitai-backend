const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: "*" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait." },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: "Hourly limit reached." },
});

app.use("/api/", limiter);
app.use("/api/ai/", strictLimiter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), version: "1.0.0" });
});

app.post("/api/ai/chat", async (req, res) => {
  const apiKey = process.env.AI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: API key not set." });
  }

  const { messages, maxTokens = 1000 } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid request: messages array required." });
  }

  try {
    const response = await fetch("https://api.ai.cc/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        max_tokens: Math.min(maxTokens, 2000),
        messages: messages.map(m => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.find(c => c.type === "text")?.text || ""
            : m.content
        })),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errorData?.error?.message || "AI API error" });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    res.json({ content: [{ text }] });

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).json({ error: "AI service temporarily unavailable." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`FitAI proxy running on port ${PORT}`);
  console.log(`API key loaded: ${process.env.AI_API_KEY ? "YES" : "NO"}`);
});

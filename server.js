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
  windowMs: 60 * 1000, max: 20,
  message: { error: "Too many requests." },
});
app.use("/api/", limiter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), version: "1.0.0" });
});

app.post("/api/ai/chat", async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server misconfigured: API key not set." });

  const { messages, maxTokens = 10000 } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Invalid request." });

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://fitai-psi.vercel.app",
        "X-Title": "FitAI",
      },
      body: JSON.stringify({
        model: "arcee-ai/trinity-large-preview:free",
        max_tokens: Math.min(maxTokens, 2000000),
        messages: messages.map(m => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.find(c => c.type === "text")?.text || ""
            : m.content
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || "AI API error" });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    res.json({ content: [{ text }] });

  } catch (err) {
    res.status(500).json({ error: "AI service unavailable." });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`FitAI running on port ${PORT}`);
  console.log(`OpenRouter key: ${process.env.OPENROUTER_API_KEY ? "YES ✓" : "NO ✗"}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// FitAI Elite — Backend Proxy Server v2.0
// Railway environment variables needed:
//   GROQ_API_KEY      = gsk_xxxx  (from console.groq.com)
//   FRONTEND_URL      = https://fitai-psi.vercel.app
//   SUPABASE_URL      = https://cgmqbsbiynmjexztputm.supabase.co
//   SUPABASE_ANON_KEY = eyJ...
// ─────────────────────────────────────────────────────────────────────────────

const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");
const crypto    = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy so rate limiting works correctly
app.set("trust proxy", 1);

// ── Supabase REST helper ──────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const sbFetch = async (path, opts = {}) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, data: null };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...opts,
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer":        "return=representation",
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch { return { ok: false, data: null }; }
};

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: "*" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api/", rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: "Too many requests. Please wait." }
}));
app.use("/api/ai/", rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  message: { error: "Hourly AI limit reached." }
}));

// ── Token helpers (HMAC — no extra library needed) ────────────────────────────
const SECRET    = process.env.GROQ_API_KEY || "fitai-secret-2025";
const signToken = email => crypto.createHmac("sha256", SECRET).update(email + ":fitai").digest("hex");
const verifyTok = (email, token) => token === signToken(email);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  version: "2.0.0",
  groq: process.env.GROQ_API_KEY ? "✓" : "✗",
  supabase: SUPABASE_URL ? "✓" : "✗ (offline mode)",
}));

// ─────────────────────────────────────────────────────────────────────────────
// USER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/user/login  { email, name }
app.post("/api/user/login", async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes("@"))
    return res.status(400).json({ error: "Valid email required" });

  const token = signToken(email);

  // If Supabase not configured, return local token only
  if (!SUPABASE_URL)
    return res.json({ token, user: { email, name: name||email.split("@")[0], xp:0, streak:0, is_premium:false } });

  // Check if user exists
  const { data: rows } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=*`);
  const existing = Array.isArray(rows) ? rows[0] : null;

  if (existing) {
    // Check trial expiry
    if (existing.is_premium && existing.trial_end && Date.now() > existing.trial_end) {
      await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
        method: "PATCH", body: JSON.stringify({ is_premium: false, trial_end: 0 })
      });
      existing.is_premium = false;
    }
    return res.json({ token, user: existing });
  }

  // Create new user
  const { data: created } = await sbFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      email, name: name || email.split("@")[0],
      xp: 0, streak: 0, streak_last_date: "",
      is_premium: false, trial_end: 0
    }),
  });
  const newUser = Array.isArray(created) ? created[0] : { email, name, xp:0, streak:0, is_premium:false };
  res.json({ token, user: newUser });
});

// POST /api/user/streak  { email }
app.post("/api/user/streak", async (req, res) => {
  const { email } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyTok(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  const today = new Date().toDateString();

  if (!SUPABASE_URL) return res.json({ streak: 1, changed: false });

  const { data: rows } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=streak,streak_last_date`);
  const cur = Array.isArray(rows) ? rows[0] : { streak: 0, streak_last_date: "" };

  if (cur.streak_last_date === today)
    return res.json({ streak: cur.streak, changed: false });

  const last = cur.streak_last_date ? new Date(cur.streak_last_date) : null;
  const diff = last ? (new Date() - last) / 86400000 : 99;
  const newStreak = diff < 2 ? (cur.streak || 0) + 1 : 1;

  await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: JSON.stringify({ streak: newStreak, streak_last_date: today }),
  });
  res.json({ streak: newStreak, changed: true });
});

// POST /api/user/xp  { email, amount }
app.post("/api/user/xp", async (req, res) => {
  const { email, amount } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyTok(email, token))
    return res.status(401).json({ error: "Unauthorized" });
  if (!amount || amount < 0 || amount > 500)
    return res.status(400).json({ error: "Invalid XP amount" });

  if (!SUPABASE_URL) return res.json({ xp: amount });

  const { data: rows } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=xp`);
  const curXp = Array.isArray(rows) ? (rows[0]?.xp || 0) : 0;
  const newXp  = curXp + amount;

  await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH", body: JSON.stringify({ xp: newXp }),
  });
  res.json({ xp: newXp });
});

// POST /api/user/trial  { email }
app.post("/api/user/trial", async (req, res) => {
  const { email } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyTok(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  if (!SUPABASE_URL) {
    const trialEnd = Date.now() + 3 * 24 * 60 * 60 * 1000;
    return res.json({ is_premium: true, trial_end: trialEnd });
  }

  const { data: rows } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=trial_end`);
  const cur = Array.isArray(rows) ? rows[0] : null;

  // Block if trial was already used (trial_end > 0 means it was set before)
  if (cur?.trial_end && cur.trial_end > 0)
    return res.status(400).json({ error: "Free trial already used for this account." });

  const trialEnd = Date.now() + 3 * 24 * 60 * 60 * 1000;
  await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: JSON.stringify({ is_premium: true, trial_end: trialEnd }),
  });
  res.json({ is_premium: true, trial_end: trialEnd });
});

// POST /api/user/weight  { email, weight, date }
app.post("/api/user/weight", async (req, res) => {
  const { email, weight, date } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyTok(email, token))
    return res.status(401).json({ error: "Unauthorized" });
  if (!weight || weight < 20 || weight > 400)
    return res.status(400).json({ error: "Invalid weight" });

  if (!SUPABASE_URL) return res.json({ ok: true });

  await sbFetch("/weight_logs", {
    method: "POST",
    body: JSON.stringify({ email, weight: parseFloat(weight), date: date || new Date().toDateString() }),
  });
  res.json({ ok: true });
});

// GET /api/user/weight?email=xxx
app.get("/api/user/weight", async (req, res) => {
  const { email } = req.query;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyTok(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  if (!SUPABASE_URL) return res.json({ logs: [] });

  const { data } = await sbFetch(`/weight_logs?email=eq.${encodeURIComponent(email)}&order=date.asc&select=*`);
  res.json({ logs: Array.isArray(data) ? data : [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI CHAT — Uses Groq (free & fast)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/ai/chat", async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Server misconfigured: API key not set." });

  const { messages, maxTokens = 800 } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: "Invalid request." });
  if (JSON.stringify(messages).length > 200000)
    return res.status(400).json({ error: "Request too large." });

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      "llama-3.3-70b-versatile",
        max_tokens: Math.min(maxTokens, 2048),
        messages: messages.map(m => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.find(c => c.type === "text")?.text || ""
            : m.content,
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("Groq error:", JSON.stringify(err));
      return res.status(response.status).json({ error: err?.error?.message || "AI API error" });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    // Return in Anthropic-compatible format so frontend works unchanged
    res.json({ content: [{ text }] });

  } catch (err) {
    console.error("AI error:", err.message);
    res.status(500).json({ error: "AI service unavailable. Try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.use((_, res)      => res.status(404).json({ error: "Not found" }));
app.use((err, _, res) => res.status(500).json({ error: err.message }));

app.listen(PORT, () => {
  console.log(`✅ FitAI Elite server v2.0 on port ${PORT}`);
  console.log(`   Groq:      ${process.env.GROQ_API_KEY      ? "✓ connected" : "✗ MISSING — set GROQ_API_KEY"}`);
  console.log(`   Supabase:  ${SUPABASE_URL                  ? "✓ connected" : "✗ not set (offline mode active)"}`);
  console.log(`   Frontend:  ${process.env.FRONTEND_URL      || "not set (CORS open)"}`);
});

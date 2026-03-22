// ─────────────────────────────────────────────────────────────────────────────
// FitAI Elite — Backend Proxy Server v2.0
// Railway environment variables needed:
//   ANTHROPIC_API_KEY   = sk-ant-xxxx
//   FRONTEND_URL        = https://fitai-psi.vercel.app
//   SUPABASE_URL        = https://xxxx.supabase.co
//   SUPABASE_ANON_KEY   = eyJ...
// ─────────────────────────────────────────────────────────────────────────────

const express    = require("express");
const cors       = require("cors");
const rateLimit  = require("express-rate-limit");
const helmet     = require("helmet");
const crypto     = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Supabase client (server-side) ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const sbFetch = async (path, opts = {}) => {
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
  return { ok: res.ok, status: res.status, data };
};

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: "2mb" }));

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  methods:      ["POST", "GET", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "x-fitai-token"],
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api/", rateLimit({ windowMs: 60000, max: 30,
  message: { error: "Too many requests. Please wait." } }));
app.use("/api/ai/", rateLimit({ windowMs: 3600000, max: 60,
  message: { error: "Hourly AI limit reached." } }));

// ── Token helpers (simple HMAC — no JWT library needed) ──────────────────────
const SECRET = process.env.ANTHROPIC_API_KEY || "fitai-secret-2025";
const signToken   = email => crypto.createHmac("sha256", SECRET).update(email + ":fitai").digest("hex");
const verifyToken = (email, token) => token === signToken(email);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", version: "2.0.0" }));

// ── USER: Login / Register ────────────────────────────────────────────────────
// POST /api/user/login  { email, name }
// Returns: { token, user }
app.post("/api/user/login", async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes("@"))
    return res.status(400).json({ error: "Valid email required" });

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(200).json({ token: signToken(email), user: { email, name, xp: 0, streak: 0, is_premium: false } });

  // Check if user exists
  const { data: existing } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=*`);
  const user = Array.isArray(existing) ? existing[0] : null;

  if (user) {
    return res.json({ token: signToken(email), user });
  }

  // Create new user
  const { ok, data: created } = await sbFetch("/users", {
    method:  "POST",
    body: JSON.stringify({ email, name: name || email.split("@")[0], xp: 0, streak: 0, streak_last_date: "", is_premium: false, trial_end: 0 }),
  });
  if (!ok) return res.status(500).json({ error: "Could not create user" });
  const newUser = Array.isArray(created) ? created[0] : created;
  res.json({ token: signToken(email), user: newUser });
});

// ── USER: Get profile ─────────────────────────────────────────────────────────
app.get("/api/user/me", async (req, res) => {
  const email = req.query.email;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyToken(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  const { data } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=*`);
  const user = Array.isArray(data) ? data[0] : null;
  if (!user) return res.status(404).json({ error: "User not found" });

  // Check trial expiry
  if (user.is_premium && user.trial_end && Date.now() > user.trial_end) {
    await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
      method: "PATCH", body: JSON.stringify({ is_premium: false, trial_end: 0 }),
    });
    user.is_premium = false;
  }
  res.json({ user });
});

// ── USER: Update XP ───────────────────────────────────────────────────────────
app.post("/api/user/xp", async (req, res) => {
  const { email, amount } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyToken(email, token))
    return res.status(401).json({ error: "Unauthorized" });
  if (!amount || amount < 0 || amount > 500)
    return res.status(400).json({ error: "Invalid XP amount" });

  const { data: existing } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=xp`);
  const cur = Array.isArray(existing) ? existing[0]?.xp || 0 : 0;
  const newXp = cur + amount;

  await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH", body: JSON.stringify({ xp: newXp }),
  });
  res.json({ xp: newXp });
});

// ── USER: Update streak ───────────────────────────────────────────────────────
app.post("/api/user/streak", async (req, res) => {
  const { email } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyToken(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  const { data: existing } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=streak,streak_last_date`);
  const cur = Array.isArray(existing) ? existing[0] : { streak: 0, streak_last_date: "" };
  const today = new Date().toDateString();

  if (cur.streak_last_date === today)
    return res.json({ streak: cur.streak, changed: false });

  const last = cur.streak_last_date ? new Date(cur.streak_last_date) : null;
  const diff = last ? (new Date() - last) / 86400000 : 99;
  const newStreak = diff < 2 ? (cur.streak || 0) + 1 : 1;

  await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH", body: JSON.stringify({ streak: newStreak, streak_last_date: today }),
  });
  res.json({ streak: newStreak, changed: true });
});

// ── USER: Activate trial ──────────────────────────────────────────────────────
app.post("/api/user/trial", async (req, res) => {
  const { email } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyToken(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  // Check if already used trial
  const { data: existing } = await sbFetch(`/users?email=eq.${encodeURIComponent(email)}&select=trial_end,is_premium`);
  const user = Array.isArray(existing) ? existing[0] : null;
  if (user?.trial_end && user.trial_end > 0)
    return res.status(400).json({ error: "Trial already used" });

  const trialEnd = Date.now() + 3 * 24 * 60 * 60 * 1000; // 3 days
  await sbFetch(`/users?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH", body: JSON.stringify({ is_premium: true, trial_end: trialEnd }),
  });
  res.json({ is_premium: true, trial_end: trialEnd });
});

// ── WEIGHT: Save weight entry ─────────────────────────────────────────────────
app.post("/api/user/weight", async (req, res) => {
  const { email, weight, date } = req.body;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyToken(email, token))
    return res.status(401).json({ error: "Unauthorized" });
  if (!weight || weight < 20 || weight > 400)
    return res.status(400).json({ error: "Invalid weight" });

  // Store in a weight_logs table
  await sbFetch("/weight_logs", {
    method: "POST",
    body: JSON.stringify({ email, weight: parseFloat(weight), date: date || new Date().toDateString() }),
  });
  res.json({ ok: true });
});

// ── WEIGHT: Get weight history ────────────────────────────────────────────────
app.get("/api/user/weight", async (req, res) => {
  const { email } = req.query;
  const token = req.headers["x-fitai-token"];
  if (!email || !verifyToken(email, token))
    return res.status(401).json({ error: "Unauthorized" });

  const { data } = await sbFetch(`/weight_logs?email=eq.${encodeURIComponent(email)}&order=date.asc&select=*`);
  res.json({ logs: Array.isArray(data) ? data : [] });
});

// ── AI CHAT ───────────────────────────────────────────────────────────────────
app.post("/api/ai/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Server misconfigured: API key missing" });

  const { messages, maxTokens = 700 } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array required" });
  if (JSON.stringify(messages).length > 200000)
    return res.status(400).json({ error: "Request too large" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: Math.min(maxTokens, 800),
        messages,
      }),
    });

    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: e?.error?.message || `AI error ${response.status}` });
    }
    const data = await response.json();
    res.json({ content: data.content });
  } catch (err) {
    res.status(500).json({ error: "AI service unavailable. Try again." });
  }
});

// ── 404 + error handler ───────────────────────────────────────────────────────
app.use((_, res)        => res.status(404).json({ error: "Not found" }));
app.use((err, _, res)   => res.status(500).json({ error: err.message }));

app.listen(PORT, () => {
  console.log(`✅ FitAI server v2.0 on port ${PORT}`);
  console.log(`   AI key:    ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`   Supabase:  ${SUPABASE_URL ? "✓" : "✗ MISSING (local fallback active)"}`);
});

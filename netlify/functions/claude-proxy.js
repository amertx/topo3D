// netlify/functions/claude-proxy.js
// Rate-limited proxy to Anthropic API

// In-memory rate limit store (resets when function cold-starts, ~15 min idle)
// For a small site this is sufficient. For heavy traffic, use a KV store.
const rateLimitMap = new Map();

const RATE_LIMIT = 5;          // max requests per window per IP
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
const GLOBAL_RPM = 60;         // global requests per minute across all users
let globalRequestLog = [];

function cleanupOldEntries() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    entry.timestamps = entry.timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (entry.timestamps.length === 0) rateLimitMap.delete(ip);
  }
  globalRequestLog = globalRequestLog.filter(t => now - t < 60000);
}

function isRateLimited(ip) {
  cleanupOldEntries();
  const now = Date.now();

  // Check global rate limit
  if (globalRequestLog.length >= GLOBAL_RPM) {
    return { limited: true, reason: "Global rate limit reached. Please try again in a minute." };
  }

  // Check per-IP rate limit
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { timestamps: [] });
  }
  const entry = rateLimitMap.get(ip);

  if (entry.timestamps.length >= RATE_LIMIT) {
    const oldestRequest = entry.timestamps[0];
    const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - oldestRequest)) / 1000);
    return {
      limited: true,
      reason: `Rate limit exceeded (${RATE_LIMIT} requests/hour). Try again in ${Math.ceil(retryAfterSec / 60)} min.`,
      retryAfter: retryAfterSec,
    };
  }

  entry.timestamps.push(now);
  globalRequestLog.push(now);
  return { limited: false };
}

function getClientIP(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    event.headers["client-ip"] ||
    "unknown"
  );
}

const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // --- Rate limiting ---
  const clientIP = getClientIP(event);
  const rateCheck = isRateLimited(clientIP);

  if (rateCheck.limited) {
    return {
      statusCode: 429,
      headers: { ...headers, ...(rateCheck.retryAfter ? { "Retry-After": String(rateCheck.retryAfter) } : {}) },
      body: JSON.stringify({ error: rateCheck.reason }),
    };
  }

  // --- API key check ---
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
    };
  }

  // --- Validate request ---
  let incoming;
  try {
    incoming = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!incoming.messages || !Array.isArray(incoming.messages) || incoming.messages.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Messages array required" }) };
  }

  // Limit message content length to prevent abuse (max ~8000 chars total)
  const totalChars = incoming.messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);

  if (totalChars > 8000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Request too large" }) };
  }

  try {
    // Build clean request — only fields the API expects
    const apiBody = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: incoming.messages,
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(apiBody),
    });

    const data = await response.text();

    return { statusCode: response.status, headers, body: data };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Proxy error: " + err.message }),
    };
  }
};

module.exports = { handler };

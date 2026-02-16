// netlify/functions/claude-proxy.js

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

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured in environment variables" }),
    };
  }

  try {
    const incoming = JSON.parse(event.body);

    // Build a clean request body with ONLY the fields the API expects
    const apiBody = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: incoming.messages || [],
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

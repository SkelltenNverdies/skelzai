// SkelzAI Chat API — Vercel Serverless Function
// Compatible with Vercel Node.js runtime (>=18, has global fetch)
// Required env vars (set in Vercel project settings):
//   QWEN_API_KEY         — for qwen-turbo / qwen-plus / qwen-max
//   GROQ_API_KEY         — for Llama models on Groq
//   BLUEMINDS_API_KEY    — for glm-4.6 on BluesMinds

const SYSTEM_PROMPT = {
  role: 'system',
  content: `Kamu adalah SkelzAI, asisten AI SENIOR SOFTWARE ENGINEER berbahasa Indonesia.
Pencipta: Gabriel Arjun Pangestu (masterpiece).
ATURAN:
1. SELALU jawab dalam BAHASA INDONESIA
2. Kode HARUS LENGKAP 100% - TIDAK BOLEH ada "..." atau "// TODO"
3. Tulis SETIAP BARIS kode dari awal sampai akhir
4. WAJIB include error handling (try-catch), type hints, comments
5. Gunakan best practices modern
6. Jika diminta website/app, berikan struktur folder lengkap
7. Selalu tanyakan klarifikasi jika requirement ambigu
FORMAT OUTPUT:
1. Penjelasan singkat
2. KODE LENGKAP dalam code block
3. Cara menjalankan
4. Tips & best practices`
};

const PROVIDERS = {
  qwen: {
    envVar: 'QWEN_API_KEY',
    url: 'https://ws-3cudsfbi2d76ndhg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    timeout: 60000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-DashScope-WorkSpace': 'ws-3cudsfbi2d76ndhg'
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: 8192, temperature: 0.7 })
      };
    }
  },
  groq: {
    envVar: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    timeout: 60000,
    buildRequest(apiKey, model, messages) {
      // Groq has hard limits per model — let us pass through and clamp here
      // llama-3.3-70b-versatile supports up to 32768 output tokens
      // llama-3.1-8b-instant supports up to 8192 output tokens
      const maxTokens = model.indexOf('70b') !== -1 ? 8000 : 4000;
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, temperature: 0.7 })
      };
    }
  },
  bluesminds: {
    envVar: 'BLUEMINDS_API_KEY',
    url: 'https://api.bluesminds.com/v1/chat/completions',
    timeout: 60000,
    buildRequest(apiKey, model, messages) {
      // GLM-4.6: NO max_tokens limit (unlimited) — omit it entirely so the
      // provider uses its own default maximum. This is the user's explicit request.
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'glm-4.6',
          messages,
          stream: false,
          temperature: 0.7
          // max_tokens intentionally omitted — let GLM-4.6 use its full context budget
        })
      };
    }
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Defensive JSON parse — some upstreams return text errors on 200 OK.
// Always returns { ok: true, data } or { ok: false, error, status }
async function safeReadJson(response) {
  const text = await response.text().catch(() => '');
  if (!text || !text.trim()) {
    return { ok: false, error: 'Empty response body from upstream', text: '' };
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      return { ok: true, data, text };
    } catch (e) {
      return { ok: false, error: `Upstream returned invalid JSON: ${e.message}`, text };
    }
  }
  // Not JSON — likely an HTML error page or plain text error from upstream
  return { ok: false, error: `Upstream returned non-JSON: ${trimmed.substring(0, 200)}`, text };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body — Vercel usually parses JSON already, but be defensive
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { provider = 'qwen', model, messages } = body || {};
  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: model & messages required' });
  }

  const config = PROVIDERS[provider];
  if (!config) {
    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }

  const apiKey = process.env[config.envVar];
  if (!apiKey) {
    return res.status(500).json({ error: `${config.envVar} not set on server` });
  }

  const finalMessages = [SYSTEM_PROMPT, ...messages];

  // Retry on transient errors (429 / 504 / network)
  let lastError = null;
  let response = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reqOptions = config.buildRequest(apiKey, model, finalMessages);
      response = await fetchWithTimeout(config.url, reqOptions, config.timeout);

      if (response.status === 429) {
        lastError = new Error(`Rate limited (429)`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 4000));
        continue;
      }
      if (response.status === 504) {
        lastError = new Error(`Gateway timeout (504)`);
        continue;
      }
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 1) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
      }
    }
  }

  // Special fallback: if Qwen returned 504 twice, try qwen-turbo as a last resort
  if (response && response.status === 504 && provider === 'qwen' && model !== 'qwen-turbo') {
    try {
      const fallbackOpts = PROVIDERS.qwen.buildRequest(apiKey, 'qwen-turbo', finalMessages);
      const fr = await fetchWithTimeout(PROVIDERS.qwen.url, fallbackOpts, PROVIDERS.qwen.timeout);
      if (fr.ok) {
        const parsed = await safeReadJson(fr);
        if (parsed.ok) {
          return res.status(200).json(parsed.data);
        }
      }
    } catch (e) {
      // ignore — fall through to error response
    }
  }

  if (!response) {
    return res.status(502).json({
      error: `${provider} unreachable: ${(lastError && lastError.message) || 'Network error'}`
    });
  }

  // Read body defensively — works for both OK and error responses
  const parsed = await safeReadJson(response);

  if (!response.ok) {
    const status = response.status;
    const errDetail = parsed.ok
      ? (parsed.data && (parsed.data.error && (parsed.data.error.message || parsed.data.error))) || JSON.stringify(parsed.data).substring(0, 200)
      : parsed.error;
    return res.status(status).json({
      error: `${provider} error ${status}: ${errDetail}`
    });
  }

  if (!parsed.ok) {
    // Upstream returned 2xx but body is not JSON — common with BluesMinds on errors
    return res.status(502).json({
      error: `${provider} returned non-JSON response (HTTP ${response.status}): ${parsed.error}`
    });
  }

  // Validate response shape (OpenAI-compatible)
  const data = parsed.data;
  if (data && data.choices && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message) {
    return res.status(200).json(data);
  }

  // Some providers return { error: ... } envelope even on 200 — surface it
  if (data && data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
    return res.status(502).json({
      error: `${provider} upstream error: ${errMsg.substring(0, 300)}`
    });
  }

  return res.status(502).json({
    error: `${provider} returned unexpected response shape: ${JSON.stringify(data).substring(0, 200)}`
  });
}

// SkelzAI Chat API — Vercel Serverless Function
// Compatible with Vercel Node.js runtime (>=18, has global fetch)
// Required env vars (set in Vercel project settings):
//   QWEN_API_KEY         — for qwen-turbo / qwen-plus / qwen-max
//   GROQ_API_KEY         — for Llama models on Groq
//   NVIDIA_API_KEY       — for NVIDIA direct API (integrate.api.nvidia.com)
//   OPENROUTER_API_KEY   — optional, for NVIDIA Nemotron 3 free models via OpenRouter

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

// Per-request timeout kept at 25s so that 1 retry (worst case 25s + 2s + 25s = 52s)
// stays well under Vercel Hobby plan's 60s maxDuration. This prevents
// FUNCTION_INVOCATION_TIMEOUT errors.
const PROVIDERS = {
  qwen: {
    envVar: 'QWEN_API_KEY',
    url: 'https://ws-3cudsfbi2d76ndhg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    timeout: 25000,
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
    timeout: 25000,
    buildRequest(apiKey, model, messages) {
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
  nvidia: {
    // NVIDIA direct API (integrate.api.nvidia.com) — OpenAI-compatible.
    // API key embedded as fallback so it works out-of-the-box.
    // NVIDIA gives 1000 free credits at signup — effectively free for personal use.
    // Override via NVIDIA_API_KEY env var.
    envVar: 'NVIDIA_API_KEY',
    fallbackKey: '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',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    timeout: 25000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          max_tokens: 4096,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    }
  },
  openrouter: {
    // OpenRouter — OpenAI-compatible API
    // Default key embedded as fallback so it works out-of-the-box;
    // override via OPENROUTER_API_KEY env var for production use.
    // NOTE: NVIDIA Nemotron 3 models are reasoning models — they consume
    // tokens for chain-of-thought before producing final content. We use
    // a large max_tokens (8192) so the model has room to finish reasoning.
    envVar: 'OPENROUTER_API_KEY',
    fallbackKey: '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',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    timeout: 25000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://skelzai.vercel.app',
          'X-Title': 'SkelzAI'
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          max_tokens: 8192,
          temperature: 0.7
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
  return { ok: false, error: `Upstream returned non-JSON: ${trimmed.substring(0, 200)}`, text };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  // Prefer env var; fall back to embedded default key (only OpenRouter has one).
  // This lets the app work out-of-the-box without requiring env var setup.
  let apiKey = process.env[config.envVar];
  if (!apiKey && config.fallbackKey) {
    apiKey = config.fallbackKey;
  }
  if (!apiKey) {
    return res.status(500).json({ error: `${config.envVar} not set on server` });
  }

  const finalMessages = [SYSTEM_PROMPT, ...messages];

  // 1 retry only — keeps total worst case under 60s Vercel limit
  let lastError = null;
  let response = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reqOptions = config.buildRequest(apiKey, model, finalMessages);
      response = await fetchWithTimeout(config.url, reqOptions, config.timeout);

      if (response.status === 429) {
        lastError = new Error(`Rate limited (429)`);
        if (attempt < 1) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      }
      if (response.status === 504 || response.status === 502) {
        lastError = new Error(`Gateway error (${response.status})`);
        if (attempt < 1) {
          continue;
        }
        break;
      }
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  if (!response) {
    const errMsg = (lastError && lastError.message) || 'Network error';
    const isTimeout = errMsg.toLowerCase().indexOf('abort') !== -1 || errMsg.toLowerCase().indexOf('timeout') !== -1;
    return res.status(504).json({
      error: isTimeout
        ? `${provider} timeout — server membutuhkan waktu terlalu lama (maks 25 detik per percobaan). Coba lagi atau gunakan model lain.`
        : `${provider} unreachable: ${errMsg}`
    });
  }

  // Read body defensively
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
    return res.status(502).json({
      error: `${provider} returned non-JSON response (HTTP ${response.status}): ${parsed.error}`
    });
  }

  // Validate response shape (OpenAI-compatible).
  // Some reasoning models (NVIDIA Nemotron 3) return content=null on truncated
  // responses but populate a `reasoning` field. Fall back to that so the user
  // still gets something useful instead of an empty message.
  const data = parsed.data;
  if (data && data.choices && Array.isArray(data.choices) && data.choices[0]) {
    const choice = data.choices[0];
    const msg = choice.message || {};
    let content = msg.content;
    if (!content && msg.reasoning) {
      content = msg.reasoning;
    }
    if (content) {
      // Mutate the response so the frontend's `choices[0].message.content` lookup works.
      choice.message = { ...msg, content };
      return res.status(200).json(data);
    }
    // content still empty but finish_reason indicates truncation
    if (choice.finish_reason === 'length') {
      return res.status(502).json({
        error: `${provider}: response truncated (max_tokens reached during reasoning). Coba pertanyaan yang lebih singkat.`
      });
    }
  }

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

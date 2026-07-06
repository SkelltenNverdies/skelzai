// SkelzAI Chat API — Vercel Serverless Function
// Compatible with Vercel Node.js runtime (>=18, has global fetch)
// Required env vars (set in Vercel project settings):
//   QWEN_API_KEY         — for qwen-turbo / qwen-plus / qwen-max
//   GROQ_API_KEY         — for Llama models on Groq
//   BLUEMINDS_API_KEY    — for glm-4.6 / gpt-3.5-turbo on BluesMinds

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
        body: JSON.stringify({ model, messages, stream: false, max_tokens: 4096, temperature: 0.7 })
      };
    }
  },
  groq: {
    envVar: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    timeout: 60000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: 5000, temperature: 0.7 })
      };
    }
  },
  bluesminds: {
    envVar: 'BLUEMINDS_API_KEY',
    url: 'https://api.bluesminds.com/v1/chat/completions',
    timeout: 30000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model: model || 'glm-4.6', messages, stream: false, max_tokens: 2048, temperature: 0.7 })
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
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
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
        await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
      }
    }
  }

  // Special fallback: if Qwen returned 504 twice, try qwen-turbo as a last resort
  if (response && response.status === 504 && provider === 'qwen' && model !== 'qwen-turbo') {
    try {
      const fallbackOpts = PROVIDERS.qwen.buildRequest(apiKey, 'qwen-turbo', finalMessages);
      const fr = await fetchWithTimeout(PROVIDERS.qwen.url, fallbackOpts, PROVIDERS.qwen.timeout);
      if (fr.ok) {
        const data = await fr.json();
        return res.status(200).json(data);
      }
    } catch (e) {
      // ignore — fall through to error response
    }
  }

  if (!response || !response.ok) {
    const status = response ? response.status : 500;
    const errText = response ? await response.text().catch(() => '') : (lastError && lastError.message) || 'Unknown error';
    return res.status(status).json({
      error: `${provider} error ${status}: ${(errText || '').substring(0, 300)}`
    });
  }

  try {
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Invalid JSON response from upstream provider' });
  }
}

// SkelzAI Chat API — Vercel Serverless Function
// Compatible with Vercel Node.js runtime (>=18, has global fetch)
// Required env vars (set in Vercel project settings):
//   QWEN_API_KEY         — for qwen-turbo / qwen-plus / qwen-max
//   GROQ_API_KEY         — for Llama models on Groq
//   OPENROUTER_API_KEY   — optional, for NVIDIA Nemotron 3 free models via OpenRouter
//   GEMINI_API_KEY       — optional, for Google Gemini models (free tier)

const SYSTEM_PROMPT = {
  role: 'system',
  content: `Kamu adalah SkelzAI, asisten AI yang ramah, natural, dan to-the-point berbahasa Indonesia.
Pencipta: Gabriel Arjun Pangestu.

PRINSIP UTAMA:
1. SELALU jawab dalam BAHASA INDONESIA yang natural, seperti chat dengan teman
2. JAWAB SIMPLE & TO-THE-POINT — jangan bertele-tele, jangan over-explain
3. JANGAN berikan kodingan kecuali user EXPLICITLY meminta (contoh: "buatkan kode", "tuliskan script", "berikan contoh code", "bikin program")
4. Kalau user cuma nanya "apa itu X" atau "jelaskan Y" — cukup jelaskan dengan kalimat biasa, jangan langsung kasih kode
5. Sesuaikan panjang jawaban dengan pertanyaan — pertanyaan singkat = jawaban singkat
6. Kalau pertanyaan ambigu, tanya klarifikasi singkat (1 kalimat), jangan asumsi sendiri

SAAT USER MEMINTA KODE (hanya jika diminta):
- Berikan kode LENGKAP & siap pakai — tidak boleh ada "..." atau "// TODO"
- Tulis setiap baris dari awal sampai akhir
- Include error handling yang masuk akal
- Berikan penjelasan singkat sebelum kode, lalu cara menjalankan setelahnya

FORMAT JAWABAN:
- Untuk pertanyaan biasa: langsung jawab pakai kalimat natural, boleh pakai list singkat kalau perlu
- Untuk request kode: 1-2 kalimat penjelasan → kode dalam code block → cara menjalankan
- Hindari heading berlebihan, hindari template kaku, jangan over-format jawaban singkat

GAYA:
- Ramah tapi efisien — seperti senior dev yang sibuk tapi tetap helpful
- Boleh santai, tapi tetap profesional
- Jangan gunakan emoji berlebihan — maksimal 1 emoji per jawaban kalau perlu`
};

// Compact system prompt for token-constrained providers (Groq 8B free tier).
// Same instructions, just tersely worded to save ~200 tokens per request.
const SYSTEM_PROMPT_COMPACT = {
  role: 'system',
  content: `Kamu SkelzAI, asisten AI bahasa Indonesia yang ramah & to-the-point. Pencipta: Gabriel Arjun Pangestu.

Aturan:
1. Jawab pakai BAHASA INDONESIA natural, seperti chat teman
2. JAWAB SIMPLE — jangan over-explain, sesuaikan panjang dengan pertanyaan
3. JANGAN kasih kode kecuali user explicit minta ("buatkan kode", "tuliskan script")
4. Kalau ditanya "apa itu X" — jelaskan pakai kalimat biasa, jangan langsung kasih kode
5. Kalau ambigu, tanya klarifikasi 1 kalimat

Kalau diminta kode: kasih kode LENGKAP (no "..." atau TODO) + penjelasan singkat + cara jalanin.

Gaya: santai tapi profesional, maksimal 1 emoji per jawaban.`
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
    // Groq free tier TPM (Tokens Per Minute) limits:
    //   llama-3.3-70b-versatile: 12000 TPM
    //   llama-3.1-8b-instant:    6000 TPM  ← very tight!
    // Groq counts request size as (input_tokens + max_tokens).
    // We must keep total < TPM limit to avoid 413 errors.
    // Strategy: aggressive history trimming + conservative max_tokens.
    getMaxTokens(model) {
      return model.indexOf('70b') !== -1 ? 4000 : 2000;
    },
    getMaxHistory(model) {
      // 8B is super tight on TPM — only send last 4 messages (2 exchanges)
      // 70B has more room — send last 8 messages (4 exchanges)
      return model.indexOf('70b') !== -1 ? 8 : 4;
    },
    buildRequest(apiKey, model, messages) {
      const maxTokens = this.getMaxTokens(model);
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, temperature: 0.7, top_p: 0.9 })
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
  },
  gemini: {
    // Google Gemini via OpenAI-compatible endpoint (generativelanguage.googleapis.com)
    // Free tier: 15 RPM, 1500 req/day for most models. Vision-capable.
    // API key embedded as fallback; override via GEMINI_API_KEY env var.
    // NOTE: Google AI Studio now issues keys in two formats:
    //   - Old format: "AIza..." (39 chars)
    //   - New format: "AQ.Ab8R..." (longer, OAuth-style but works as API key)
    // Both formats work with Authorization: Bearer header on the OpenAI-compat endpoint.
    // If 401 occurs, code falls back to native Gemini API with x-goog-api-key header.
    envVar: 'GEMINI_API_KEY',
    fallbackKey: 'AQ.Ab8RN6J9_yC_bHZLwPq8TZs3pIiY60wN3yY28XBAiOvZwWPdwg',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    timeout: 25000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          max_tokens: 8192,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    },
    // Alternative auth method (native Gemini API with x-goog-api-key header).
    // Used as fallback if OpenAI-compat endpoint returns 401.
    buildNativeRequest(apiKey, model, messages) {
      // Convert OpenAI-style messages to Gemini native format
      const contents = [];
      let systemInstruction = null;
      for (const m of messages) {
        if (m.role === 'system') {
          systemInstruction = { parts: [{ text: m.content }] };
        } else {
          const role = m.role === 'assistant' ? 'model' : 'user';
          // Handle multimodal content (array of {type, text/image_url})
          let parts;
          if (Array.isArray(m.content)) {
            parts = m.content.map(c => {
              if (c.type === 'text') return { text: c.text };
              if (c.type === 'image_url') {
                const url = c.image_url.url || '';
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  return { inline_data: { mime_type: match[1], data: match[2] } };
                }
                return { text: '[image url not supported in native mode]' };
              }
              return { text: '' };
            });
          } else {
            parts = [{ text: m.content || '' }];
          }
          contents.push({ role, parts });
        }
      }
      const body = {
        contents,
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0.7,
          topP: 0.9
        }
      };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      return {
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body)
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

  // Build final messages: system prompt + user-supplied history.
  // For Groq 8B (very tight 6000 TPM), use compact system prompt to save tokens.
  // For Groq 70B and others, use full system prompt.
  const useCompact = provider === 'groq' && model.indexOf('70b') === -1;
  const sysPrompt = useCompact ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT;

  let finalMessages = [sysPrompt, ...messages];

  // Groq-specific aggressive trimming to avoid 413 TPM errors
  if (provider === 'groq' && config.getMaxHistory) {
    const maxHist = config.getMaxHistory(model);
    // Keep system prompt + last N messages
    const trimmed = messages.slice(-maxHist);
    finalMessages = [sysPrompt, ...trimmed];
  }

  // Rough token estimation (4 chars ≈ 1 token). If estimated input tokens
  // exceed a safe budget for the provider, trim further.
  function estimateTokens(msgs) {
    let chars = 0;
    for (const m of msgs) {
      chars += (m.content || '').length;
    }
    return Math.ceil(chars / 4);
  }

  // For Groq 8B (6000 TPM), ensure input tokens + max_tokens < 5500 (safety margin)
  // For Groq 70B (12000 TPM), ensure input tokens + max_tokens < 11000
  if (provider === 'groq') {
    const maxTok = config.getMaxTokens(model);
    const tpmLimit = model.indexOf('70b') !== -1 ? 12000 : 6000;
    const safeBudget = tpmLimit - maxTok - 500; // 500 token safety margin

    let estTokens = estimateTokens(finalMessages);
    // Trim history (keep system prompt + last messages) until under budget
    while (estTokens > safeBudget && finalMessages.length > 2) {
      // Remove the 2nd message (first after system prompt) — keeps recent context
      finalMessages.splice(1, 1);
      estTokens = estimateTokens(finalMessages);
    }
  }

  // 1 retry only — keeps total worst case under 60s Vercel limit.
  // Special handling: 413 (TPM exceeded) is NOT retried (waiting 60s would
  // blow Vercel's maxDuration). Instead, we surface a clear error so the
  // frontend can fallback to SkelzAI Turbo.
  let lastError = null;
  let response = null;
  let hit413 = false;
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
      if (response.status === 413) {
        // TPM exceeded on Groq — don't retry, surface immediately so
        // frontend can fallback to SkelzAI Turbo.
        hit413 = true;
        lastError = new Error(`Token limit exceeded (413)`);
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

  // Gemini fallback: if OpenAI-compat endpoint returns 401 (auth failed),
  // try native Gemini API with x-goog-api-key header as alternative.
  // This handles keys that work with native API but not OpenAI-compat layer.
  if (provider === 'gemini' && response && response.status === 401 && config.buildNativeRequest) {
    try {
      const nativeOpts = config.buildNativeRequest(apiKey, model, finalMessages);
      const nativeUrl = nativeOpts.url;
      const nativeReqOpts = {
        method: nativeOpts.method,
        headers: nativeOpts.headers,
        body: nativeOpts.body
      };
      const nativeResponse = await fetchWithTimeout(nativeUrl, nativeReqOpts, config.timeout);
      if (nativeResponse.ok) {
        // Parse native Gemini response and convert to OpenAI format
        const nativeData = await nativeResponse.json();
        const candidate = nativeData.candidates && nativeData.candidates[0];
        const content = candidate && candidate.content && candidate.content.parts
          ? candidate.content.parts.map(p => p.text || '').join('')
          : '';
        if (content) {
          return res.status(200).json({
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: candidate?.finishReason?.toLowerCase() || 'stop'
            }],
            usage: {
              prompt_tokens: nativeData.usageMetadata?.promptTokenCount || 0,
              completion_tokens: nativeData.usageMetadata?.candidatesTokenCount || 0,
              total_tokens: nativeData.usageMetadata?.totalTokenCount || 0
            }
          });
        }
      }
      // If native also failed, use the original 401 response for error handling
    } catch (nativeErr) {
      // Native fallback failed — fall through to original error handling
    }
  }

  // If we hit 413, return a clear error so the frontend can fallback.
  if (hit413) {
    return res.status(413).json({
      error: `${provider} token limit tercapai (TPM). Coba lagi dalam 1 menit atau gunakan model lain.`,
      fallback: true
    });
  }

  // Gemini 429 (quota exceeded) — surface with fallback flag so frontend
  // can auto-switch to SkelzAI Turbo. Free tier has tight per-minute limits.
  if (provider === 'gemini' && response && response.status === 429) {
    const parsed429 = await safeReadJson(response);
    const errDetail = parsed429.ok
      ? (parsed429.data && (parsed429.data.error?.message || JSON.stringify(parsed429.data).substring(0, 200)))
      : parsed429.error;
    return res.status(429).json({
      error: `Gemini quota tercapai (free tier). Tunggu 1 menit atau gunakan model lain.`,
      fallback: true,
      detail: errDetail
    });
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

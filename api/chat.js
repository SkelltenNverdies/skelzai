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

SAAT MENGANALISIS FOTO/SOAL DARI GAMBAR:
- Baca soal/pertanyaan di foto dengan teliti, sebutkan apa yang kamu lihat
- JAWAB DENGAN BAHASA SEDERHANA & MUDAH DIPAHAMI — hindari istilah rumit
- Untuk soal matematika/sains: jelaskan langkah per langkah dengan kalimat biasa
- Jelaskan MENGAPA setiap langkah dilakukan, bukan hanya "bagaimana"
- Kalau ada rumus, sebutkan rumusnya dan jelaskan artinya dengan kata-kata biasa
- Akhiri dengan jawaban akhir yang jelas dan ditandai (contoh: "Jadi, jawabannya adalah X")
- Kalau soalnya tidak jelas dari foto, minta user foto ulang atau ketik ulang soalnya

FORMAT JAWABAN:
- Untuk pertanyaan biasa: langsung jawab pakai kalimat natural, boleh pakai list singkat kalau perlu
- Untuk request kode: 1-2 kalimat penjelasan → kode dalam code block → cara menjalankan
- Untuk analisis foto/soal: apa yang kamu lihat → langkah-langkah sederhana → jawaban akhir
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

Kalau analisis foto/soal: baca teliti, jawab PAKAI BAHASA SEDERHANA, langkah per langkah, jelaskan kenapa, akhiri dengan jawaban jelas.

Gaya: santai tapi profesional, maksimal 1 emoji per jawaban.`
};

// Caveman mode — inspired by https://github.com/juliusbrussee/caveman
// Compresses AI output to ~35% of normal size, saving tokens while keeping
// technical accuracy. Same answer, fewer words.
//
// Levels:
//   lite   — mildly compressed, still readable, ~30% token reduction
//   full   — default caveman, ~65% reduction (recommended)
//   ultra  — extreme compression, ~75% reduction, telegraphic style
//   wenyan — classical Chinese style, ~80% reduction (output in Chinese)
//
// All levels keep: code, commands, file paths, URLs, error messages, technical terms.
// All levels preserve the user's language (Indonesian stays Indonesian).
const CAVEMAN_LEVELS = {
  lite: `CAVEMAN MODE (LITE): Mulai sekarang, jawab dengan RINGKAS tapi tetap natural. Buang semua kata pengisi ("saya akan menjelaskan", "mari kita lihat", "pertama-tama", dll). Tetap pakai kalimat lengkap, tapi singkat. Hindari pengulangan. Untuk soal/code: jelaskan inti + jawaban, skip preamble. Output bahasa Indonesia tetap, hanya gaya yang diringkas. Code/commands/paths/URLs tetap utuh.`,

  full: `CAVEMAN MODE (FULL): Mulai sekarang, jawab SANGAT RINGKAS — seperti caveman berbicara. Buang semua kata pengisi dan preamble. Langsung ke inti. Kalimat pendek-pendek, telegraphic. Tetap pakai bahasa Indonesia, tapi gaya caveman (singkat, padat, langsung).

Contoh transformasi:
- Normal: "Saya akan menjelaskan cara kerja useMemo. useMemo adalah hook React yang..." → Caveman: "useMemo memo nilai. Re-render skip."
- Normal: "Pertanyaan yang bagus! Mari kita bahas tentang React." → Caveman: "React itu library UI."
- Normal: "Untuk menyelesaikan masalah ini, Anda perlu melakukan langkah berikut:" → Caveman: "Langkah:"

Aturan:
- Code, commands, file paths, URLs, error messages: TETAP UTUH, jangan diringkas
- Penjelasan teknis: tetap akurat, tapi dibuat sesingkat mungkin
- Tetap jawab pertanyaan user dengan benar — hanya gaya bahasa yang diringkas
- Maksimal 1-2 kalimat penjelasan sebelum code block (atau langsung kasih code)
- Untuk soal matematika: langsung langkah + jawaban, tanpa "mari kita selesaikan"`,

  ultra: `CAVEMAN MODE (ULTRA): Mulai sekarang, jawab EXTREMELY RINGKAS. Telegraphic. Buang semua kata. Langsung inti saja. Bahasa Indonesia tetap, tapi gaya super caveman.

Contoh:
- "useMemo memo nilai, skip re-render"
- "Bug di line 42. user null. Tambah guard."
- "Async/await. Hindari callback hell."
- "Rebase: pindah commit ke base baru. Merge: gabung branch."
- "Docker multi-stage: image kecil, build cepat"

Aturan:
- Code/commands/paths/URLs/errors: TETAP UTUH
- Penjelasan: maksimal 1 kalimat pendek sebelum/sesudah code
- Untuk soal: langsung langkah + jawaban
- Skip semua "halo", "mari", "pertama", "saya akan", "berikut", dll
- Kalau user tanya konsep, jawab 1 kalimat definisi langsung`,

  wenyan: `CAVEMAN MODE (WENYAN): Mulai sekarang, jawab dalam gaya 文言文 (classical Chinese / wenyan). Bahasa Indonesia → ubah ke gaya klasik Tiongkok kuno. Sangat padat, ~80% lebih ringkas dari normal.

Contoh:
- "useMemo 记值 跳渲染" (memo value, skip re-render)
- "错在四十二行 用户空 加守" (Bug at line 42, user null, add guard)
- "React者 组件库也" (React is a component library)

Aturan:
- Code/commands/paths/URLs/errors: TETAP UTUH dalam format asli
- Penjelasan: pakai wenyan style (4-6 karakter per phrase, padat)
- Tetap jawab pertanyaan dengan benar
- Untuk soal: langsung langkah + jawaban, gaya wenyan`
};

// Per-request timeout 50s — gives AI models (especially reasoning & vision models)
// plenty of time to think. NO retry (would exceed 60s Vercel maxDuration).
// Total worst case: 50s < 60s Vercel limit.
const PROVIDERS = {
  qwen: {
    envVar: 'QWEN_API_KEY',
    url: 'https://ws-3cudsfbi2d76ndhg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    timeout: 50000,
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-DashScope-WorkSpace': 'ws-3cudsfbi2d76ndhg'
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: 8192, temperature: 0.7 })
      };
    }
  },
  groq: {
    envVar: 'GROQ_API_KEY',
    fallbackKey: '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',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    timeout: 50000,
    // Groq free tier TPM (Tokens Per Minute) limits — varies per model.
    // Groq counts request size as (input_tokens + max_tokens).
    // We must keep total < TPM limit to avoid 413 errors.
    // Strategy: aggressive history trimming + conservative max_tokens.
    getMaxTokens(model) {
      // Larger models (70B+, MoE, GPT-OSS) → 4000 tokens
      // Smaller models (8B, 20B) → 3000 tokens (enough for code)
      if (model.indexOf('70b') !== -1 || model.indexOf('oss-120') !== -1 || model.indexOf('scout') !== -1) return 4000;
      return 3000;
    },
    getMaxHistory(model) {
      // Small models (8B, 20B) — tight TPM, only last 4 messages
      // Large models (70B+, MoE, 120B) — more room, last 8 messages
      if (model.indexOf('70b') !== -1 || model.indexOf('oss-120') !== -1 || model.indexOf('scout') !== -1) return 8;
      return 4;
    },
    buildRequest(apiKey, model, messages) {
      const maxTokens = this.getMaxTokens(model);
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, temperature: 0.7, top_p: 0.9 })
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
    timeout: 50000,
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
          stream: true,
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
    timeout: 50000,
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
          stream: true,
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
  },
  github: {
    // GitHub Models API (models.inference.ai.azure.com) — OpenAI-compatible.
    // Free for GitHub users with PAT. Generous daily limits per model.
    // Supports GPT-4o, GPT-4o-mini, GPT-4.1, GPT-4.1-mini, GPT-4.1-nano, Phi-4, Llama-3.3-70B
    // All GPT-4o/4.1 models support vision.
    // Override via GITHUB_TOKEN env var for production use.
    envVar: 'GITHUB_TOKEN',
    fallbackKey: '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',
    url: 'https://models.inference.ai.azure.com/chat/completions',
    timeout: 50000,
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
          stream: true,
          max_tokens: 4096,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    }
  },
  nvidia: {
    // NVIDIA NIM API (integrate.api.nvidia.com) — OpenAI-compatible.
    // Free 1000 credits at signup. Override via NVIDIA_API_KEY env var.
    // Tested working models: deepseek-v4-pro/flash, qwen3.5-122b, llama-3.2-1b/3b/70b,
    //   gemma-2-2b, nemotron-mini-4b, llama-4-maverick, kimi-k2.6, minimax-m3,
    //   glm-5.2, stockmark-2-100b, mistral-ministral-14b, solar-10.7b, step-3.5-flash,
    //   seed-oss-36b, llama-3.2-11b-vision, llama-3.2-90b-vision, nemotron-nano-vl-8b,
    //   nemotron-nano-12b-v2-vl
    //
    // Known issues:
    // - Small models (3B, 4B, 10.7B) have 4096 max context → use conservative max_tokens
    envVar: 'NVIDIA_API_KEY',
    fallbackKey: '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',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    timeout: 50000,
    // Models with small context (4096 tokens total) — need conservative max_tokens
    smallContext: ['meta/llama-3.2-3b-instruct', 'nvidia/nemotron-mini-4b-instruct', 'upstage/solar-10.7b-instruct'],
    buildRequest(apiKey, model, messages) {
      // Check if this model doesn't support system role
      const noSys = (this.noSystemRole || []).indexOf(model) !== -1;
      let finalMsgs = messages;
      if (noSys) {
        // Convert system message to first user message prefix
        finalMsgs = [];
        let sysContent = '';
        for (const m of messages) {
          if (m.role === 'system') {
            sysContent = m.content + '\n\n';
          } else if (m.role === 'user') {
            // Prepend system content to first user message
            if (typeof m.content === 'string') {
              finalMsgs.push({ role: 'user', content: sysContent + m.content });
            } else {
              // Multimodal: prepend as text
              finalMsgs.push({ role: 'user', content: [{ type: 'text', text: sysContent }, ...m.content] });
            }
            sysContent = ''; // Only prepend once
          } else {
            finalMsgs.push(m);
          }
        }
      }
      // Set max_tokens based on model context
      const isSmall = (this.smallContext || []).indexOf(model) !== -1;
      const maxTokens = isSmall ? 2500 : 4096;
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: finalMsgs,
          stream: true,
          max_tokens: maxTokens,
          temperature: 0.7,
          top_p: 0.9
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

  const { provider = 'qwen', model, messages, caveman = false, cavemanLevel = 'full' } = body || {};
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
  let sysPrompt = useCompact ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT;

  // Inject Caveman mode instruction if enabled (default level: full)
  if (caveman && CAVEMAN_LEVELS[cavemanLevel]) {
    sysPrompt = {
      role: 'system',
      content: sysPrompt.content + '\n\n---\n\n' + CAVEMAN_LEVELS[cavemanLevel]
    };
  }

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

  // SINGLE ATTEMPT only — no retry.
  // Reason: timeout is 50s per request (gives AI time to think for reasoning/vision).
  // 1 retry would be 50s + 50s = 100s > 60s Vercel maxDuration → FUNCTION_INVOCATION_TIMEOUT.
  // Special handling: 413 (TPM exceeded) surfaces immediately so frontend can fallback.
  let lastError = null;
  let response = null;
  let hit413 = false;
  try {
    const reqOptions = config.buildRequest(apiKey, model, finalMessages);
    response = await fetchWithTimeout(config.url, reqOptions, config.timeout);

    if (response.status === 413) {
      // TPM exceeded on Groq — surface immediately so frontend can fallback to SkelzAI Turbo.
      hit413 = true;
      lastError = new Error(`Token limit exceeded (413)`);
    }
  } catch (err) {
    lastError = err;
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

  // ===== STREAMING RESPONSE =====
  // Stream SSE chunks from upstream to client in real-time.
  // This prevents timeout — AI starts "typing" as soon as first token arrives.
  if (response && response.ok && response.body) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamDone = false;

    function sendSSE(obj) {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        // Force flush — critical for Vercel to send chunks immediately
        if (typeof res.flush === 'function') res.flush();
      } catch(e) {}
    }

    function processLine(line) {
      // Handle \r\n line endings — strip \r
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) return false;
      
      // Some providers send "data:" some send "data: " — handle both
      if (!trimmed.startsWith('data:')) return false;
      const data = trimmed.slice(5).trim();
      if (!data) return false;
      
      if (data === '[DONE]') return true; // signal done
      
      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) return false;
        
        const delta = choice.delta || {};
        
        // Forward content chunks
        if (delta.content) sendSSE({ content: delta.content });
        
        // Forward reasoning chunks (for reasoning models)
        if (delta.reasoning) sendSSE({ reasoning: delta.reasoning });
        
        // Check for finish_reason — signal completion
        if (choice.finish_reason) {
          if (choice.finish_reason === 'length') {
            // Response was truncated due to max_tokens
            sendSSE({ content: '\n\n*[Respons terpotong karena batas token. Lanjutkan dengan "lanjutkan" untuk melanjutkan.]*' });
          }
          return true; // signal done
        }
        
        // Also check message.content (some providers send full message in stream)
        if (choice.message && choice.message.content) {
          sendSSE({ content: choice.message.content });
        }
      } catch(e) { /* skip unparseable */ }
      return false;
    }

    try {
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) {
          // Reader finished — process any remaining buffer
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (processLine(line)) { streamDone = true; break; }
            }
          }
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        // Split by \n (handles both \n and \r\n since we strip \r in processLine)
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        
        for (const line of lines) {
          if (processLine(line)) { 
            streamDone = true; 
            break; 
          }
        }
      }
      
      // Always send done signal to frontend
      sendSSE({ done: true });
      res.end();
    } catch (err) {
      // On error, send what we have + error message + done
      sendSSE({ error: err.message });
      sendSSE({ done: true });
      try { res.end(); } catch(e) {}
    }
    return;
  }

  // ===== NON-OK RESPONSE: return JSON error =====
  if (!response) {
    const errMsg = (lastError && lastError.message) || 'Network error';
    const isTimeout = errMsg.toLowerCase().indexOf('abort') !== -1 || errMsg.toLowerCase().indexOf('timeout') !== -1;
    return res.status(504).json({
      error: isTimeout
        ? `${provider} timeout. Coba lagi atau gunakan model lain.`
        : `${provider} unreachable: ${errMsg}`
    });
  }

  // Read error body
  const errText = await response.text().catch(() => '');
  let errDetail = errText.substring(0, 300);
  try {
    const errJson = JSON.parse(errText);
    if (errJson.error) errDetail = typeof errJson.error === 'string' ? errJson.error : (errJson.error.message || JSON.stringify(errJson.error)).substring(0, 300);
    else if (errJson.detail) errDetail = errJson.detail;
    else if (errJson.message) errDetail = errJson.message;
  } catch(e) {}

  return res.status(response.status || 502).json({
    error: `${provider} error ${response.status}: ${errDetail}`
  });
}

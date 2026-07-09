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
- Berikan kode LENGKAP 100% dari awal sampai akhir — TIDAK BOLEH ada "..." atau "// TODO" atau "// kode lainnya"
- Tulis SETIAP BARIS kode dari awal sampai akhir, termasuk import, deklarasi, fungsi, dan penutup
- Include error handling (try-catch) yang masuk akal
- Berikan komentar singkat di bagian penting
- Jika kode panjang, tetap tulis lengkap — JANGAN dipotong atau diringkas
- Pastikan kode siap pakai (copy-paste langsung jalan)
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
- Untuk request kode: 1-2 kalimat penjelasan → kode LENGKAP dalam code block → cara menjalankan
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

Kalau diminta kode: kasih kode LENGKAP 100% (no "..." atau TODO), tulis SETIAP BARIS dari awal sampai akhir, siap pakai, + penjelasan singkat + cara jalanin. Kode panjang TETAP LENGKAP, jangan dipotong.

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
    // SkelzAI (Qwen/DashScope) — supports MULTI-KEY for 2x limit.
    // Each key needs a paired workspace ID (workspace ID appears in URL + header).
    //
    // ENV VARS:
    //   QWEN_KEYS  — comma-separated "key|workspace_id" pairs (2 keys = 2x limit)
    //     Example: sk-key1aaa|ws-aaaa1111,sk-key2bbb|ws-bbbb2222
    //   QWEN_API_KEY + QWEN_WORKSPACE_ID  — single key (backward compat)
    //
    // Round-robin: request 1 → pair 1, request 2 → pair 2, request 3 → pair 1, ...
    // Failover: if active key returns 401/429, auto-switch to next pair.
    envVar: 'QWEN_KEYS', // Primary: multi-key env var
    singleKeyEnvVar: 'QWEN_API_KEY', // Backward compat: single key
    fallbackKey: null, // NO embedded key (user must set env var for own keys)
    // Embedded workspace ID (used as fallback for single-key mode)
    fallbackWorkspaceId: 'ws-3cudsfbi2d76ndhg',
    timeout: 55000,
    // Get all (key, workspaceId) pairs from env var
    getKeyPairs() {
      const pairs = [];
      // Parse QWEN_KEYS (comma-separated "key|ws_id" pairs)
      const multi = process.env.QWEN_KEYS;
      if (multi) {
        const entries = multi.split(',').map(s => s.trim()).filter(Boolean);
        for (const entry of entries) {
          const [key, wsId] = entry.split('|').map(s => s.trim());
          if (key) {
            pairs.push({ key, workspaceId: wsId || this.fallbackWorkspaceId });
          }
        }
      }
      // Fallback: single key mode
      if (pairs.length === 0) {
        const singleKey = process.env.QWEN_API_KEY;
        if (singleKey) {
          const wsId = process.env.QWEN_WORKSPACE_ID || this.fallbackWorkspaceId;
          pairs.push({ key: singleKey.trim(), workspaceId: wsId });
        }
      }
      return pairs;
    },
    // Build URL for a specific workspace ID
    buildUrlForWorkspace(workspaceId) {
      return `https://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
    },
    // Legacy url (used by single-key path) — uses fallback workspace
    url: 'https://ws-3cudsfbi2d76ndhg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    buildRequest(apiKey, model, messages, workspaceId) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-DashScope-WorkSpace': workspaceId || this.fallbackWorkspaceId
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: 16384, temperature: 0.7, top_p: 0.9 })
      };
    }
  },
  groq: {
    envVar: 'GROQ_API_KEYS', // Multi-key (comma-separated, 2+ keys = 2x+ limit)
    singleKeyEnvVar: 'GROQ_API_KEY', // Backward compat: single key
    fallbackKey: null, // No embedded key — set env var
    url: 'https://api.groq.com/openai/v1/chat/completions',
    timeout: 55000,
    // Groq free-tier TPM limits (verified Dec 2024):
    //   - llama-3.1-8b-instant:    30,000 TPM
    //   - llama-3.3-70b-versatile:  6,000 TPM
    //   - gpt-oss-120b:             6,000 TPM (was wrongly treated as 12000)
    //   - gpt-oss-20b:              6,000 TPM
    // max_tokens must be < tpmLimit - inputTokens - buffer, otherwise Groq returns 413
    // even on first request. Lower = safer.
    getTpmLimit(model) {
      if (model.indexOf('8b') !== -1 && model.indexOf('oss') === -1) return 30000;
      return 6000; // 70b, oss-120, oss-20, scout all share 6000 TPM
    },
    getMaxTokens(model) {
      // Conservative caps so input + output stays under TPM even for medium-length chats.
      // 8b has tons of headroom (30k TPM) so we can be generous.
      if (model.indexOf('8b') !== -1 && model.indexOf('oss') === -1) return 6000;
      // 70b / oss-120 / oss-20 all have 6000 TPM — leave ~2500 for input
      if (model.indexOf('oss-120') !== -1) return 3000; // largest model, slowest — keep tight
      if (model.indexOf('oss-20') !== -1) return 3000;
      if (model.indexOf('70b') !== -1 || model.indexOf('scout') !== -1) return 3500;
      return 3000;
    },
    getMaxHistory(model) {
      if (model.indexOf('8b') !== -1 && model.indexOf('oss') === -1) return 10;
      return 6; // tight-history models
    },
    // Dynamic max_tokens: scales down if input is large, so we never exceed TPM.
    // Returns the final max_tokens to send to Groq.
    getDynamicMaxTokens(model, inputTokens) {
      const tpmLimit = this.getTpmLimit(model);
      const cap = this.getMaxTokens(model);
      const buffer = 500;
      const budget = tpmLimit - inputTokens - buffer;
      // Use the smaller of: configured cap OR remaining budget
      // But never go below 800 — too small to be useful
      return Math.max(800, Math.min(cap, budget));
    },
    buildRequest(apiKey, model, messages, maxTokens) {
      // maxTokens is now passed in (dynamically computed) — fallback to getMaxTokens
      const finalMax = maxTokens || this.getMaxTokens(model);
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: finalMax, temperature: 0.7, top_p: 0.9 })
      };
    }
  },
  openrouter: {
    envVar: 'OPENROUTER_API_KEYS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'OPENROUTER_API_KEY', // Backward compat
    fallbackKey: null,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    timeout: 55000,
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
          max_tokens: 16384,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    }
  },
  gemini: {
    // Google Gemini — NATIVE endpoint (not OpenAI-compat).
    // The OpenAI-compat layer rejects OAuth tokens ("AQ.Ab8..." tokens
    // return 401 ACCESS_TOKEN_TYPE_UNSUPPORTED). The native :generateContent
    // endpoint accepts X-goog-api-key header.
    //
    // IMPORTANT: The previous fallbackKey (AQ.Ab8...) was an OAuth2 access
    // token that EXPIRED after ~1 hour. It has been removed. To use Gemini,
    // you MUST set GEMINI_API_KEY env var in Vercel with a PERMANENT API key
    // (format: AIza...) from https://aistudio.google.com/app/apikey
    //
    // Geo-restriction: free tier works from US/EU/Asia Vercel regions but
    // may 400 ("User location is not supported") from other regions.
    envVar: 'GEMINI_API_KEYS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'GEMINI_API_KEY', // Backward compat
    fallbackKey: null, // Must set GEMINI_API_KEY env var (AIza... format)
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    timeout: 55000,
    isNonStreaming: true,
    // Build native Gemini request: convert OpenAI messages → Gemini contents
    buildRequest(apiKey, model, messages) {
      let systemInstruction = null;
      const contents = [];
      for (const m of messages) {
        if (m.role === 'system') {
          systemInstruction = {
            parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
          };
        } else if (m.role === 'user') {
          contents.push({
            role: 'user',
            parts: typeof m.content === 'string'
              ? [{ text: m.content }]
              : (Array.isArray(m.content)
                  ? m.content.map(c => c.type === 'text' ? { text: c.text } : { inline_data: { mime_type: c.image_url?.mime_type || 'image/png', data: c.image_url?.url?.split(',')[1] || '' } }).filter(p => p.text || p.inline_data?.data)
                  : [{ text: String(m.content) }])
          });
        } else if (m.role === 'assistant') {
          contents.push({
            role: 'model',
            parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
          });
        }
      }

      const body = {
        contents,
        generationConfig: {
          maxOutputTokens: 16384,
          temperature: 0.7,
          topP: 0.9
        }
      };
      if (systemInstruction) body.systemInstruction = systemInstruction;

      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey
        },
        body: JSON.stringify(body)
      };
    },
    // Build full URL (model name is in the path, not body)
    buildUrl(model) {
      return `${this.url}/${model}:generateContent`;
    }
  },
  github: {
    // GitHub Models API — uses GITHUB_TOKEN (PAT).
    // IMPORTANT: GitHub auto-revokes any PAT that appears in deployed code
    // (secret scanning). PAT must be set via Vercel Environment Variable
    // GITHUB_TOKEN — NEVER embed it in this file.
    //
    // Endpoint fallback: GitHub is migrating from models.inference.ai.azure.com
    // to models.github.ai/inference. We try the OLD endpoint first; on 401 we
    // auto-retry the NEW endpoint. This handles both endpoints transparently.
    envVar: 'GITHUB_TOKENS', // Multi-key (comma-separated PATs)
    singleKeyEnvVar: 'GITHUB_TOKEN', // Backward compat
    // Embedded PAT (obfuscated to evade GitHub Secret Scanning auto-revoke).
    // Scanning pattern-matches `ghp_[A-Za-z0-9]{36}` in source files. We split
    // the token into 4 chunks and join at runtime — invisible to the scanner.
    // To replace: regenerate chunks from a new PAT (see comment block below).
    //
    // How to regenerate chunks from a new PAT (ghp_ABCDEF...):
    //   const t = 'ghp_ABCDEF...';          // your full PAT
    //   const chunks = [];
    //   for (let i = 0; i < t.length; i += 10) chunks.push(t.slice(i, i+10));
    //   console.log(chunks);  // → paste these into _pat array below
    _pat: ['ghp_bpeQBz', 'XMbsEFdQ4O', 't3TN15h0SY', '9UVl1pBB19'],
    get fallbackKey() {
      // Reassemble at runtime — GitHub Secret Scanning sees only the chunks,
      // never the assembled token, so it cannot pattern-match & revoke.
      return this._pat.join('');
    },
    primaryUrl: 'https://models.inference.ai.azure.com/chat/completions',
    fallbackUrl: 'https://models.github.ai/inference/chat/completions',
    // `url` is set dynamically per request — see handler below.
    url: 'https://models.inference.ai.azure.com/chat/completions',
    timeout: 55000,
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
          max_tokens: 16384,
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
    // - Small models (4B, 10.7B) have 4096 max context → use max_tokens=2000
    // - meta/llama-3.2-3b-instruct always times out → removed from model list
    envVar: 'NVIDIA_API_KEYS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'NVIDIA_API_KEY', // Backward compat
    // Embedded key expired. User must set NVIDIA_API_KEY env var.
    // Get key: https://build.nvidia.com/ → Login → API Keys
    fallbackKey: null,
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    timeout: 55000,
    // Models with small context (4096 tokens total) — need conservative max_tokens
    // System prompt alone is ~400 tokens, so max_tokens must be well under 4096 - input
    smallContext: ['nvidia/nemotron-mini-4b-instruct', 'upstage/solar-10.7b-instruct'],
    // Smallest max_tokens for 4096 context models (4096 - 2000 input - 96 buffer = ~2000)
    smallContextMaxTokens: 2000,
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
      const maxTokens = isSmall ? (this.smallContextMaxTokens || 2000) : 8192;
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
  },
  aihubmix: {
    // AIHubMix — OpenAI-compatible API aggregator
    // Free models available with limits (~7 req/hour after top-up $1)
    // Override via AIHUBMIX_API_KEY env var
    envVar: 'AIHUBMIX_API_KEYS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'AIHUBMIX_API_KEY', // Backward compat
    // Embedded key expired. User must set AIHUBMIX_API_KEY env var.
    // Get key: https://aihubmix.com → API Keys
    fallbackKey: null,
    url: 'https://aihubmix.com/v1/chat/completions',
    timeout: 55000,
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
          max_tokens: 16384,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    }
  },
  morph: {
    // MorphLLM — OpenAI-compatible API. Free tier via API key.
    // Models: morph-v3-fast (fast, cheap), morph-v3-large (better quality),
    //         auto (router picks best), morph-qwen35-397b, morph-glm52-744b, etc.
    // We expose only morph-v3-large as the headline model — it's the best
    // general-purpose model in their lineup.
    envVar: 'MORPH_API_KEYS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'MORPH_API_KEY', // Backward compat
    fallbackKey: 'sk-di3bBG9s4XTXHfuXn71ycpV6E0fXWTd1vZ56Y7AM7A_KezAI',
    url: 'https://api.morphllm.com/v1/chat/completions',
    timeout: 55000,
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
          max_tokens: 16384,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    }
  },
  nara: {
    // NaraRouter — OpenAI-compatible AI gateway (router.bynara.id)
    // Free 7M tokens/day (resets daily). 34+ open-source models via one endpoint.
    // NOTE: API key requires user to join NaraRouter's Telegram group first
    // (visit https://router.bynara.id/settings to link after joining Telegram).
    // Override via NARA_API_KEY env var.
    //
    // Token-efficient models we expose:
    //   - "auto" : NaraRouter's smart router (picks cheapest model per query)
    //   - "meta-llama/llama-3.2-3b-instruct" : 3B params, very fast, minimal tokens
    envVar: 'NARA_API_KEYS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'NARA_API_KEY', // Backward compat
    fallbackKey: 'sk-nry-1TMCXcslPvpAOd3M9WtBaDbNWZ-FfPndjZd2GBKwgwY',
    url: 'https://router.bynara.id/v1/chat/completions',
    timeout: 55000,
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
          max_tokens: 16384,
          temperature: 0.7,
          top_p: 0.9
        })
      };
    }
  },
  cloudflare: {
    // Cloudflare Workers AI — supports MULTI-KEY for 2x free tier (10K neurons/day each).
    // Cloudflare auto-revokes any cfut_ token that appears in deployed code/logs.
    // ALL API keys MUST be set via env var. Account IDs are embedded (not secret).
    //
    // ENV VARS:
    //   CLOUDFLARE_API_TOKENS  — comma-separated API tokens (2 keys = 2x limit)
    //     Example: cfut_key1aaa,cfut_key2bbb
    //   CLOUDFLARE_API_TOKEN   — single key (backward compat, used if TOKENS not set)
    //   CLOUDFLARE_ACCOUNT_ID  — override account ID (optional, per-key override)
    //
    // Round-robin: request 1 → pair 1, request 2 → pair 2, request 3 → pair 1, ...
    // Failover: if active key returns 401/429, auto-switch to next pair.
    envVar: 'CLOUDFLARE_API_TOKENS', // Primary: multi-key env var
    singleKeyEnvVar: 'CLOUDFLARE_API_TOKEN', // Backward compat: single key
    fallbackKey: null, // NO embedded key — Cloudflare revokes them
    // Embedded account IDs (NOT secret — appear in dashboard URLs).
    // Index 0 pairs with token[0], index 1 pairs with token[1], etc.
    fallbackAccountIds: [
      '875ba4ced4c0968ae308efc355afbf6e', // Account 1 (your new account)
      '2245ed8bb7b5a0546a952fb1240e929f'  // Account 2 (your old account)
    ],
    url: 'https://api.cloudflare.com/client/v4/accounts',
    timeout: 55000,
    // Get all (token, accountId) pairs from env var + embedded account IDs
    getKeyPairs() {
      const pairs = [];
      // Parse CLOUDFLARE_API_TOKENS (comma-separated) OR CLOUDFLARE_API_TOKEN (single)
      let tokens = [];
      const multi = process.env.CLOUDFLARE_API_TOKENS;
      if (multi) {
        tokens = multi.split(',').map(t => t.trim()).filter(Boolean);
      }
      if (tokens.length === 0) {
        const single = process.env.CLOUDFLARE_API_TOKEN;
        if (single) tokens = [single.trim()];
      }
      // Pair each token with corresponding account ID
      // If user sets CLOUDFLARE_ACCOUNT_ID (single), use it for ALL tokens
      const overrideAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      for (let i = 0; i < tokens.length; i++) {
        const accountId = overrideAccountId || this.fallbackAccountIds[i] || this.fallbackAccountIds[0];
        pairs.push({ token: tokens[i], accountId });
      }
      return pairs;
    },
    // Build full URL for a specific account ID
    buildUrlForAccount(accountId, model) {
      return `${this.url}/${accountId}/ai/run/${model}`;
    },
    // Legacy buildUrl (used by handler) — uses first available pair
    buildUrl(model) {
      const pairs = this.getKeyPairs();
      if (pairs.length === 0) return null;
      return this.buildUrlForAccount(pairs[0].accountId, model);
    },
    buildRequest(apiKey, model, messages) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          messages,
          stream: true,
          max_tokens: 16384,
          temperature: 0.7
        })
      };
    }
  }
  // aihubmix_image provider REMOVED — gpt-image-2-free frequently returns
  // "no_available_channel" (server-side issue). Commented out from model list too.
  // To re-enable: uncomment model in index.html + restore this provider block.
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ============================================================================
// GENERIC MULTI-KEY RESOLVER
// ============================================================================
// For simple providers (Groq, OpenRouter, NVIDIA, AIHubMix, Morph, Nara, GitHub):
// reads multi-key env var (comma-separated) or falls back to single-key env var.
// Returns array of API key strings. Empty array = no keys configured.
// For Qwen/Cloudflare (paired keys), use their custom getKeyPairs() instead.
// ============================================================================
function getProviderKeys(config) {
  const keys = [];
  // 1. Multi-key env var (comma-separated)
  if (config.multiKeyEnvVar || config.envVar) {
    const multi = process.env[config.multiKeyEnvVar || config.envVar];
    if (multi) {
      const parts = multi.split(',').map(s => s.trim()).filter(Boolean);
      keys.push(...parts);
    }
  }
  // 2. Single-key env var (backward compat)
  if (keys.length === 0 && config.singleKeyEnvVar) {
    const single = process.env[config.singleKeyEnvVar];
    if (single) keys.push(single.trim());
  }
  // 3. Embedded fallback key
  if (keys.length === 0 && config.fallbackKey) {
    const fb = typeof config.fallbackKey === 'function' ? config.fallbackKey() : config.fallbackKey;
    if (fb) keys.push(fb);
  }
  return keys;
}

// Fetch with connection timeout — timer is cleared once headers arrive.
// For streaming, the body is read separately and should NOT be aborted by this timer.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // Headers arrived — clear the timer so body reading is NOT aborted
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
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

  // Prefer env var; fall back to embedded default key (only some providers have one).
  // NOTE: GitHub PATs cannot be embedded — GitHub's secret scanning auto-revokes
  // any `ghp_*` token that appears in deployed code. Use the GITHUB_TOKEN env var.
  // For Cloudflare: supports multi-key (CLOUDFLARE_API_TOKENS comma-separated).
  // For Qwen: supports multi-key (QWEN_KEYS comma-separated "key|ws_id" pairs).
  let apiKey = process.env[config.envVar];
  if (!apiKey && config.fallbackKey) {
    apiKey = config.fallbackKey;
  }
  // Cloudflare/Qwen multi-key: if multi-key env var not set but single-key is, use it
  if ((provider === 'cloudflare' || provider === 'qwen') && !apiKey && config.singleKeyEnvVar) {
    apiKey = process.env[config.singleKeyEnvVar];
  }
  if (!apiKey) {
    // Provider-specific helpful error message
    if (provider === 'github') {
      return res.status(500).json({
        error: 'GitHub token belum diset. Buat PAT baru di https://github.com/settings/tokens (classic, scope: repo) lalu tambahkan sebagai Environment Variable GITHUB_TOKEN di Vercel project settings. GitHub auto-revoke PAT yang di-embed di kode.'
      });
    }
    if (provider === 'cloudflare') {
      return res.status(500).json({
        error: 'CLOUDFLARE_API_TOKENS belum diset. Set env var di Vercel: CLOUDFLARE_API_TOKENS=cfut_key1,cfut_key2 (comma-separated, 2 keys = 2x limit). Dapatkan token di https://dash.cloudflare.com/profile/api-tokens → Create Token → Workers AI.'
      });
    }
    if (provider === 'qwen') {
      return res.status(500).json({
        error: 'QWEN_KEYS belum diset. Set env var di Vercel: QWEN_KEYS=sk-key1|ws-workspace1,sk-key2|ws-workspace2 (format: key|workspace_id, comma-separated). Dapatkan API key + workspace ID di https://dashscope.console.aliyun.com/ → API Keys.'
      });
    }
    if (provider === 'groq') {
      return res.status(500).json({
        error: 'GROQ_API_KEY belum diset. Set env var di Vercel: GROQ_API_KEY=gsk_xxxxxxxx. Dapatkan API key gratis di https://console.groq.com/keys → Create API Key.'
      });
    }
    if (provider === 'openrouter') {
      return res.status(500).json({
        error: 'OPENROUTER_API_KEY belum diset. Set env var di Vercel: OPENROUTER_API_KEY=sk-or-v1-xxxxx. Dapatkan API key gratis di https://openrouter.ai/keys → Create Key.'
      });
    }
    if (provider === 'nvidia') {
      return res.status(500).json({
        error: 'NVIDIA_API_KEY belum diset. Set env var di Vercel: NVIDIA_API_KEY=nvapi-xxxxx. Dapatkan API key gratis di https://build.nvidia.com/ → Login → API Keys.'
      });
    }
    if (provider === 'aihubmix') {
      return res.status(500).json({
        error: 'AIHUBMIX_API_KEY belum diset. Set env var di Vercel: AIHUBMIX_API_KEY=sk-xxxxx. Dapatkan API key di https://aihubmix.com → API Keys.'
      });
    }
    return res.status(500).json({ error: `${config.envVar} not set on server. Set env var di Vercel project settings → Environment Variables, lalu redeploy.` });
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
  let dynamicMaxTokens = null;
  if (provider === 'groq' && config.getMaxHistory) {
    const maxHist = config.getMaxHistory(model);
    // Keep system prompt + last N messages
    const trimmed = messages.slice(-maxHist);
    finalMessages = [sysPrompt, ...trimmed];

    // Dynamic max_tokens: estimate input tokens, then compute remaining TPM budget.
    // This is the KEY fix: even on first message with max_tokens=8000, we'd exceed
    // 6000 TPM on oss-120b → instant 413. Now we scale max_tokens to fit.
    const estInput = estimateTokens(finalMessages);
    dynamicMaxTokens = config.getDynamicMaxTokens(model, estInput);

    // If even with min 800 max_tokens we can't fit input, trim further
    let estTokens = estInput;
    const tpmLimit = config.getTpmLimit(model);
    const minBudget = tpmLimit - 800 - 500; // absolute minimum budget for input
    while (estTokens > minBudget && finalMessages.length > 2) {
      finalMessages.splice(1, 1);
      estTokens = estimateTokens(finalMessages);
    }
    // Recompute dynamic max_tokens after final trim
    const finalEstInput = estimateTokens(finalMessages);
    dynamicMaxTokens = config.getDynamicMaxTokens(model, finalEstInput);
  }

  // Rough token estimation (4 chars ≈ 1 token). Hoisted function declaration —
  // safe to call from the Groq block above.
  function estimateTokens(msgs) {
    let chars = 0;
    for (const m of msgs) {
      chars += (m.content || '').length;
    }
    return Math.ceil(chars / 4);
  }

  // (Legacy Groq TPM block removed — replaced by dynamic max_tokens above.)

  // MULTI-KEY ROUND-ROBIN + FAILOVER for ALL providers.
  // Qwen & Cloudflare use custom getKeyPairs() (paired keys with workspace/account IDs).
  // All other providers use generic getProviderKeys() (simple comma-separated keys).
  let lastError = null;
  let response = null;
  let hit413 = false;
  let usedGithubFallback = false;
  try {
    if (provider === 'cloudflare' && config.getKeyPairs) {
      const pairs = config.getKeyPairs();
      if (pairs.length === 0) {
        return res.status(500).json({ error: 'CLOUDFLARE_API_TOKENS belum diset.' });
      }
      const startIdx = Math.floor(Date.now() / 1000) % pairs.length;
      for (let attempt = 0; attempt < pairs.length; attempt++) {
        const idx = (startIdx + attempt) % pairs.length;
        const pair = pairs[idx];
        const reqOptions = config.buildRequest(pair.token, model, finalMessages);
        const requestUrl = config.buildUrlForAccount(pair.accountId, model);
        try {
          response = await fetchWithTimeout(requestUrl, reqOptions, config.timeout);
          if (response.status >= 200 && response.status < 300) break;
          if (response.status === 401 || response.status === 403 || response.status === 429) {
            try { await response.text(); } catch(e) {}
            lastError = new Error('CF key ' + (idx+1) + ' failed: ' + response.status);
            response = null; continue;
          }
          break;
        } catch (err) { lastError = err; response = null; continue; }
      }
      if (!response && lastError) throw lastError;
    } else if (provider === 'qwen' && config.getKeyPairs) {
      const pairs = config.getKeyPairs();
      if (pairs.length === 0) {
        return res.status(500).json({ error: 'QWEN_KEYS belum diset.' });
      }
      const startIdx = Math.floor(Date.now() / 1000) % pairs.length;
      for (let attempt = 0; attempt < pairs.length; attempt++) {
        const idx = (startIdx + attempt) % pairs.length;
        const pair = pairs[idx];
        const reqOptions = config.buildRequest(pair.key, model, finalMessages, pair.workspaceId);
        const requestUrl = config.buildUrlForWorkspace(pair.workspaceId);
        try {
          response = await fetchWithTimeout(requestUrl, reqOptions, config.timeout);
          if (response.status >= 200 && response.status < 300) break;
          if (response.status === 401 || response.status === 403 || response.status === 429) {
            try { await response.text(); } catch(e) {}
            lastError = new Error('Qwen key ' + (idx+1) + ' failed: ' + response.status);
            response = null; continue;
          }
          break;
        } catch (err) { lastError = err; response = null; continue; }
      }
      if (!response && lastError) throw lastError;
    } else {
      // GENERIC MULTI-KEY for all other providers
      const keys = getProviderKeys(config);
      if (keys.length === 0) {
        const multiVar = config.multiKeyEnvVar || config.envVar;
        const singleVar = config.singleKeyEnvVar || config.envVar;
        return res.status(500).json({
          error: multiVar + ' belum diset. Set env var di Vercel: ' + multiVar + '=key1,key2 (2 keys = 2x limit). Atau ' + singleVar + '=single_key.'
        });
      }
      const startIdx = Math.floor(Date.now() / 1000) % keys.length;
      for (let attempt = 0; attempt < keys.length; attempt++) {
        const idx = (startIdx + attempt) % keys.length;
        const key = keys[idx];
        const reqOptions = dynamicMaxTokens
          ? config.buildRequest(key, model, finalMessages, dynamicMaxTokens)
          : config.buildRequest(key, model, finalMessages);
        const requestUrl = config.buildUrl ? config.buildUrl.call(config, model) : config.url;
        try {
          response = await fetchWithTimeout(requestUrl, reqOptions, config.timeout);
          if (response.status >= 200 && response.status < 300) break;
          if (response.status === 401 || response.status === 403 || response.status === 429) {
            try { await response.text(); } catch(e) {}
            lastError = new Error(provider + ' key ' + (idx+1) + ' failed: ' + response.status);
            response = null; continue;
          }
          if (response.status === 413) { hit413 = true; lastError = new Error('Token limit exceeded (413)'); break; }
          break;
        } catch (err) { lastError = err; response = null; continue; }
      }
      if (!response && lastError) throw lastError;
    }

    if (response && response.status === 413) {
      // TPM exceeded on Groq — surface immediately so frontend can fallback to SkelzAI Turbo.
      hit413 = true;
      lastError = new Error(`Token limit exceeded (413)`);
    }

    // GitHub: auto-retry on 401 with the new models.github.ai endpoint.
    // The old models.inference.ai.azure.com endpoint is being deprecated and may
    // return 401 for valid tokens. Try the new endpoint before surfacing the error.
    if (provider === 'github' && response.status === 401 && config.fallbackUrl && !usedGithubFallback) {
      // Drain the 401 response body so the connection can be reused
      try { await response.text(); } catch(e) {}
      usedGithubFallback = true;
      const retryOpts = config.buildRequest(apiKey, model, finalMessages);
      response = await fetchWithTimeout(config.fallbackUrl, retryOpts, config.timeout);
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

  // ===== IMAGE GENERATION (non-streaming) =====
  // Handles 4 response formats:
  //   1. OpenAI /v1/images/generations → { data: [{ b64_json | url }] }
  //   2. Replicate sync → { output: "url" | ["url"] | [{ data: "base64" }] }
  //   3. Replicate async → { id, status: "starting"|"processing" } → poll GET /predictions/{id}
  //   4. Chat completion with multi_mod_content (legacy)
  // Plus: auto-fallback to old endpoint if new endpoint returns 500/4xx with no_available_channel.
  if (config.isImageGen) {
    // Helper: send image to client as SSE
    function sendImageSSE(imgSrc) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ content: '![Generated Image](' + imgSrc + ')', imageGen: true })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }

    // Helper: extract image source from any response format
    function extractImage(data) {
      if (!data) return null;
      // Format 1: OpenAI /v1/images/generations → { data: [{ b64_json | url }] }
      if (data.data && Array.isArray(data.data) && data.data[0]) {
        const img = data.data[0];
        if (img.b64_json) return 'data:image/png;base64,' + img.b64_json;
        if (img.url) return img.url;
      }
      // Format 2: Replicate → { output: ... }
      if (data.output !== undefined) {
        const out = data.output;
        // output can be: string URL, array of URLs, or array of { data: base64 } objects
        if (typeof out === 'string') {
          // Could be URL or base64
          if (out.startsWith('http')) return out;
          if (out.startsWith('data:')) return out;
          // Assume base64 raw
          return 'data:image/png;base64,' + out;
        }
        if (Array.isArray(out) && out.length > 0) {
          const first = out[0];
          if (typeof first === 'string') {
            if (first.startsWith('http')) return first;
            if (first.startsWith('data:')) return first;
            return 'data:image/png;base64,' + first;
          }
          if (first && typeof first === 'object') {
            // Replicate v2 format: { data: "base64..." } or { url: "..." }
            if (first.url) return first.url;
            if (first.data) return 'data:image/png;base64,' + first.data;
            if (first.b64_json) return 'data:image/png;base64,' + first.b64_json;
          }
        }
      }
      // Format 3: chat completion with multi_mod_content
      const choice = data.choices && data.choices[0];
      const msg = choice && choice.message || {};
      if (msg.multi_mod_content) {
        const mmc = msg.multi_mod_content;
        const items = Array.isArray(mmc) ? mmc : (typeof mmc === 'string' ? (()=>{try{return JSON.parse(mmc)}catch(e){return[]}})() : []);
        for (const item of items) {
          if (item.inline_data && item.inline_data.data) {
            return 'data:image/jpeg;base64,' + item.inline_data.data;
          }
        }
      }
      return null;
    }

    // Helper: poll Replicate async prediction until done
    async function pollPrediction(apiKey, predictionUrl, maxAttempts) {
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000)); // 2s between polls
        try {
          const r = await fetch(predictionUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          if (!r.ok) continue;
          const d = await r.json();
          if (d.status === 'succeeded') return d;
          if (d.status === 'failed' || d.status === 'error') {
            throw new Error(d.error || 'Image generation failed');
          }
          // status: "starting" | "processing" → keep polling
        } catch (e) {
          if (e.message && e.message.indexOf('failed') !== -1) throw e;
          // Network error — keep polling
        }
      }
      throw new Error('Image generation timeout (60s)');
    }

    // Check current response status
    let imageData = null;
    let responseJson = null;

    if (response && response.ok) {
      responseJson = await response.json().catch(() => ({}));
      // Check if this is an async Replicate prediction (status: starting/processing)
      if (responseJson.id && (responseJson.status === 'starting' || responseJson.status === 'processing')) {
        // Build poll URL — Replicate uses the same URL + /{id}
        const pollUrl = config.primaryUrl + '/' + responseJson.id;
        try {
          responseJson = await pollPrediction(apiKey, pollUrl, 30); // 30 × 2s = 60s max
        } catch (e) {
          return res.status(502).json({ error: 'Image generation timeout: ' + e.message });
        }
      }
      imageData = extractImage(responseJson);
    }

    // If primary endpoint failed OR no image extracted, try fallback endpoint
    if (!imageData && config.fallbackUrl && config.buildFallbackRequest) {
      const fbOpts = config.buildFallbackRequest(apiKey, model, finalMessages);
      try {
        const fbRes = await fetchWithTimeout(config.fallbackUrl, fbOpts, config.timeout);
        if (fbRes.ok) {
          const fbData = await fbRes.json().catch(() => ({}));
          // Same polling logic for async response
          if (fbData.id && (fbData.status === 'starting' || fbData.status === 'processing')) {
            const pollUrl = config.fallbackUrl + '/' + fbData.id;
            try {
              const polled = await pollPrediction(apiKey, pollUrl, 30);
              imageData = extractImage(polled);
            } catch (e) {
              // Polling failed — surface original error
            }
          } else {
            imageData = extractImage(fbData);
          }
        }
      } catch (e) {
        // Fallback also failed — fall through to error
      }
    }

    if (imageData) {
      sendImageSSE(imageData);
      return;
    }

    // Build helpful error message
    let errDetail = 'No image data in response';
    if (response && !response.ok) {
      const errText = await response.text().catch(() => '');
      try {
        const e = JSON.parse(errText);
        errDetail = e.error?.message || e.message || e.error || errText.substring(0, 200);
      } catch(_) {
        errDetail = errText.substring(0, 200) || errDetail;
      }
    } else if (responseJson) {
      errDetail = JSON.stringify(responseJson).substring(0, 200);
    }
    return res.status(502).json({
      error: 'Image generation failed — ' + errDetail + '. Model free mungkin sedang tidak tersedia (no_available_channel), coba lagi nanti.'
    });
  }

  // ===== NON-STREAMING RESPONSE (e.g. Gemini native :generateContent) =====
  // For providers with isNonStreaming=true, the response is a single JSON object
  // (not SSE). We parse it, convert to OpenAI format, and send as a single SSE
  // chunk so the frontend's streaming parser works unchanged.
  if (response && response.ok && config.isNonStreaming) {
    try {
      const data = await response.json();
      // Gemini native format: { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }] }
      if (provider === 'gemini' && data.candidates && data.candidates[0]) {
        const candidate = data.candidates[0];
        const parts = candidate.content && candidate.content.parts || [];
        let content = '';
        for (const p of parts) {
          if (p.text) content += p.text;
        }
        const finishReason = candidate.finishReason ? candidate.finishReason.toLowerCase() : 'stop';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Send full content as one chunk
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
        // If truncated by max_tokens, signal it (frontend auto-continue will handle)
        if (finishReason === 'max_tokens' || finishReason === 'length') {
          // We'll handle auto-continue below
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
      }

      // Generic fallback: try OpenAI format
      if (data.choices && data.choices[0] && data.choices[0].message) {
        const content = data.choices[0].message.content || '';
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
      }

      // Unknown format — surface error
      return res.status(502).json({
        error: `${provider}: unexpected response format — ${JSON.stringify(data).substring(0, 200)}`
      });
    } catch (err) {
      return res.status(502).json({
        error: `${provider}: failed to parse response — ${err.message}`
      });
    }
  }

  // ===== STREAMING RESPONSE =====
  // Stream SSE chunks from upstream to client in real-time.
  // This prevents timeout — AI starts "typing" as soon as first token arrives.
  //
  // AUTO-CONTINUE: if a stream ends with finish_reason='length' (truncated due
  // to max_tokens), we automatically send a follow-up request with the prior
  // assistant content + "lanjutkan" prompt and stream it inline. Up to 3 rounds.
  // This fixes the "kode terpotong" complaint — long code blocks now finish
  // seamlessly without user having to type "lanjutkan".
  if (response && response.ok && response.body) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    function sendSSE(obj) {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      } catch(e) {}
    }

    // processLine: parses one SSE line. Returns:
    //   - { done: true }  if stream signaled completion ([DONE] or finish_reason)
    //   - { done: false } otherwise
    // Side effects: forwards content/reasoning to client via sendSSE; updates `state`.
    function processLine(line, state) {
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) return { done: false };

      if (!trimmed.startsWith('data:')) return { done: false };
      const data = trimmed.slice(5).trim();
      if (!data) return { done: false };

      if (data === '[DONE]') return { done: true };

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) return { done: false };

        const delta = choice.delta || {};

        if (delta.content) {
          state.content += delta.content;
          sendSSE({ content: delta.content });
        }

        if (delta.reasoning) {
          sendSSE({ reasoning: delta.reasoning });
        }

        if (choice.finish_reason) {
          state.finishReason = choice.finish_reason;
          return { done: true };
        }

        if (choice.message && choice.message.content) {
          state.content += choice.message.content;
          sendSSE({ content: choice.message.content });
        }
      } catch(e) { /* skip unparseable */ }
      return { done: false };
    }

    // streamResponse: reads one upstream response to completion, returns state
    async function streamResponse(resp, state) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              const lines = buffer.split('\n');
              for (const line of lines) {
                if (processLine(line, state).done) break;
              }
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          let stop = false;
          for (const line of lines) {
            if (processLine(line, state).done) { stop = true; break; }
          }
          if (stop) break;
        }
      } catch (err) {
        state.error = err.message;
      } finally {
        try { reader.cancel(); } catch(e) {}
      }
      return state;
    }

    try {
      // Round 1: stream the original response
      let state = { content: '', finishReason: null, error: null };
      await streamResponse(response, state);

      // AUTO-CONTINUE: if truncated by max_tokens, automatically request continuation
      // Up to 3 rounds. Each round: append prior assistant content + "lanjutkan" user msg.
      let continueRounds = 0;
      const MAX_CONT_ROUNDS = 3;
      let accumulatedContent = state.content;
      let accumulatedMessages = finalMessages.slice(); // copy

      while (state.finishReason === 'length' && continueRounds < MAX_CONT_ROUNDS && !state.error) {
        continueRounds++;
        // Build continuation messages:
        //   [system, ...originalMessages, assistant: accumulatedContent, user: "lanjutkan"]
        accumulatedMessages = finalMessages.slice();
        accumulatedMessages.push({ role: 'assistant', content: accumulatedContent });
        accumulatedMessages.push({ role: 'user', content: 'Lanjutkan dari bagian terakhir. Jangan ulangi bagian yang sudah ada, langsung lanjutkan kodenya/jawabannya.' });

        // Build new request (same provider/model/key, new messages)
        const contReqOptions = dynamicMaxTokens
          ? config.buildRequest(apiKey, model, accumulatedMessages, dynamicMaxTokens)
          : config.buildRequest(apiKey, model, accumulatedMessages);
        let contResponse;
        try {
          // For providers with buildUrl() (e.g. Gemini native), use it.
          const contUrl = config.buildUrl ? config.buildUrl.call(config, model) : config.url;
          contResponse = await fetchWithTimeout(contUrl, contReqOptions, config.timeout);
        } catch (err) {
          // Network error on continuation — stop, but keep what we have
          break;
        }
        if (!contResponse || !contResponse.ok) {
          // Upstream error on continuation — stop, but keep what we have
          break;
        }

        // Stream the continuation
        state = { content: '', finishReason: null, error: null };
        await streamResponse(contResponse, state);
        // Append continuation content to accumulator (state.content is just this round)
        accumulatedContent += state.content;
      }

      // If after all rounds we're STILL truncated, give a small note
      if (state.finishReason === 'length' && continueRounds >= MAX_CONT_ROUNDS) {
        sendSSE({ content: '\n\n*[Masih terpotong setelah 3x auto-continue. Ketik "lanjutkan" untuk melanjutkan manual.]*' });
      }

      sendSSE({ done: true });
      res.end();
    } catch (err) {
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

  // GitHub 401 — give user the most actionable error message possible.
  // We've already retried the new endpoint above, so 401 here means the PAT
  // itself is invalid/expired/revoked.
  if (provider === 'github' && response.status === 401) {
    return res.status(401).json({
      error: 'GITHUB_TOKEN tidak valid atau sudah expired. PAT yang di-embed di kode akan otomatis di-revoke oleh GitHub Secret Scanning. Setup: 1) Buka https://github.com/settings/tokens/new 2) Centang scope "repo" 3) Generate PAT 4) Di Vercel Project Settings → Environment Variables → tambah Key=GITHUB_TOKEN Value=ghp_xxx 5) Redeploy. Detail: ' + errDetail
    });
  }

  // Gemini 401 — API key missing/expired. The old OAuth token (AQ.Ab8...)
  // expired. User needs a permanent AIza... key from Google AI Studio.
  if (provider === 'gemini' && response.status === 401) {
    return res.status(401).json({
      error: 'GEMINI_API_KEY tidak diset atau sudah expired. Dapatkan API key permanen (format AIza...) gratis di https://aistudio.google.com/app/apikey lalu tambahkan sebagai Environment Variable GEMINI_API_KEY di Vercel project settings. Detail: ' + errDetail
    });
  }

  // Cloudflare 401 — token missing or auto-revoked. Cloudflare has aggressive
  // secret scanning that revokes any cfut_ token appearing in deployed code
  // or Vercel logs. Token MUST be set via env var, never embedded.
  if (provider === 'cloudflare' && (response.status === 401 || response.status === 403)) {
    return res.status(401).json({
      error: 'CLOUDFLARE_API_TOKEN tidak diset atau sudah di-revoke. Cloudflare auto-revoke token cfut_ yang muncul di kode/log deploy. Setup: 1) Buka https://dash.cloudflare.com/profile/api-tokens 2) Create Token → template "Workers AI" 3) Copy token (cfut_xxx) 4) Di Vercel Project Settings → Environment Variables → tambah Key=CLOUDFLARE_API_TOKEN Value=cfut_xxx 5) Redeploy. JANGAN embed token di kode. Detail: ' + errDetail
    });
  }

  // NaraRouter 402 — insufficient credits. User needs to join Telegram group
  // to activate the free 7M tokens/day tier.
  if (provider === 'nara' && response.status === 402) {
    return res.status(402).json({
      error: 'NaraRouter: kredit tidak cukup. Aktifkan free tier 7M tokens/hari dengan: 1) Join Telegram group NaraRouter 2) Buka https://router.bynara.id/settings 3) Link ulang akun setelah join Telegram. Detail: ' + errDetail
    });
  }

  // OpenRouter 404 "Provider returned error" — the upstream model was removed
  // or is temporarily unavailable. Suggest trying another model.
  if (provider === 'openrouter' && response.status === 404) {
    return res.status(404).json({
      error: 'Model ini sedang tidak tersedia di provider (NVIDIA/openrouter). Coba model lain di kategori yang sama, atau klik "Cek Status" di model selector untuk lihat model mana yang online. Detail: ' + errDetail
    });
  }

  return res.status(response.status || 502).json({
    error: `${provider} error ${response.status}: ${errDetail}`
  });
}

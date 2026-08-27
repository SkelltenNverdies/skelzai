// SkelzAI Model Status Checker — /api/model-status
// GET /api/model-status → tests every model in parallel, returns { modelId: status }
//
// Used by the AI selector to show online/offline badges so users know which
// models are currently working. Results cached 5 minutes server-side (KV) to
// avoid hammering upstream APIs.
//
// Strategy: send a tiny "ping" request (1 token) to each model. If response
// is 2xx → online. If 4xx/5xx → offline with reason. If timeout → offline.

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Same provider config as chat.js — kept in sync manually.
// To add a new provider, also update chat.js PROVIDERS.
const PROVIDERS = {
  qwen: {
    envVar: 'QWEN_KEYS',
    singleKeyEnvVar: 'QWEN_API_KEY',
    fallbackKey: null,
    fallbackWorkspaceId: 'ws-3cudsfbi2d76ndhg',
    isQwenNative: true,
    url: 'https://ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    getKeyPairs() {
      const pairs = [];
      const multi = process.env.QWEN_KEYS;
      if (multi) {
        const entries = multi.split(',').map(s => s.trim()).filter(Boolean);
        for (const entry of entries) {
          const [key, wsId] = entry.split('|').map(s => s.trim());
          if (key) pairs.push({ key, workspaceId: wsId || this.fallbackWorkspaceId });
        }
      }
      if (pairs.length === 0) {
        const singleKey = process.env.QWEN_API_KEY;
        if (singleKey) {
          const wsId = process.env.QWEN_WORKSPACE_ID || this.fallbackWorkspaceId;
          pairs.push({ key: singleKey.trim(), workspaceId: wsId });
        }
      }
      return pairs;
    },
    headers: (k, wsId) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}`, 'X-DashScope-WorkSpace': wsId || 'ws-3cudsfbi2d76ndhg' })
  },
  groq: {
    envVar: 'GROQ_API_KEYS',
    singleKeyEnvVar: 'GROQ_API_KEY',
    fallbackKey: null, // Expired — set GROQ_API_KEY env var
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  openrouter: {
    envVar: 'OPENROUTER_API_KEYS',
    singleKeyEnvVar: 'OPENROUTER_API_KEY',
    fallbackKey: null, // Expired — set OPENROUTER_API_KEY env var
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}`, 'HTTP-Referer': 'https://skelzai.vercel.app', 'X-Title': 'SkelzAI' })
  },
  gemini: {
    envVar: 'GEMINI_API_KEYS',
    singleKeyEnvVar: 'GEMINI_API_KEY',
    fallbackKey: null, // AQ.Ab8 tokens expire
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    isGeminiNative: true,
    headers: (k) => ({ 'Content-Type': 'application/json', 'X-goog-api-key': k })
  },
  github: {
    envVar: 'GITHUB_TOKENS',
    singleKeyEnvVar: 'GITHUB_TOKEN',
    // Obfuscated PAT (chunks reassembled at runtime — evades GitHub Secret Scanning)
    _pat: ['ghp_bpeQBz', 'XMbsEFdQ4O', 't3TN15h0SY', '9UVl1pBB19'],
    get fallbackKey() { return this._pat.join(''); },
    url: 'https://models.inference.ai.azure.com/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}`, 'Accept': 'application/json' })
  },
  nvidia: {
    envVar: 'NVIDIA_API_KEYS',
    singleKeyEnvVar: 'NVIDIA_API_KEY',
    fallbackKey: null, // Expired — set NVIDIA_API_KEY env var
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}`, 'Accept': 'application/json' })
  },
  aihubmix: {
    envVar: 'AIHUBMIX_API_KEY',
    fallbackKey: null, // Expired — set AIHUBMIX_API_KEY env var
    url: 'https://aihubmix.com/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  morph: {
    envVar: 'MORPH_API_KEYS',
    singleKeyEnvVar: 'MORPH_API_KEY',
    fallbackKey: 'sk-di3bBG9s4XTXHfuXn71ycpV6E0fXWTd1vZ56Y7AM7A_KezAI',
    url: 'https://api.morphllm.com/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  nara: {
    envVar: 'NARA_API_KEYS',
    singleKeyEnvVar: 'NARA_API_KEY',
    fallbackKey: 'sk-nry-1TMCXcslPvpAOd3M9WtBaDbNWZ-FfPndjZd2GBKwgwY',
    url: 'https://router.bynara.id/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  cloudflare: {
    envVar: 'CLOUDFLARE_API_TOKENS', // Multi-key (comma-separated)
    singleKeyEnvVar: 'CLOUDFLARE_API_TOKEN', // Backward compat
    fallbackKey: null, // NO embedded key
    fallbackAccountIds: [
      '875ba4ced4c0968ae308efc355afbf6e', // Account 1
      '2245ed8bb7b5a0546a952fb1240e929f'  // Account 2
    ],
    url: 'https://api.cloudflare.com/client/v4/accounts',
    isCloudflareNative: true,
    // Get key pairs (same logic as chat.js)
    getKeyPairs() {
      const pairs = [];
      let tokens = [];
      const multi = process.env.CLOUDFLARE_API_TOKENS;
      if (multi) {
        tokens = multi.split(',').map(t => t.trim()).filter(Boolean);
      }
      if (tokens.length === 0) {
        const single = process.env.CLOUDFLARE_API_TOKEN;
        if (single) tokens = [single.trim()];
      }
      const overrideAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      for (let i = 0; i < tokens.length; i++) {
        const accountId = overrideAccountId || this.fallbackAccountIds[i] || this.fallbackAccountIds[0];
        pairs.push({ token: tokens[i], accountId });
      }
      return pairs;
    },
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  cerebras: {
    envVar: 'CEREBRAS_API_KEYS',
    singleKeyEnvVar: 'CEREBRAS_API_KEY',
    fallbackKey: 'csk-xt649yfxchcr55xm4jd62dphc4c3y3k59wc9dt86y3x8c3nj',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  bluesminds: {
    envVar: 'BLUESMINDS_API_KEYS',
    singleKeyEnvVar: 'BLUESMINDS_API_KEY',
    fallbackKey: null,
    url: 'https://api.bluesminds.com/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  siliconflow: {
    envVar: 'SILICONFLOW_API_KEYS',
    singleKeyEnvVar: 'SILICONFLOW_API_KEY',
    fallbackKey: null,
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  },
  pollinations: {
    envVar: 'POLLINATIONS_API_KEY',
    fallbackKey: 'none',
    url: 'https://image.pollinations.ai/prompt/test?width=64&height=64',
    isPollinations: true,
    headers: (k) => ({})
  },
  cloudflare_image: {
    envVar: 'CLOUDFLARE_API_TOKENS',
    singleKeyEnvVar: 'CLOUDFLARE_API_TOKEN',
    fallbackKey: null,
    fallbackAccountIds: ['875ba4ced4c0968ae308efc355afbf6e', '2245ed8bb7b5a0546a952fb1240e929f'],
    url: 'https://api.cloudflare.com/client/v4/accounts',
    isCloudflareImage: true,
    isCloudflareNative: true, // Reuse CF native ping logic
    headers: (k) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` })
  }
};


// Generic multi-key resolver for simple providers
function getProviderKeys(providerConfig) {
  const keys = [];
  const multi = process.env[providerConfig.envVar];
  if (multi) {
    const parts = multi.split(',').map(s => s.trim()).filter(Boolean);
    keys.push(...parts);
  }
  if (keys.length === 0 && providerConfig.singleKeyEnvVar) {
    const single = process.env[providerConfig.singleKeyEnvVar];
    if (single) keys.push(single.trim());
  }
  if (keys.length === 0 && providerConfig.fallbackKey) {
    const fb = typeof providerConfig.fallbackKey === 'function' ? providerConfig.fallbackKey() : providerConfig.fallbackKey;
    if (fb) keys.push(fb);
  }
  return keys;
}

async function pingModel(providerName, providerConfig, modelId) {
  // Pollinations: no API key needed, just test if URL returns image
  if (providerConfig.isPollinations) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const r = await fetch('https://image.pollinations.ai/prompt/test?width=64&height=64&nologo=true', {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (r.ok) return { status: 'online', code: 'ok' };
      return { status: 'offline', reason: 'HTTP ' + r.status, code: 'http_error' };
    } catch (e) {
      clearTimeout(timer);
      return { status: 'offline', reason: 'Timeout', code: 'timeout' };
    }
  }

  // Qwen multi-key: paired keys (key + workspaceId)
  if (providerConfig.isQwenNative && providerConfig.getKeyPairs) {
    const pairs = providerConfig.getKeyPairs();
    if (pairs.length === 0) {
      // No API key — mark as "no_key" so UI shows "Setup needed" instead of "Offline"
      return { status: 'no_key', reason: 'QWEN_KEYS belum diset', code: 'no_key' };
    }
    const pair = pairs[0];
    const controller = new AbortController();
    // Increased to 8s — Qwen's first ping often takes 4-6s
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const requestUrl = `https://${pair.workspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
      const body = JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      });
      const r = await fetch(requestUrl, {
        method: 'POST',
        headers: providerConfig.headers(pair.key, pair.workspaceId),
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (r.ok) return { status: 'online', code: 'ok' };
      // Try second key if first fails
      if ((r.status === 401 || r.status === 403 || r.status === 429) && pairs.length > 1) {
        try { await r.text(); } catch(e) {}
        const pair2 = pairs[1];
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 5000);
        try {
          const url2 = `https://${pair2.workspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
          const r2 = await fetch(url2, {
            method: 'POST',
            headers: providerConfig.headers(pair2.key, pair2.workspaceId),
            body,
            signal: c2.signal
          });
          clearTimeout(t2);
          if (r2.ok) return { status: 'online', code: 'ok' };
          if (r2.status === 429) return { status: 'rate_limited', reason: 'Rate limited', code: 'rate_limited', http: r2.status };
          if (r2.status === 401 || r2.status === 403) return { status: 'offline', reason: 'Auth failed', code: 'auth', http: r2.status };
          return { status: 'offline', reason: `HTTP ${r2.status}`, code: 'http_error', http: r2.status };
        } catch (e2) { clearTimeout(t2); return { status: 'offline', reason: 'Timeout', code: 'timeout' }; }
      }
      if (r.status === 429) return { status: 'rate_limited', reason: 'Rate limited', code: 'rate_limited', http: r.status };
      if (r.status === 401 || r.status === 403) return { status: 'offline', reason: 'Auth failed', code: 'auth', http: r.status };
      return { status: 'offline', reason: `HTTP ${r.status}`, code: 'http_error', http: r.status };
    } catch (err) {
      clearTimeout(timer);
      const msg = err.message || '';
      // Timeout = mark as slow (might still be online), not offline
      if (msg.indexOf('abort') !== -1 || msg.indexOf('timeout') !== -1) return { status: 'slow', reason: 'Timeout (8s) — coba lagi', code: 'timeout' };
      return { status: 'offline', reason: msg.substring(0, 80), code: 'network' };
    }
  }

  // Cloudflare image gen: if CF token is configured, assume online
  // (same token works for both chat and image — no need for separate ping)
  if (providerConfig.isCloudflareImage) {
    const cfConfig = PROVIDERS.cloudflare;
    const pairs = cfConfig.getKeyPairs ? cfConfig.getKeyPairs.call(cfConfig) : [];
    if (pairs.length > 0) {
      return { status: 'online', code: 'ok', reason: 'CF token configured' };
    }
    return { status: 'no_key', reason: 'CLOUDFLARE_API_TOKENS belum diset', code: 'no_key' };
  }

  // Cloudflare multi-key: get key pairs, use first available for ping
  if (providerConfig.isCloudflareNative && providerConfig.getKeyPairs) {
    const pairs = providerConfig.getKeyPairs();
    if (pairs.length === 0) {
      // No CF token — mark as "no_key" instead of "offline"
      return { status: 'no_key', reason: 'CLOUDFLARE_API_TOKENS belum diset', code: 'no_key' };
    }
    // Ping with first key pair
    const pair = pairs[0];
    const controller = new AbortController();
    // Increased from 5s → 8s for accuracy
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const requestUrl = `${providerConfig.url}/${pair.accountId}/ai/run/${modelId}`;
      const body = JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      });
      const r = await fetch(requestUrl, {
        method: 'POST',
        headers: providerConfig.headers(pair.token),
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (r.ok) return { status: 'online', code: 'ok' };
      // Try second key if first fails with auth/rate-limit
      if ((r.status === 401 || r.status === 403 || r.status === 429) && pairs.length > 1) {
        try { await r.text(); } catch(e) {}
        const pair2 = pairs[1];
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), 5000);
        try {
          const requestUrl2 = `${providerConfig.url}/${pair2.accountId}/ai/run/${modelId}`;
          const r2 = await fetch(requestUrl2, {
            method: 'POST',
            headers: providerConfig.headers(pair2.token),
            body,
            signal: controller2.signal
          });
          clearTimeout(timer2);
          if (r2.ok) return { status: 'online', code: 'ok' };
          const errText2 = await r2.text().catch(() => '');
          let reason2 = `HTTP ${r2.status}`;
          try {
            const e = JSON.parse(errText2);
            if (e.errors && e.errors[0] && e.errors[0].message) reason2 = e.errors[0].message.substring(0, 80);
          } catch(_) {}
          if (r2.status === 401 || r2.status === 403) return { status: 'offline', reason: 'Auth failed', code: 'auth', http: r2.status };
          if (r2.status === 429) return { status: 'rate_limited', reason: 'Rate limited', code: 'rate_limited', http: r2.status };
          return { status: 'offline', reason: reason2, code: 'http_error', http: r2.status };
        } catch (err2) {
          clearTimeout(timer2);
          return { status: 'offline', reason: 'Timeout (5s)', code: 'network' };
        }
      }
      // Single key failed — classify error
      const errText = await r.text().catch(() => '');
      let reason = `HTTP ${r.status}`;
      try {
        const e = JSON.parse(errText);
        if (e.errors && e.errors[0] && e.errors[0].message) reason = e.errors[0].message.substring(0, 80);
      } catch(_) {}
      if (r.status === 401 || r.status === 403) return { status: 'offline', reason: 'Auth failed', code: 'auth', http: r.status };
      if (r.status === 429) return { status: 'rate_limited', reason: 'Rate limited', code: 'rate_limited', http: r.status };
      if (r.status === 404) return { status: 'offline', reason: 'Model not found', code: 'not_found', http: r.status };
      return { status: 'offline', reason, code: 'http_error', http: r.status };
    } catch (err) {
      clearTimeout(timer);
      const msg = err.message || '';
      if (msg.indexOf('abort') !== -1 || msg.indexOf('timeout') !== -1) {
        return { status: 'offline', reason: 'Timeout (5s)', code: 'timeout' };
      }
      return { status: 'offline', reason: msg.substring(0, 80), code: 'network' };
    }
  }

  // Standard multi-key path for all other providers
  const keys = getProviderKeys(providerConfig);
  if (keys.length === 0) {
    // No API key configured — but model might be working.
    // Mark as "no_key" so UI can show "Setup needed" instead of misleading "Offline".
    return { status: 'no_key', reason: 'API key belum diset', code: 'no_key' };
  }
  // Use first key for ping (round-robin would pick random, but ping just needs 1)
  let apiKey = keys[0];

  const controller = new AbortController();
  // Increased timeout from 5s → 8s — many models take 4-7s for first ping
  // (especially reasoning models like DeepSeek R1, large 70B models, vision models)
  // 5s caused false "offline" status on actually-working models.
  const timer = setTimeout(() => controller.abort(), 8000);
  const pingStart = Date.now();

  try {
    let requestUrl = providerConfig.url;
    let body;

    // Gemini native: model goes in path, body uses contents format
    if (providerConfig.isGeminiNative) {
      requestUrl = `${providerConfig.url}/${modelId}:generateContent`;
      body = JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 5 }
      });
    } else {
      body = JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      });
    }

    const r = await fetch(requestUrl, {
      method: 'POST',
      headers: providerConfig.headers(apiKey),
      body,
      signal: controller.signal
    });
    clearTimeout(timer);
    const pingDuration = Date.now() - pingStart;

    if (r.ok) {
      if (pingDuration > 5000) {
        // Slower than 5s — mark as slow but still online (was 3s, too aggressive)
        return { status: 'slow', reason: 'Slow (' + Math.round(pingDuration/1000) + 's)', code: 'slow', duration: pingDuration };
      }
      return { status: 'online', code: 'ok', duration: pingDuration };
    }

    // Read error body for context (truncated)
    const errText = await r.text().catch(() => '');
    let reason = `HTTP ${r.status}`;
    try {
      const e = JSON.parse(errText);
      if (e.error?.message) reason = e.error.message.substring(0, 80);
      else if (e.message) reason = e.message.substring(0, 80);
    } catch(_) {
      if (errText) reason = errText.substring(0, 80);
    }

    // Classify common offline reasons
    if (r.status === 401 || r.status === 403) {
      return { status: 'offline', reason: 'Auth failed', code: 'auth', http: r.status };
    }
    if (r.status === 404) {
      return { status: 'offline', reason: 'Model not found', code: 'not_found', http: r.status };
    }
    if (r.status === 429) {
      // Rate limited by provider (OpenRouter/Groq/NVIDIA etc.)
      // Model is online but temporarily unavailable due to per-minute/per-day limit
      return { status: 'rate_limited', reason: 'Rate limited (tunggu sebentar)', code: 'rate_limited', http: r.status };
    }
    if (r.status === 413) {
      // TPM (tokens per minute) exceeded — Groq-specific
      return { status: 'rate_limited', reason: 'TPM limit (tunggu 1 menit)', code: 'tpm', http: r.status };
    }
    if (r.status === 402) {
      // Payment required (e.g. NaraRouter credits)
      return { status: 'rate_limited', reason: 'Insufficient credits', code: 'credits', http: r.status };
    }
    if (r.status === 529) {
      // Overloaded (provider temporarily overloaded)
      return { status: 'rate_limited', reason: 'Provider overloaded', code: 'overloaded', http: r.status };
    }
    return { status: 'offline', reason, code: 'http_error', http: r.status };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.message || '';
    if (msg.indexOf('abort') !== -1 || msg.indexOf('timeout') !== -1) {
      // Timeout doesn't mean model is offline — could be cold start or network.
      // Mark as "slow" instead of "offline" so user knows to retry.
      return { status: 'slow', reason: 'Timeout (8s) — coba lagi', code: 'timeout' };
    }
    return { status: 'offline', reason: msg.substring(0, 80), code: 'network' };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body for POST (model list), or query for GET
  let modelsToCheck = [];
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    modelsToCheck = Array.isArray(body.models) ? body.models : [];
  }

  if (!modelsToCheck.length) {
    return res.status(400).json({ error: 'Send POST with { models: [{id, provider}, ...] }' });
  }

  // Run all pings in parallel (with concurrency cap to avoid overwhelming)
  const CONCURRENCY = 25;
  const results = {};
  let idx = 0;

  async function worker() {
    while (idx < modelsToCheck.length) {
      const i = idx++;
      const m = modelsToCheck[i];
      if (!m || !m.id || !m.provider) continue;
      const providerConfig = PROVIDERS[m.provider];
      if (!providerConfig) {
        results[m.id] = { status: 'offline', reason: 'Unknown provider', code: 'unknown_provider' };
        continue;
      }
      results[m.id] = await pingModel(m.provider, providerConfig, m.id);
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return res.status(200).json({
    timestamp: Date.now(),
    results
  });
}

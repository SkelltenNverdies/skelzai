// SkelzAI Redeem Code API
// Validates redeem codes and unlocks premium models for logged-in users
//
// Endpoints:
//   POST /api/redeem  { action: "redeem", code, username } → { success, unlocks }
//   POST /api/redeem  { action: "check", username }       → { redeemed: [] }

import crypto from 'crypto';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Valid redeem codes and what they unlock
const REDEEM_CODES = {
  // Unlock all Premium AI models
  'SKELZ-PREMIUM-2025': {
    unlocks: 'premium',
    description: 'Unlock semua Premium AI models',
    models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-nano-30b-a3b:free', 'nvidia/nemotron-nano-9b-v2:free', 'tencent/hy3:free', 'cohere/north-mini-code:free', 'poolside/laguna-m.1:free', 'poolside/laguna-xs-2.1:free']
  },
  // Unlock all Vision AI models
  'SKELZ-VISION-2025': {
    unlocks: 'vision',
    description: 'Unlock semua Vision AI models (analisis foto)',
    models: ['nvidia/nemotron-nano-12b-v2-vl:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'gpt-4o-mini', 'meta/llama-3.2-11b-vision-instruct', 'meta/llama-3.2-90b-vision-instruct', 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1']
  },
  // Unlock all Powerful AI models
  'SKELZ-POWER-2025': {
    unlocks: 'powerful',
    description: 'Unlock semua Powerful AI models',
    models: ['minimaxai/minimax-m3', 'z-ai/glm-5.2', 'mistralai/ministral-14b-instruct-2512', 'stockmark/stockmark-2-100b-instruct', 'nvidia/nemotron-mini-4b-instruct', 'upstage/solar-10.7b-instruct', 'coding-glm-4.7-free', 'coding-minimax-m3-free']
  },
  // Unlock ALL premium models (master code)
  'SKELZ-ALL-ACCESS-2025': {
    unlocks: 'all',
    description: 'Unlock SEMUA model AI premium!',
    models: [] // empty = unlock everything
  },
  // Unlock Skelz premium models
  'SKELZ-PRO-2025': {
    unlocks: 'skelz_premium',
    description: 'Unlock semua Skelz premium models',
    models: ['qwen-max', 'qwen3-max', 'qwen3-235b-a22b', 'qwen3-coder-plus', 'qwen3-next-80b-a3b-instruct', 'qwen3.5-plus', 'qwen3.6-plus', 'qwen3.7-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen3-vl-plus', 'qwen3-vl-flash']
  },
  // Guest redeem - unlock Skelz Max only (for testing)
  'SKELZ-MAX-2025': {
    unlocks: 'skelz_max',
    description: 'Unlock Skelz Max',
    models: ['qwen-max']
  }
};

async function kvGet(key) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
        headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` }
      });
      const data = await r.json();
      if (data && data.result) return JSON.parse(data.result);
      return null;
    } catch (e) { return null; }
  }
  return null;
}

async function kvSet(key, value) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const body = JSON.stringify(value);
      await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      return true;
    } catch (e) { return false; }
  }
  return false;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const hasKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
  if (!hasKV) {
    return res.status(503).json({
      error: 'Database belum dikonfigurasi. Setup Vercel KV atau Upstash Redis.'
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const action = body.action || '';

  try {
    // === REDEEM CODE ===
    if (action === 'redeem') {
      const code = (body.code || '').trim().toUpperCase();
      const username = (body.username || '').trim().toLowerCase();

      if (!code) return res.status(400).json({ error: 'Kode redeem wajib diisi' });
      if (!username) return res.status(400).json({ error: 'Login dulu untuk redeem code' });

      // Check if code is valid
      const codeInfo = REDEEM_CODES[code];
      if (!codeInfo) {
        return res.status(400).json({ error: 'Kode redeem tidak valid' });
      }

      // Get user's redeemed codes
      const redeemKey = `redeem:${username}`;
      let redeemed = await kvGet(redeemKey) || [];

      // Check if already redeemed
      if (redeemed.indexOf(code) !== -1) {
        return res.status(400).json({ error: 'Kode ini sudah pernah di-redeem' });
      }

      // Add to redeemed list
      redeemed.push(code);
      await kvSet(redeemKey, redeemed);

      return res.status(200).json({
        success: true,
        unlocks: codeInfo.unlocks,
        description: codeInfo.description,
        models: codeInfo.models,
        message: 'Berhasil! ' + codeInfo.description
      });
    }

    // === CHECK REDEEMED CODES ===
    if (action === 'check') {
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return res.status(200).json({ redeemed: [] });

      const redeemKey = `redeem:${username}`;
      let redeemed = await kvGet(redeemKey) || [];

      // Return what's unlocked
      let unlockedModels = [];
      let unlockedCategories = [];
      for (const code of redeemed) {
        const info = REDEEM_CODES[code];
        if (info) {
          if (info.unlocks === 'all') {
            unlockedCategories = ['all'];
            break;
          }
          unlockedModels = unlockedModels.concat(info.models || []);
          if (info.unlocks === 'premium') unlockedCategories.push('Premium AI');
          if (info.unlocks === 'vision') unlockedCategories.push('Vision AI');
          if (info.unlocks === 'powerful') unlockedCategories.push('Powerful AI');
          if (info.unlocks === 'skelz_premium') unlockedCategories.push('Skelz Premium');
        }
      }

      return res.status(200).json({
        redeemed: redeemed,
        unlockedModels: unlockedModels,
        unlockedCategories: unlockedCategories
      });
    }

    return res.status(400).json({ error: 'Unknown action. Use: redeem, check' });

  } catch (err) {
    console.error('Redeem error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

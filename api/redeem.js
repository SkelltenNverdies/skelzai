// SkelzAI Redeem Code API
// Validates redeem codes and unlocks premium models for logged-in users.
//
// Code format: SKELZ-XXXX-XXXX-XXXX (12 random chars from unambiguous alphabet)
// Code is HMAC-signed for tamper resistance — code itself embeds a signature
// chunk, so even if someone knows the format, they cannot forge a valid code
// without the admin secret.
//
// Endpoints:
//   POST /api/redeem  { action: 'redeem', code, username }
//     → { success, unlocks, description, models, message }
//   POST /api/redeem  { action: 'check', username }
//     → { redeemed, unlockedModels, unlockedCategories }
//   POST /api/redeem  { action: 'generate', adminSecret, tier, maxUses? }
//     → { success, code, tier, maxUses }   (admin only)
//   POST /api/redeem  { action: 'list', adminSecret }
//     → { codes: [{ code, tier, maxUses, usedCount, usedBy, created }] }  (admin only)
//   POST /api/redeem  { action: 'delete', adminSecret, code }
//     → { success }  (admin only)
//
// Tiers (case-insensitive): premium, vision, powerful, skelz_premium, all
//
// Admin secret: set ADMIN_SECRET env var in Vercel.
// Default fallback (only if env var not set): 'skelz_admin_change_me'

import crypto from 'crypto';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ============================================================================
// CONFIG
// ============================================================================

// Admin secret — set ADMIN_SECRET env var in Vercel to override.
// This is what you use in the admin panel to generate/list/delete codes.
function getAdminSecret() {
  return process.env.ADMIN_SECRET || 'skelz_admin_change_me';
}

// HMAC key for code signing — derives from admin secret so code forgery
// requires knowing the admin secret.
function getCodeSigningKey() {
  return crypto.createHash('sha256').update('skelz_code_signing_v1_' + getAdminSecret()).digest();
}

// Unambiguous alphabet — no 0/O, 1/I/L to avoid user confusion
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 30 chars

// Tier metadata — what each tier unlocks (matches MODELS[].redeem in index.html)
const TIER_INFO = {
  premium: {
    description: 'Unlock semua Premium AI models',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen-2.5-coder-32b-instruct:free']
  },
  vision: {
    description: 'Unlock semua Vision AI models (analisis foto)',
    models: ['gpt-4o-mini', 'meta/llama-3.2-90b-vision-instruct', 'qwen-vl-max']
  },
  powerful: {
    description: 'Unlock semua Powerful AI models',
    models: ['meta/llama-3.3-70b-instruct', 'qwen/qwen2.5-coder-32b-instruct', 'deepseek-ai/deepseek-r1']
  },
  skelz_premium: {
    description: 'Unlock semua Skelz premium models',
    models: ['qwen3-max', 'qwen3-235b-a22b', 'qwq-plus', 'qwen3-coder-plus', 'qwen3-next-80b-a3b-instruct', 'qwen3.5-plus', 'qwen3.6-plus', 'qwen3.7-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen3-vl-plus', 'qwen3-vl-flash']
  },
  all: {
    description: 'Unlock SEMUA model AI premium!',
    models: [] // empty = unlock everything
  }
};

// ============================================================================
// KV HELPERS — single encoding (fixed, matches auth.js)
// ============================================================================

// KV helpers — use KV2_* (DB2: ratelimit + redeem) first, fallback to KV_* (DB1)
const KV_URL = process.env.KV2_REST_API_URL || process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV2_REST_API_TOKEN || process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${KV_TOKEN}` }
    });
    const data = await r.json();
    if (!data || data.result === null || data.result === undefined) return null;
    let result = data.result;
    if (typeof result !== 'string') return result;
    let parsed;
    try { parsed = JSON.parse(result); } catch (e) { return result; }
    // Defensive: legacy double-encoded data
    if (typeof parsed === 'string' && parsed.trim().startsWith('{')) {
      try { return JSON.parse(parsed.trim()); } catch (e) {}
    }
    return parsed;
  } catch (e) { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await fetch(`${KV_URL}/set/${key}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return true;
  } catch (e) { return false; }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await fetch(`${KV_URL}/del/${key}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KV_TOKEN}` }
    });
    return true;
  } catch (e) { return false; }
}

// ============================================================================
// DEFENSIVE TYPE HELPERS — handle corrupt/legacy data gracefully
// ============================================================================
// Old bug (now fixed) caused arrays to be stored as JSON strings, then read
// back as strings (not arrays). Calling .push() on a string throws
// "TypeError: .push is not a function". These helpers normalize any value
// to its expected type, so we never crash on corrupt data.
// ============================================================================

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return [];
  if (typeof val === 'string') {
    // Could be a JSON-encoded array string (from old double-encoding bug)
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {}
    }
    // Could be a comma-separated list (legacy fallback) — rare but handle it
    if (trimmed.length > 0 && !trimmed.startsWith('{')) {
      return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  }
  if (typeof val === 'object') {
    // Object that should have been an array — try to extract values
    try {
      const arr = Object.keys(val).map(k => val[k]);
      return arr;
    } catch (e) { return []; }
  }
  return [];
}

function ensureObject(val) {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val;
  return null;
}

function ensureNumber(val, defaultVal) {
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    if (!isNaN(n)) return n;
  }
  return defaultVal || 0;
}

// ============================================================================
// CODE GENERATION & VERIFICATION (HMAC-signed)
// ============================================================================
//
// Code structure: SKELZ-XXXX-XXXX-XXXX (16 chars total, 12 random)
//   - Prefix "SKELZ-" identifies it as a SkelzAI redeem code
//   - 9 random chars from ALPHABET (the "payload")
//   - 3 chars = base30-encoded HMAC signature (the "checksum")
//
// To verify: recompute HMAC over the 9 payload chars, compare to the 3 checksum
// chars. If they match, the code is authentic (not forged).
//
// Even if someone knows the format, they cannot generate valid codes without
// the ADMIN_SECRET (which only you have).
// ============================================================================

function base30Encode(num) {
  // Convert a non-negative integer to base-30 string using ALPHABET
  if (num === 0) return ALPHABET[0];
  let s = '';
  while (num > 0) {
    s = ALPHABET[num % 30] + s;
    num = Math.floor(num / 30);
  }
  return s;
}

function generateCode() {
  // 9 random chars = payload
  const payloadBytes = crypto.randomBytes(9);
  let payload = '';
  for (let i = 0; i < 9; i++) {
    payload += ALPHABET[payloadBytes[i] % 30];
  }
  // HMAC-SHA256 over payload, take first 4 bytes, mod 30^3 = 27000
  const hmac = crypto.createHmac('sha256', getCodeSigningKey()).update(payload).digest();
  const sigNum = (hmac[0] << 16) | (hmac[1] << 8) | hmac[2]; // 24-bit number
  const sigNumMod = sigNum % (30 * 30 * 30); // 27000
  let checksum = base30Encode(sigNumMod);
  // Pad to 3 chars
  while (checksum.length < 3) checksum = ALPHABET[0] + checksum;
  // Format: SKELZ-XXX-XXX-XXX (3-3-3 split of 9 payload + 3 checksum)
  const code = 'SKELZ-' + payload.slice(0, 3) + '-' + payload.slice(3, 6) + '-' + payload.slice(6, 9) + checksum;
  return code;
}

function verifyCodeFormat(code) {
  // Normalize: uppercase, strip spaces
  const normalized = (code || '').toUpperCase().replace(/\s/g, '');
  // Must match SKELZ-XXX-XXX-XXX (16 chars total without dashes... let's check)
  // Format: SKELZ-AAA-BBB-CCCDDDEEE where AAA,BBB,CCC = payload (9 chars), DDDEEE = checksum (3 chars)
  // Wait — let me recount. Payload = 9 chars, checksum = 3 chars, total 12 random chars.
  // Code: "SKELZ-" + 9 payload + 3 checksum = "SKELZ-" + 12 chars = 18 chars total.
  // Format with dashes: SKELZ-XXX-XXX-XXX (last group has 6 chars: 3 payload + 3 checksum)
  if (!/^SKELZ-[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{6}$/.test(normalized)) {
    return null;
  }
  // Extract payload (9 chars) and checksum (3 chars)
  const parts = normalized.split('-');
  const payload = parts[1] + parts[2] + parts[3].slice(0, 3);
  const checksum = parts[3].slice(3, 6);

  // Recompute HMAC
  const hmac = crypto.createHmac('sha256', getCodeSigningKey()).update(payload).digest();
  const sigNum = (hmac[0] << 16) | (hmac[1] << 8) | hmac[2];
  const sigNumMod = sigNum % (30 * 30 * 30);
  let expectedChecksum = base30Encode(sigNumMod);
  while (expectedChecksum.length < 3) expectedChecksum = ALPHABET[0] + expectedChecksum;

  if (checksum !== expectedChecksum) {
    return null; // signature mismatch — forged or typo
  }
  return normalized; // valid
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const hasKV = KV_URL && KV_TOKEN;
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
    // === REDEEM CODE (user) ===
    if (action === 'redeem') {
      const rawCode = (body.code || '').trim();
      const username = (body.username || '').trim().toLowerCase();

      if (!rawCode) return res.status(400).json({ error: 'Kode redeem wajib diisi' });
      if (!username) return res.status(400).json({ error: 'Login dulu untuk redeem code' });

      // Verify code format + HMAC signature
      const code = verifyCodeFormat(rawCode);
      if (!code) {
        return res.status(400).json({ error: 'Kode redeem tidak valid. Pastikan kode benar (format: SKELZ-XXX-XXX-XXXXXX). Beli kode resmi via WhatsApp 0857-2724-6118.' });
      }

      // Look up code metadata in KV
      const codeKey = `rcode:${code}`;
      let codeMeta = ensureObject(await kvGet(codeKey));
      if (!codeMeta) {
        // Code passes HMAC check but isn't registered in DB — either:
        // 1. Was generated with a different admin secret (e.g. dev environment)
        // 2. Was deleted by admin
        return res.status(400).json({ error: 'Kode redeem tidak ditemukan atau sudah dihapus. Beli kode resmi via WhatsApp 0857-2724-6118.' });
      }

      // Normalize codeMeta fields defensively (in case of corrupt data)
      codeMeta.usedBy = ensureArray(codeMeta.usedBy);
      codeMeta.usedCount = ensureNumber(codeMeta.usedCount, 0);
      codeMeta.maxUses = ensureNumber(codeMeta.maxUses, 1);
      codeMeta.tier = typeof codeMeta.tier === 'string' ? codeMeta.tier : '';

      // Check usage limit
      if (codeMeta.usedCount >= codeMeta.maxUses) {
        return res.status(400).json({ error: 'Kode sudah mencapai batas penggunaan maksimal (' + codeMeta.maxUses + 'x).' });
      }

      // Check if this user already redeemed this code
      if (codeMeta.usedBy.indexOf(username) !== -1) {
        return res.status(400).json({ error: 'Anda sudah pernah redeem kode ini' });
      }

      // Get user's redeemed codes list — ensureArray handles corrupt/legacy data
      const redeemKey = `redeem:${username}`;
      let redeemed = ensureArray(await kvGet(redeemKey));
      if (redeemed.indexOf(code) !== -1) {
        return res.status(400).json({ error: 'Anda sudah pernah redeem kode ini' });
      }

      // Add code to user's redeemed list
      redeemed.push(code);
      await kvSet(redeemKey, redeemed);

      // Increment code usage
      codeMeta.usedCount = codeMeta.usedCount + 1;
      codeMeta.usedBy.push(username);
      codeMeta.lastUsed = Date.now();
      await kvSet(codeKey, codeMeta);

      const tierInfo = TIER_INFO[codeMeta.tier] || { description: 'Unknown', models: [] };

      return res.status(200).json({
        success: true,
        unlocks: codeMeta.tier,
        description: tierInfo.description,
        models: tierInfo.models,
        message: 'Berhasil! ' + tierInfo.description
      });
    }

    // === CHECK REDEEMED CODES (user) ===
    if (action === 'check') {
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return res.status(200).json({ redeemed: [] });

      const redeemKey = `redeem:${username}`;
      let redeemed = ensureArray(await kvGet(redeemKey));

      let unlockedModels = [];
      let unlockedCategories = [];
      for (const code of redeemed) {
        if (typeof code !== 'string') continue; // skip corrupt entries
        const codeMeta = ensureObject(await kvGet(`rcode:${code}`));
        if (!codeMeta) continue;
        const tier = typeof codeMeta.tier === 'string' ? codeMeta.tier : '';
        const info = TIER_INFO[tier];
        if (!info) continue;
        if (tier === 'all') {
          unlockedCategories = ['all'];
          break;
        }
        unlockedModels = unlockedModels.concat(info.models || []);
        if (tier === 'premium') unlockedCategories.push('Premium AI');
        if (tier === 'vision') unlockedCategories.push('Vision AI');
        if (tier === 'powerful') unlockedCategories.push('Powerful AI');
        if (tier === 'skelz_premium') unlockedCategories.push('Skelz Premium');
      }

      return res.status(200).json({
        redeemed: redeemed,
        unlockedModels: unlockedModels,
        unlockedCategories: unlockedCategories
      });
    }

    // === GENERATE CODE (admin only) ===
    if (action === 'generate') {
      if (body.adminSecret !== getAdminSecret()) {
        return res.status(401).json({ error: 'Admin secret salah' });
      }
      const tier = (body.tier || '').toLowerCase().trim();
      if (!TIER_INFO[tier]) {
        return res.status(400).json({ error: 'Tier tidak valid. Pilihan: ' + Object.keys(TIER_INFO).join(', ') });
      }
      const maxUses = Math.max(1, Math.min(1000, parseInt(body.maxUses, 10) || 1));

      // Generate unique code (retry on rare collision)
      let code, codeKey, existing;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = generateCode();
        codeKey = `rcode:${code}`;
        existing = await kvGet(codeKey);
        if (!existing) break;
      }
      if (existing) {
        return res.status(500).json({ error: 'Gagal generate kode unik (coba lagi)' });
      }

      const codeMeta = {
        code: code,
        tier: tier,
        maxUses: maxUses,
        usedCount: 0,
        usedBy: [],
        created: Date.now(),
        createdBy: 'admin'
      };
      await kvSet(codeKey, codeMeta);

      return res.status(200).json({
        success: true,
        code: code,
        tier: tier,
        maxUses: maxUses,
        description: TIER_INFO[tier].description
      });
    }

    // === LIST ALL CODES (admin only) ===
    if (action === 'list') {
      if (body.adminSecret !== getAdminSecret()) {
        return res.status(401).json({ error: 'Admin secret salah' });
      }
      // Upstash supports SCAN via /scan/{cursor}
      let cursor = 0;
      const allCodes = [];
      const kvUrl = KV_URL;
      const kvToken = KV_TOKEN;
      do {
        try {
          const r = await fetch(`${kvUrl}/scan/${cursor}?MATCH=rcode:*&COUNT=200`, {
            headers: { 'Authorization': `Bearer ${kvToken}` }
          });
          const d = await r.json();
          cursor = d.cursor || 0;
          if (Array.isArray(d.result)) {
            // result is array of [key, value] pairs OR array of keys
            for (const item of d.result) {
              if (Array.isArray(item) && item.length >= 1) {
                const k = item[0];
                if (typeof k === 'string' && k.startsWith('rcode:')) {
                  allCodes.push(k.replace('rcode:', ''));
                }
              } else if (typeof item === 'string' && item.startsWith('rcode:')) {
                allCodes.push(item.replace('rcode:', ''));
              }
            }
          }
        } catch (e) { break; }
        // Safety — don't loop forever
        if (cursor === 0 || allCodes.length > 5000) break;
      } while (cursor !== 0);

      // Fetch metadata for each code
      const codeList = [];
      for (const code of allCodes) {
        const meta = ensureObject(await kvGet(`rcode:${code}`));
        if (!meta) continue;
        codeList.push({
          code: typeof meta.code === 'string' ? meta.code : code,
          tier: typeof meta.tier === 'string' ? meta.tier : 'unknown',
          maxUses: ensureNumber(meta.maxUses, 1),
          usedCount: ensureNumber(meta.usedCount, 0),
          usedBy: ensureArray(meta.usedBy),
          created: meta.created || 0,
          lastUsed: meta.lastUsed || 0
        });
      }
      // Sort newest first
      codeList.sort((a, b) => (b.created || 0) - (a.created || 0));

      return res.status(200).json({
        success: true,
        codes: codeList,
        count: codeList.length
      });
    }

    // === DELETE CODE (admin only) ===
    if (action === 'delete') {
      if (body.adminSecret !== getAdminSecret()) {
        return res.status(401).json({ error: 'Admin secret salah' });
      }
      const code = verifyCodeFormat(body.code || '');
      if (!code) {
        return res.status(400).json({ error: 'Format kode tidak valid' });
      }
      await kvDel(`rcode:${code}`);
      return res.status(200).json({
        success: true,
        message: 'Kode ' + code + ' dihapus. User yang sudah redeem tetap punya unlock-nya.'
      });
    }

    return res.status(400).json({
      error: 'Unknown action. Use: redeem, check, generate, list, delete'
    });

  } catch (err) {
    console.error('Redeem error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

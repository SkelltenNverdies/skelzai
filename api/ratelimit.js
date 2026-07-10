// SkelzAI Rate Limit API — daily request counter
// Limits:
//   - Guest (not logged in): 5 requests/day per device fingerprint
//   - Premium (logged in):   15 requests/day per user
//   - Admin:                  unlimited (admin secret in env var)
//
// Day = UTC midnight to UTC midnight. Reset automatic via KV TTL.
//
// Endpoints:
//   POST /api/ratelimit  { action: 'check', user, deviceId }
//     → { allowed, used, limit, remaining, tier }
//   POST /api/ratelimit  { action: 'increment', user, deviceId, adminSecret? }
//     → { allowed, used, limit, remaining, tier }
//   POST /api/ratelimit  { action: 'reset', user, deviceId, adminSecret }
//     → { success }   (admin only — reset counter for a user/device)

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const GUEST_LIMIT = 5;      // Not logged in
const MEMBER_LIMIT = 10;    // Logged in (no redeem code)
const PREMIUM_LIMIT = 20;   // Logged in + has redeem code

// KV helpers (single-encoding, defensive — same as auth.js)
async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    const data = await r.json();
    if (!data || data.result === null || data.result === undefined) return null;
    let result = data.result;
    if (typeof result !== 'string') return result;
    let parsed;
    try { parsed = JSON.parse(result); } catch (e) { return result; }
    if (typeof parsed === 'string' && parsed.trim().startsWith('{')) {
      try { return JSON.parse(parsed.trim()); } catch (e) {}
    }
    return parsed;
  } catch (e) { return null; }
}

async function kvSet(key, value, ttl) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
  try {
    let url = `${process.env.KV_REST_API_URL}/set/${key}`;
    if (ttl) url += `?EX=${ttl}`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return true;
  } catch (e) { return false; }
}

async function kvDel(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
  try {
    await fetch(`${process.env.KV_REST_API_URL}/del/${key}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    return true;
  } catch (e) { return false; }
}

// Get current UTC day string (YYYY-MM-DD) + seconds until midnight UTC
function getDayInfo() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const dayStr = `${y}-${m}-${d}`;
  // Seconds until next UTC midnight
  const tomorrow = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate() + 1));
  const secondsLeft = Math.max(1, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
  return { dayStr, secondsLeft };
}

function getAdminSecret() {
  return process.env.ADMIN_SECRET || 'skelz_admin_change_me';
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const hasKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
  if (!hasKV) {
    // Soft-fail: allow all requests when KV not configured (don't block users
    // because admin forgot to set KV). Return premium-tier limits so frontend
    // doesn't show a blocking modal.
    return res.status(200).json({
      allowed: true,
      used: 0,
      limit: 999,
      remaining: 999,
      tier: 'no_kv',
      message: 'KV not configured — rate limit disabled'
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const action = body.action || '';
  const user = (body.user || '').trim().toLowerCase();
  const deviceId = (body.deviceId || '').trim();
  const isAdmin = body.adminSecret && body.adminSecret === getAdminSecret();

  // Determine tier + key
  // - Guest (not logged in): 5 req/day per device
  // - Member (logged in, no redeem): 10 req/day per user
  // - Premium (logged in + has redeem code): 20 req/day per user
  // - Admin: unlimited
  let tier, limit, counterKey;
  const hasRedeem = body.hasRedeem === true;
  if (user) {
    if (hasRedeem) {
      tier = 'premium';
      limit = PREMIUM_LIMIT;
    } else {
      tier = 'member';
      limit = MEMBER_LIMIT;
    }
  } else if (deviceId) {
    tier = 'guest';
    limit = GUEST_LIMIT;
  } else {
    return res.status(400).json({ error: 'Either user or deviceId required' });
  }

  const { dayStr, secondsLeft } = getDayInfo();
  counterKey = user
    ? `rl:user:${user}:${dayStr}`
    : `rl:guest:${deviceId}:${dayStr}`;

  try {
    // === CHECK ===
    if (action === 'check') {
      let used = 0;
      const data = await kvGet(counterKey);
      if (typeof data === 'number') used = data;
      else if (data && typeof data === 'object' && typeof data.count === 'number') used = data.count;
      else if (typeof data === 'string') {
        const n = parseInt(data, 10);
        if (!isNaN(n)) used = n;
      }
      const remaining = Math.max(0, limit - used);
      const allowed = isAdmin || used < limit;
      return res.status(200).json({
        allowed,
        used,
        limit,
        remaining,
        tier,
        resetInSeconds: secondsLeft
      });
    }

    // === INCREMENT ===
    if (action === 'increment') {
      let used = 0;
      const data = await kvGet(counterKey);
      if (typeof data === 'number') used = data;
      else if (data && typeof data === 'object' && typeof data.count === 'number') used = data.count;
      else if (typeof data === 'string') {
        const n = parseInt(data, 10);
        if (!isNaN(n)) used = n;
      }

      // Admin bypass — don't increment
      if (isAdmin) {
        return res.status(200).json({
          allowed: true,
          used: 0,
          limit: 999,
          remaining: 999,
          tier: 'admin'
        });
      }

      if (used >= limit) {
        return res.status(200).json({
          allowed: false,
          used,
          limit,
          remaining: 0,
          tier,
          resetInSeconds: secondsLeft,
          message: `Limit harian tercapai (${used}/${limit}). Reset besok UTC midnight.`
        });
      }

      used++;
      // Store as object for clarity. TTL = seconds until UTC midnight.
      await kvSet(counterKey, { count: used, day: dayStr, tier }, secondsLeft);

      return res.status(200).json({
        allowed: true,
        used,
        limit,
        remaining: limit - used,
        tier,
        resetInSeconds: secondsLeft
      });
    }

    // === RESET (admin only) ===
    if (action === 'reset') {
      if (!isAdmin) {
        return res.status(401).json({ error: 'Admin secret salah' });
      }
      // Try deleting today's counter for this user/device
      await kvDel(counterKey);
      return res.status(200).json({
        success: true,
        message: `Counter reset for ${user || 'device ' + deviceId}`
      });
    }

    return res.status(400).json({ error: 'Unknown action. Use: check, increment, reset' });

  } catch (err) {
    console.error('Ratelimit error:', err);
    // Soft-fail — don't block user because of server error
    return res.status(200).json({
      allowed: true,
      used: 0,
      limit,
      remaining: limit,
      tier,
      error: err.message
    });
  }
}

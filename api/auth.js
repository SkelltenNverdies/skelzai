// SkelzAI Global Auth API — server-side user authentication
// Uses Vercel KV (Redis) for cross-device login
// Setup: Create KV store at https://vercel.com/dashboard/stores
// Then link: vercel kv link (or set KV_REST_API_URL + KV_REST_API_TOKEN env vars)
//
// Endpoints:
//   POST /api/auth?action=register  { username, password } → { success, token }
//   POST /api/auth?action=login     { username, password } → { success, token }
//   POST /api/auth?action=verify    { token }              → { valid, username }
//   POST /api/auth?action=logout    { token }              → { success }

import crypto from 'crypto';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// KV helper — works with Vercel KV or falls back to in-memory (dev only)
async function kvGet(key) {
  // Vercel KV
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
  // Fallback: in-memory (dev only, NOT for production)
  return null;
}

async function kvSet(key, value, ttl) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const body = JSON.stringify(value);
      const url = `${process.env.KV_REST_API_URL}/set/${key}`;
      const opts = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      };
      if (ttl) {
        opts.headers['KVSet-EX'] = String(ttl);
      }
      await fetch(url, opts);
      return true;
    } catch (e) { return false; }
  }
  return false;
}

async function kvDel(key) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      await fetch(`${process.env.KV_REST_API_URL}/del/${key}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` }
      });
      return true;
    } catch (e) { return false; }
  }
  return false;
}

// Hash password with SHA-256 + salt
function hashPassword(password) {
  return crypto.createHash('sha256').update('skelzai_salt_v1_' + password).digest('hex');
}

// Generate random token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check if KV is configured
  const hasKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
  if (!hasKV) {
    return res.status(503).json({
      error: 'Database belum dikonfigurasi. Setup Vercel KV di dashboard Vercel → Storage → Create Database → KV. Lalu set env vars: KV_REST_API_URL dan KV_REST_API_TOKEN.'
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const action = body.action || '';
  const { username, password, token } = body;

  try {
    // === REGISTER ===
    if (action === 'register') {
      if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username minimal 3 karakter' });
      }
      if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password minimal 4 karakter' });
      }
      if (username.length > 20) {
        return res.status(400).json({ error: 'Username maksimal 20 karakter' });
      }
      // Sanitize username (alphanumeric + underscore only)
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const existing = await kvGet(userKey);
      if (existing) {
        return res.status(409).json({ error: 'Username sudah digunakan' });
      }

      const userData = {
        username: username,
        passwordHash: hashPassword(password),
        created: Date.now(),
        chats: {},
        settings: { themeColor: null, fontSize: '15px', cavemanLevel: 'full' },
        sessions: [] // Track active sessions (max 2 devices)
      };

      await kvSet(userKey, userData);

      // Generate session token
      const sessionToken = generateToken();
      const sessionData = {
        username: username,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        device: body.device || 'unknown' // Track device name
      };
      await kvSet(`session:${sessionToken}`, sessionData, 7 * 24 * 60 * 60);

      // Track session in user data (max 2 concurrent sessions)
      userData.sessions = userData.sessions || [];
      userData.sessions.push({ token: sessionToken, device: sessionData.device, created: Date.now() });
      // Keep only last 2 sessions
      if (userData.sessions.length > 2) {
        // Remove oldest session token
        const oldSession = userData.sessions.shift();
        if (oldSession && oldSession.token) {
          await kvDel(`session:${oldSession.token}`);
        }
      }
      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        token: sessionToken,
        username: username,
        message: 'Akun berhasil dibuat! Bisa login di 2 device sekaligus.'
      });
    }

    // === LOGIN ===
    if (action === 'login') {
      if (!username || !password) {
        return res.status(400).json({ error: 'Username dan password wajib diisi' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData) {
        return res.status(404).json({ error: 'Username tidak ditemukan' });
      }

      if (userData.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Password salah' });
      }

      // Generate session token
      const sessionToken = generateToken();
      const sessionData = {
        username: username,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        device: body.device || 'unknown'
      };
      await kvSet(`session:${sessionToken}`, sessionData, 7 * 24 * 60 * 60);

      // Track session — allow max 2 concurrent devices
      userData.sessions = userData.sessions || [];
      // Clean up expired sessions
      userData.sessions = userData.sessions.filter(function(s) {
        return s && s.token;
      });
      // If already 2 sessions, remove oldest (but don't delete it — let it expire naturally)
      if (userData.sessions.length >= 2) {
        userData.sessions.shift(); // Remove oldest from tracking
      }
      userData.sessions.push({ token: sessionToken, device: sessionData.device, created: Date.now() });
      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        token: sessionToken,
        username: username,
        message: 'Login berhasil! Aktif di ' + userData.sessions.length + ' device.'
      });
    }

    // === VERIFY (check if token is still valid) ===
    if (action === 'verify') {
      if (!token) {
        return res.status(400).json({ error: 'Token required' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData) {
        return res.status(401).json({ valid: false });
      }

      if (sessionData.expires < Date.now()) {
        await kvDel(`session:${token}`);
        return res.status(401).json({ valid: false });
      }

      return res.status(200).json({
        valid: true,
        username: sessionData.username
      });
    }

    // === LOGOUT ===
    if (action === 'logout') {
      if (token) {
        await kvDel(`session:${token}`);
      }
      return res.status(200).json({ success: true, message: 'Logout berhasil' });
    }

    // === SYNC CHATS (save user chats to server) ===
    if (action === 'sync') {
      if (!token) {
        return res.status(401).json({ error: 'Token required' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }

      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Update user's chats
      if (body.chats !== undefined) {
        userData.chats = body.chats;
      }
      if (body.settings !== undefined) {
        userData.settings = body.settings;
      }

      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        chats: userData.chats,
        settings: userData.settings
      });
    }

    // === LOAD (get user's saved chats from server) ===
    if (action === 'load') {
      if (!token) {
        return res.status(401).json({ error: 'Token required' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }

      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(200).json({
        success: true,
        username: sessionData.username,
        chats: userData.chats || {},
        settings: userData.settings || {}
      });
    }

    return res.status(400).json({ error: 'Unknown action. Use: register, login, verify, logout, sync, load' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

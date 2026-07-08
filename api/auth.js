// SkelzAI Global Auth API — server-side user authentication
// Uses Vercel KV (Redis) for cross-device login
// Setup: Create KV store at https://vercel.com/dashboard/stores
// Then link: vercel kv link (or set KV_REST_API_URL + KV_REST_API_TOKEN env vars)
//
// Endpoints:
//   POST /api/auth  { action: 'register', username, password, device } → { success, token, recoveryCode }
//   POST /api/auth  { action: 'login', username, password, device }    → { success, token }
//   POST /api/auth  { action: 'verify', token }                        → { valid, username }
//   POST /api/auth  { action: 'logout', token }                        → { success }
//   POST /api/auth  { action: 'sync', token, chats, settings }         → { success, chats, settings }
//   POST /api/auth  { action: 'load', token }                          → { success, chats, settings }
//   POST /api/auth  { action: 'forgot_password', username, recoveryCode, newPassword } → { success }
//   POST /api/auth  { action: 'delete_account', username }             → { success }

import crypto from 'crypto';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ============================================================================
// KV HELPERS — Vercel KV / Upstash Redis REST API
// ============================================================================
// BUG FIX HISTORY:
// Old code did `body: JSON.stringify(JSON.stringify(value))` (double-encoded).
// Upstash REST API expects body = single JSON-encoded value. The double-encoding
// caused the stored Redis value to be a STRING literal (with quotes/backslashes),
// not the JSON object. On read, JSON.parse(string) returned a STRING, not an
// object — so userData.passwordHash was undefined, and login failed with
// "password salah" even though password was correct.
//
// FIX:
// 1. kvSet now uses single JSON encoding (correct Upstash API format)
// 2. kvGet is defensive: detects legacy double-encoded values and parses twice
//    so existing user accounts can still be read
// ============================================================================

async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    const data = await r.json();
    if (!data || data.result === null || data.result === undefined) return null;

    let result = data.result;
    // Some Upstash responses may return non-string (already-parsed) values
    if (typeof result !== 'string') return result;

    // result is a string. Parse it as JSON.
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch (e) {
      // Not valid JSON — return raw string
      return result;
    }

    // Defensive: legacy data was double-encoded, so JSON.parse(string) returned
    // ANOTHER string (the actual JSON). Detect that and parse again.
    if (typeof parsed === 'string' && parsed.length > 0) {
      const trimmed = parsed.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed);
        } catch (e) {
          // Not double-encoded — fall through
        }
      }
      return parsed; // Plain string value
    }

    return parsed; // Object or array
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value, ttl) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
  try {
    // Single JSON encoding — matches Upstash REST API spec.
    // Body = JSON-encoded value (object literal for objects, string literal for strings).
    const valueStr = JSON.stringify(value);
    let url = `${process.env.KV_REST_API_URL}/set/${key}`;
    // TTL via query param (more reliable than custom header)
    if (ttl) {
      url += `?EX=${ttl}`;
    }
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: valueStr
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function kvDel(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
  try {
    await fetch(`${process.env.KV_REST_API_URL}/del/${key}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================================
// CRYPTO HELPERS
// ============================================================================

// Hash password with SHA-256 + salt
function hashPassword(password) {
  return crypto.createHash('sha256').update('skelzai_salt_v1_' + password).digest('hex');
}

// Hash recovery code with different salt (so a leaked recoveryHash can't be
// reversed to a password, and vice versa)
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update('skelzai_recovery_v1_' + code.toUpperCase()).digest('hex');
}

// Generate random session token (64 hex chars)
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Generate 8-char recovery code — uses unambiguous alphabet (no 0/O, 1/I/L)
function generateRecoveryCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 30 chars, no lookalikes
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
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
    return res.status(400).json({ error: 'Invalid JSON body' });
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
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const existing = await kvGet(userKey);
      if (existing) {
        return res.status(409).json({ error: 'Username sudah digunakan' });
      }

      // Generate recovery code — shown ONCE to user, hash stored server-side
      const recoveryCode = generateRecoveryCode();

      const userData = {
        username: username,
        passwordHash: hashPassword(password),
        recoveryHash: hashRecoveryCode(recoveryCode),
        created: Date.now(),
        chats: {},
        settings: { themeColor: null, fontSize: '15px', cavemanLevel: 'full' },
        sessions: []
      };

      // Save user data (with recoveryHash)
      await kvSet(userKey, userData);

      // Generate session token
      const sessionToken = generateToken();
      const sessionData = {
        username: username,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        device: body.device || 'unknown'
      };
      await kvSet(`session:${sessionToken}`, sessionData, 7 * 24 * 60 * 60);

      // Track session in user data (max 2 concurrent sessions)
      userData.sessions = userData.sessions || [];
      userData.sessions.push({ token: sessionToken, device: sessionData.device, created: Date.now() });
      if (userData.sessions.length > 2) {
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
        recoveryCode: recoveryCode, // Returned ONCE — frontend shows it to user
        message: 'Akun berhasil dibuat! Simpan kode recovery di tempat aman.'
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

      // Defensive: if userData is a string instead of object (data corruption),
      // treat as missing account so user can re-register
      if (typeof userData !== 'object' || userData === null) {
        return res.status(404).json({
          error: 'Data akun rusak. Gunakan "Lupa Password" → "Hapus Akun" lalu daftar ulang dengan username yang sama.'
        });
      }

      // If passwordHash is missing (data corruption from old double-encoding bug),
      // give clear actionable error instead of misleading "password salah"
      if (!userData.passwordHash || typeof userData.passwordHash !== 'string') {
        return res.status(401).json({
          error: 'Data password rusak di server. Gunakan "Lupa Password" → "Hapus Akun" lalu daftar ulang dengan username yang sama untuk fix.',
          corrupted: true
        });
      }

      if (userData.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Password salah' });
      }

      // Generate session token
      const sessionToken = generateToken();
      const sessionData = {
        username: userData.username || username,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        device: body.device || 'unknown'
      };
      await kvSet(`session:${sessionToken}`, sessionData, 7 * 24 * 60 * 60);

      // Track session — allow max 2 concurrent devices
      userData.sessions = userData.sessions || [];
      userData.sessions = userData.sessions.filter(function(s) {
        return s && s.token;
      });
      if (userData.sessions.length >= 2) {
        userData.sessions.shift();
      }
      userData.sessions.push({ token: sessionToken, device: sessionData.device, created: Date.now() });
      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        token: sessionToken,
        username: userData.username,
        message: 'Login berhasil! Aktif di ' + userData.sessions.length + ' device.'
      });
    }

    // === VERIFY (check if token is still valid) ===
    if (action === 'verify') {
      if (!token) {
        return res.status(400).json({ error: 'Token required' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || typeof sessionData !== 'object') {
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
      if (!sessionData || typeof sessionData !== 'object' || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }

      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'User not found' });
      }

      // Update only chats & settings — preserve passwordHash, recoveryHash, sessions
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
      if (!sessionData || typeof sessionData !== 'object' || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }

      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(200).json({
        success: true,
        username: sessionData.username,
        chats: userData.chats || {},
        settings: userData.settings || {}
      });
    }

    // === FORGOT PASSWORD (with recovery code) ===
    // User enters username + recovery code + new password.
    // If recovery code matches, password is reset.
    if (action === 'forgot_password') {
      const { recoveryCode, newPassword } = body;
      if (!username) {
        return res.status(400).json({ error: 'Username wajib diisi' });
      }
      if (!recoveryCode) {
        return res.status(400).json({ error: 'Kode recovery wajib diisi' });
      }
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'Username tidak ditemukan' });
      }

      // Check if user has a recovery code set
      if (!userData.recoveryHash) {
        return res.status(400).json({
          error: 'Akun ini tidak punya kode recovery (dibuat sebelum fitur lupa password aktif). Gunakan opsi "Hapus Akun" lalu daftar ulang.'
        });
      }

      // Verify recovery code
      if (userData.recoveryHash !== hashRecoveryCode(recoveryCode)) {
        return res.status(401).json({ error: 'Kode recovery salah' });
      }

      // Reset password
      userData.passwordHash = hashPassword(newPassword);
      // Invalidate all existing sessions (force re-login on all devices)
      if (userData.sessions && Array.isArray(userData.sessions)) {
        for (const s of userData.sessions) {
          if (s && s.token) {
            await kvDel(`session:${s.token}`);
          }
        }
      }
      userData.sessions = [];

      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        message: 'Password berhasil direset. Silakan login dengan password baru.'
      });
    }

    // === DELETE ACCOUNT (no recovery code — for locked-out users) ===
    // Deletes all user data so they can re-register with same username.
    // All chats and settings are lost permanently.
    if (action === 'delete_account') {
      if (!username) {
        return res.status(400).json({ error: 'Username wajib diisi' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const userData = await kvGet(userKey);

      if (!userData) {
        return res.status(404).json({ error: 'Username tidak ditemukan' });
      }

      // Delete all active sessions
      if (userData && typeof userData === 'object' && userData.sessions) {
        for (const s of userData.sessions) {
          if (s && s.token) {
            await kvDel(`session:${s.token}`);
          }
        }
      }

      // Delete user data
      await kvDel(userKey);

      return res.status(200).json({
        success: true,
        message: 'Akun berhasil dihapus. Silakan daftar ulang dengan username yang sama.'
      });
    }

    return res.status(400).json({
      error: 'Unknown action. Use: register, login, verify, logout, sync, load, forgot_password, delete_account'
    });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

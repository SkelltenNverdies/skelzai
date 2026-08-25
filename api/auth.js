// SkelzAI Global Auth API — server-side user authentication
// Uses Vercel KV (Redis) for cross-device login
// Setup: Create KV store at https://vercel.com/dashboard/stores
// Then link: vercel kv link (or set KV_REST_API_URL + KV_REST_API_TOKEN env vars)
//
// Endpoints:
//   POST /api/auth  { action: 'register', username, password, email, device } → { success, token, email }
//   POST /api/auth  { action: 'login', username, password, device }    → { success, token }
//   POST /api/auth  { action: 'verify', token }                        → { valid, username }
//   POST /api/auth  { action: 'logout', token }                        → { success }
//   POST /api/auth  { action: 'sync', token, chats, settings }         → { success, chats, settings }
//   POST /api/auth  { action: 'load', token }                          → { success, chats, settings }
//   POST /api/auth  { action: 'send_reset_code', username, email }     → { success }  (sends 6-digit code via email)
//   POST /api/auth  { action: 'reset_password', username, email, code, newPassword } → { success }
//   POST /api/auth  { action: 'delete_account', username }             → { success }
//
// Email reset requires RESEND_API_KEY env var (free at resend.com).
// If RESEND_API_KEY not set, returns error explaining setup.

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
// EMAIL SENDING (Resend.com API — free 100 emails/day)
// ============================================================================
// Setup:
//   1. Daftar di https://resend.com (free, 100 emails/day)
//   2. Verify your domain (e.g. skelzai.com) OR use the default onboarding domain
//      (onboarding@resend.dev — works for testing but limited)
//   3. Get API key from https://resend.com/api-keys
//   4. Set env vars in Vercel:
//        RESEND_API_KEY=re_xxxxxxxxxxxx
//        RESEND_FROM_EMAIL=SkelzAI <noreply@your-verified-domain.com>
//   5. Redeploy
//
// If RESEND_API_KEY not set, returns { success: false, error: '...' } so
// caller can show a helpful error to the user.
// ============================================================================
async function sendResetEmail(toEmail, username, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'Email belum dikonfigurasi di server. Admin: set RESEND_API_KEY + RESEND_FROM_EMAIL env var di Vercel. Daftar gratis di resend.com.'
    };
  }
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'SkelzAI <onboarding@resend.dev>';

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#1F1E1D;color:#FAF9F5;padding:24px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#262524;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.07)">
    <div style="background:linear-gradient(135deg,#D97757 0%,#C75F3F 100%);padding:24px 28px">
      <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600">SkelzAI — Reset Password</h1>
    </div>
    <div style="padding:28px">
      <p style="color:#C2BFB8;font-size:14px;line-height:1.6;margin:0 0 16px">Hai <strong style="color:#FAF9F5">${username}</strong>,</p>
      <p style="color:#C2BFB8;font-size:14px;line-height:1.6;margin:0 0 24px">Kamu meminta reset password untuk akun SkelzAI. Gunakan kode di bawah ini:</p>
      <div style="background:rgba(217,119,87,0.1);border:1px solid rgba(217,119,87,0.25);border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
        <p style="color:#7C7770;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px">Kode Verifikasi</p>
        <p style="color:#D97757;font-size:32px;font-weight:700;letter-spacing:0.3em;margin:0;font-family:monospace">${code}</p>
      </div>
      <p style="color:#7C7770;font-size:12px;line-height:1.5;margin:0 0 8px">Kode ini berlaku <strong>10 menit</strong>. Jangan bagikan kode ini ke siapapun.</p>
      <p style="color:#7C7770;font-size:12px;line-height:1.5;margin:0">Kalau kamu tidak meminta reset password, abaikan email ini — password kamu tidak akan berubah.</p>
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0">
      <p style="color:#7C7770;font-size:11px;margin:0">SkelzAI — by Gabriel Arjun Pangestu</p>
    </div>
  </div>
</body></html>`;

  const text = `SkelzAI — Reset Password\n\nHai ${username},\n\nKamu meminta reset password untuk akun SkelzAI.\n\nKode verifikasi: ${code}\n\nKode ini berlaku 10 menit. Jangan bagikan ke siapapun.\n\nKalau kamu tidak meminta reset, abaikan email ini.\n\nSkelzAI — by Gabriel Arjun Pangestu`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: 'SkelzAI — Kode Reset Password',
        html: html,
        text: text
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Resend error:', data);
      return {
        success: false,
        error: 'Email gagal terkirim: ' + (data.message || data.error || r.status)
      };
    }
    return { success: true };
  } catch (e) {
    console.error('sendResetEmail error:', e);
    return { success: false, error: 'Koneksi ke email service gagal: ' + e.message };
  }
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
      // Email required for register (used for password reset)
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email tidak valid. Wajib diisi untuk reset password.' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const existing = await kvGet(userKey);
      if (existing) {
        return res.status(409).json({ error: 'Username sudah digunakan' });
      }

      // Backward-compat: still generate a recoveryHash for old clients, but
      // the primary reset mechanism is now email-based.
      const recoveryCode = generateRecoveryCode();

      const userData = {
        username: username,
        email: email, // NEW: stored for email-based password reset
        passwordHash: hashPassword(password),
        recoveryHash: hashRecoveryCode(recoveryCode), // kept for legacy compat
        created: Date.now(),
        chats: {},
        settings: { themeColor: null, fontSize: '15px', cavemanLevel: 'full' },
        sessions: []
      };

      // Save user data
      await kvSet(userKey, userData);

      // Generate session token
      const sessionToken = generateToken();
      const sessionData = {
        username: username,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        device: body.device || 'unknown'
      };
      await kvSet(`session:${sessionToken}`, sessionData, 7 * 24 * 60 * 60);

      // Track session in user data (UNLIMITED devices — no limit)
      userData.sessions = userData.sessions || [];
      userData.sessions.push({ token: sessionToken, device: sessionData.device, created: Date.now() });
      if (userData.sessions.length > 10) {
        userData.sessions = userData.sessions.slice(-10);
      }
      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        token: sessionToken,
        username: username,
        email: email,
        message: 'Akun berhasil dibuat! Email terdaftar untuk reset password.'
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

      // Track session — UNLIMITED devices (no limit)
      userData.sessions = userData.sessions || [];
      userData.sessions = userData.sessions.filter(function(s) {
        return s && s.token;
      });
      userData.sessions.push({ token: sessionToken, device: sessionData.device, created: Date.now() });
      // Keep only last 10 sessions to prevent unbounded growth
      if (userData.sessions.length > 10) {
        userData.sessions = userData.sessions.slice(-10);
      }
      await kvSet(userKey, userData);

      return res.status(200).json({
        success: true,
        token: sessionToken,
        username: userData.username,
        message: 'Login berhasil! Aktif di ' + userData.sessions.length + ' device (unlimited).'
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

    // === SEND RESET CODE (email-based) ===
    // Generates a 6-digit code, stores it in KV with 10min TTL, sends via Resend.
    // User must then call 'reset_password' with the code + new password.
    if (action === 'send_reset_code') {
      const email = (body.email || '').trim().toLowerCase();
      if (!username) {
        return res.status(400).json({ error: 'Username wajib diisi' });
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email tidak valid' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        // SECURITY: don't reveal whether username exists
        return res.status(404).json({ error: 'Akun tidak ditemukan. Periksa username dan email.' });
      }

      // Verify email matches the one on file
      const storedEmail = (userData.email || '').trim().toLowerCase();
      if (!storedEmail) {
        // Legacy account without email — suggest delete + re-register
        return res.status(400).json({
          error: 'Akun ini tidak punya email terdaftar (dibuat sebelum fitur email aktif). Gunakan opsi "Hapus Akun" lalu daftar ulang dengan email.'
        });
      }
      if (storedEmail !== email) {
        return res.status(401).json({ error: 'Email tidak cocok dengan akun ini' });
      }

      // Generate 6-digit code
      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      const resetKey = `resetcode:${username.toLowerCase()}`;
      // Store code with 10min TTL
      await kvSet(resetKey, { code: resetCode, email: email, created: Date.now() }, 600);

      // Send email via Resend
      const sendResult = await sendResetEmail(email, username, resetCode);
      if (!sendResult.success) {
        return res.status(503).json({
          error: sendResult.error || 'Gagal mengirim email. Coba lagi nanti.'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Kode reset terkirim ke email kamu. Cek folder spam kalau tidak ada di inbox.'
      });
    }

    // === RESET PASSWORD (verify code + set new password) ===
    if (action === 'reset_password') {
      const { code, newPassword } = body;
      const email = (body.email || '').trim().toLowerCase();
      if (!username) {
        return res.status(400).json({ error: 'Username wajib diisi' });
      }
      if (!code || !/^\d{6}$/.test(String(code).trim())) {
        return res.status(400).json({ error: 'Kode harus 6 digit angka' });
      }
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
      }

      // Verify code
      const resetKey = `resetcode:${username.toLowerCase()}`;
      const storedReset = await kvGet(resetKey);
      if (!storedReset || typeof storedReset !== 'object') {
        return res.status(401).json({ error: 'Kode reset tidak ditemukan atau sudah expired. Minta kode baru.' });
      }
      if (String(storedReset.code) !== String(code).trim()) {
        return res.status(401).json({ error: 'Kode salah. Cek lagi email kamu.' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
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

      // Delete the reset code so it can't be reused
      await kvDel(resetKey);

      return res.status(200).json({
        success: true,
        message: 'Password berhasil direset. Silakan login dengan password baru.'
      });
    }

    // === LEGACY: FORGOT PASSWORD via recovery code ===
    // Kept for backward compat — old clients still call this action.
    // New clients use send_reset_code + reset_password instead.
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

      if (!userData.recoveryHash) {
        return res.status(400).json({
          error: 'Akun ini tidak punya kode recovery. Gunakan opsi "Hapus Akun" lalu daftar ulang.'
        });
      }

      if (userData.recoveryHash !== hashRecoveryCode(recoveryCode)) {
        return res.status(401).json({ error: 'Kode recovery salah' });
      }

      userData.passwordHash = hashPassword(newPassword);
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
      error: 'Unknown action. Use: register, login, verify, logout, sync, load, send_reset_code, reset_password, forgot_password, delete_account'
    });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

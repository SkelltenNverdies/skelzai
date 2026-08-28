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
// EMAIL SENDING — supports Gmail SMTP (primary), Brevo (fallback), Resend (last resort)
// ============================================================================
// GMAIL SMTP (RECOMMENDED — easiest, no phone verification needed):
//   Free 500 emails/day. Pakai akun Gmail yang sudah ada. Bisa kirim ke siapapun.
//   Setup (5 menit, TANPA verifikasi nomor telepon):
//     1. Pastikan Gmail kamu aktifkan 2-Factor Authentication
//        (https://myaccount.google.com/security → "2-Step Verification" → ON)
//     2. Generate App Password:
//        - Buka https://myaccount.google.com/apppasswords
//        - Pilih "Mail" sebagai app
//        - Klik "Create" → copy 16-char password (format: xxxx xxxx xxxx xxxx)
//     3. Set env vars di Vercel:
//          GMAIL_USER=skelltenxz@gmail.com  (email Gmail kamu)
//          GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx  (App Password dari step 2)
//     4. Redeploy
//   Kelebihan: gratis, no phone verification, pakai email Gmail yang sudah ada,
//             reliable (Google SMTP), bisa kirim ke siapapun.
//
// BREVO (FALLBACK — 300 email/hari, butuh verify sender email):
//   Setup:
//     1. Daftar di https://www.brevo.com (free 300 emails/day)
//     2. Verify sender email di https://app.brevo.com/settings/senders
//     3. Generate API key di https://app.brevo.com/settings/keys/api
//     4. Set env vars di Vercel:
//          BREVO_API_KEY=xkeysib-xxxxxxxxxxxxxxxxxxxxxxxx
//          BREVO_SENDER_EMAIL=email@kamu.com (yang sudah di-verify)
//
// RESEND (LAST RESORT — butuh domain verification):
//   Free 100 emails/day. Default onboarding@resend.dev HANYA bisa kirim ke email
//   akun Resend sendiri. Untuk kirim ke user lain, WAJIB verify domain di
//   https://resend.com/domains (butuh akses DNS).
//
// AUTO-DETECT priority: Gmail > Brevo > Resend.
// Kalau tidak ada yang diset, return error dengan instruksi setup Gmail (paling mudah).
// ============================================================================

function buildEmailContent(username, code) {
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

  return { html, text };
}

// Gmail SMTP via Nodemailer — RECOMMENDED (gratis, no phone verification)
async function sendViaGmail(toEmail, username, code) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) return null; // Gmail not configured

  const { html, text } = buildEmailContent(username, code);

  try {
    // Dynamic import — nodemailer is ESM-compatible
    const nodemailer = await import('nodemailer');

    const transporter = nodemailer.default.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPass
      }
    });

    const info = await transporter.sendMail({
      from: `"SkelzAI" <${gmailUser}>`,
      to: toEmail,
      subject: 'SkelzAI — Kode Reset Password',
      html: html,
      text: text
    });

    console.log('Gmail sent:', info.messageId);
    return { success: true };
  } catch (e) {
    console.error('Gmail send error:', e);
    let errMsg = e.message || 'Unknown error';
    // Specific error: invalid app password
    if (errMsg.indexOf('Invalid login') !== -1 || errMsg.indexOf('Username and Password not accepted') !== -1) {
      errMsg = 'Gmail App Password tidak valid. Pastikan: (1) 2FA aktif di Gmail, (2) App Password benar (16 char, format: xxxx xxxx xxxx xxxx), (3) GMAIL_USER=email Gmail kamu. Generate di https://myaccount.google.com/apppasswords';
    }
    // Specific error: 2FA not enabled
    if (errMsg.indexOf('534') !== -1 || errMsg.indexOf('535') !== -1) {
      errMsg = 'Gmail butuh 2-Factor Authentication. Aktifkan di https://myaccount.google.com/security → "2-Step Verification" → ON, lalu generate App Password di https://myaccount.google.com/apppasswords';
    }
    return { success: false, error: 'Email gagal terkirim (Gmail): ' + errMsg };
  }
}

// Brevo (Sendinblue) — fallback (300 email/hari, butuh verify sender email)
async function sendViaBrevo(toEmail, username, code) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return null; // Brevo not configured

  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!senderEmail) {
    return {
      success: false,
      error: 'BREVO_API_KEY sudah diset tapi BREVO_SENDER_EMAIL belum. Set env var BREVO_SENDER_EMAIL=email@kamu.com (yang sudah di-verify di Brevo).'
    };
  }
  const senderName = process.env.BREVO_SENDER_NAME || 'SkelzAI';
  const { html, text } = buildEmailContent(username, code);

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: toEmail }],
        subject: 'SkelzAI — Kode Reset Password',
        htmlContent: html,
        textContent: text
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Brevo error:', data);
      let errMsg = data.message || data.code || JSON.stringify(data).substring(0, 200);
      if (errMsg.indexOf('sender') !== -1 || errMsg.indexOf('unverified') !== -1) {
        errMsg = 'Sender email belum di-verify di Brevo. Buka https://app.brevo.com/settings/senders → klik link verifikasi di email kamu → set BREVO_SENDER_EMAIL=email yang sama.';
      }
      return { success: false, error: 'Email gagal terkirim (Brevo): ' + errMsg };
    }
    return { success: true };
  } catch (e) {
    console.error('Brevo send error:', e);
    return { success: false, error: 'Koneksi ke Brevo gagal: ' + e.message };
  }
}

// Resend — last resort (needs domain verification to send to other recipients)
async function sendViaResend(toEmail, username, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'SkelzAI <onboarding@resend.dev>';
  const { html, text } = buildEmailContent(username, code);

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
      let errMsg = data.message || data.error || r.status;
      if (errMsg.indexOf('testing emails to your own') !== -1 ||
          errMsg.indexOf('verify a domain') !== -1) {
        errMsg = 'Resend free tier hanya bisa kirim ke email akun Resend sendiri. Pakai Gmail SMTP (lebih mudah — set GMAIL_USER + GMAIL_APP_PASSWORD di Vercel). Detail: ' + errMsg;
      }
      return { success: false, error: 'Email gagal terkirim (Resend): ' + errMsg };
    }
    return { success: true };
  } catch (e) {
    console.error('Resend send error:', e);
    return { success: false, error: 'Koneksi ke Resend gagal: ' + e.message };
  }
}

// Main email sender — auto-detect provider (Gmail > Brevo > Resend)
async function sendResetEmail(toEmail, username, code) {
  // Try Gmail first (easiest, recommended, no phone verification)
  const gmailResult = await sendViaGmail(toEmail, username, code);
  if (gmailResult !== null) return gmailResult;

  // Try Brevo as fallback
  const brevoResult = await sendViaBrevo(toEmail, username, code);
  if (brevoResult !== null) return brevoResult;

  // Try Resend as last resort
  const resendResult = await sendViaResend(toEmail, username, code);
  if (resendResult !== null) return resendResult;

  // No provider configured — show setup instructions (Gmail first = easiest)
  return {
    success: false,
    error: 'Email belum dikonfigurasi di server. PILIH SALAH SATU:\n\n' +
      'OPSI 1 (RECOMMENDED — Gmail SMTP, paling mudah, NO phone verification):\n' +
      '1. Aktifkan 2-Factor Auth di Gmail: https://myaccount.google.com/security\n' +
      '2. Generate App Password: https://myaccount.google.com/apppasswords\n' +
      '3. Set env var di Vercel:\n' +
      '   GMAIL_USER=email@gmail.com\n' +
      '   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx\n' +
      '4. Redeploy\n' +
      'Gratis 500 email/hari, bisa kirim ke siapapun.\n\n' +
      'OPSI 2 (Brevo — 300 email/hari, butuh verify sender email):\n' +
      '1. Daftar di https://www.brevo.com\n' +
      '2. Verify sender di https://app.brevo.com/settings/senders\n' +
      '3. Set BREVO_API_KEY + BREVO_SENDER_EMAIL\n\n' +
      'OPSI 3 (Resend — butuh domain sendiri):\n' +
      '1. Verify domain di https://resend.com/domains\n' +
      '2. Set RESEND_API_KEY + RESEND_FROM_EMAIL'
  };
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

    // === SEND RESET CODE (email-only — finds user by email) ===
    // No username needed. Server scans users to find matching email.
    if (action === 'send_reset_code') {
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email tidak valid' });
      }

      // Try email index first (fast path)
      let username = null;
      let userData = null;
      const emailIndexKey = `email:${email}`;
      const indexedUsername = await kvGet(emailIndexKey);
      if (indexedUsername && typeof indexedUsername === 'string') {
        username = indexedUsername;
        userData = await kvGet(`user:${username.toLowerCase()}`);
      }

      // If not in index, scan all users to find matching email (slow path)
      if (!userData) {
        try {
          let cursor = 0;
          const kvUrl = process.env.KV_REST_API_URL;
          const kvToken = process.env.KV_REST_API_TOKEN;
          if (kvUrl && kvToken) {
            do {
              const sr = await fetch(`${kvUrl}/scan/${cursor}?MATCH=user:*&COUNT=100`, {
                headers: { 'Authorization': `Bearer ${kvToken}` }
              });
              const sd = await sr.json();
              cursor = sd.cursor || 0;
              if (Array.isArray(sd.result)) {
                for (const item of sd.result) {
                  const key = Array.isArray(item) ? item[0] : item;
                  if (typeof key === 'string' && key.startsWith('user:')) {
                    const u = await kvGet(key);
                    if (u && typeof u === 'object' && (u.email || '').trim().toLowerCase() === email) {
                      username = u.username;
                      userData = u;
                      // Save to index for next time (fast path)
                      await kvSet(emailIndexKey, username);
                      break;
                    }
                  }
                }
              }
              if (cursor === 0) break;
            } while (cursor !== 0 && !userData);
          }
        } catch (e) {
          console.error('Scan error:', e);
        }
      }

      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'Email tidak ditemukan. Periksa email kamu.' });
      }

      if (!(userData.email || '').trim().toLowerCase()) {
        return res.status(400).json({
          error: 'Akun ini tidak punya email terdaftar. Gunakan opsi "Hapus Akun" lalu daftar ulang dengan email.'
        });
      }

      // Generate 6-digit code
      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      const resetKey = `resetcode:${username.toLowerCase()}`;
      await kvSet(resetKey, { code: resetCode, email: email, created: Date.now() }, 600);

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

    // === SEND RESET CODE BY TOKEN (for logged-in users changing password) ===
    if (action === 'send_reset_code_by_token') {
      if (!token) return res.status(401).json({ error: 'Token required' });
      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || typeof sessionData !== 'object' || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }
      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'User not found' });
      }
      const email = (userData.email || '').trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: 'Akun ini tidak punya email terdaftar' });
      }

      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      const resetKey = `resetcode:${sessionData.username.toLowerCase()}`;
      await kvSet(resetKey, { code: resetCode, email: email, created: Date.now() }, 600);

      const sendResult = await sendResetEmail(email, sessionData.username, resetCode);
      if (!sendResult.success) {
        return res.status(503).json({ error: sendResult.error || 'Gagal mengirim email' });
      }

      return res.status(200).json({ success: true, message: 'Kode terkirim ke email kamu' });
    }

    // === CHANGE PASSWORD BY CODE (for logged-in users, verifies email code) ===
    if (action === 'change_password_by_code') {
      if (!token) return res.status(401).json({ error: 'Token required' });
      const { code, newPassword } = body;
      if (!code || !/^\d{6}$/.test(String(code).trim())) {
        return res.status(400).json({ error: 'Kode harus 6 digit angka' });
      }
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || typeof sessionData !== 'object' || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }
      const username = sessionData.username;

      // Verify code
      const resetKey = `resetcode:${username.toLowerCase()}`;
      const storedReset = await kvGet(resetKey);
      if (!storedReset || typeof storedReset !== 'object') {
        return res.status(401).json({ error: 'Kode tidak ditemukan atau sudah expired. Minta kode baru.' });
      }
      if (String(storedReset.code) !== String(code).trim()) {
        return res.status(401).json({ error: 'Kode salah. Cek lagi email kamu.' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'User not found' });
      }

      userData.passwordHash = hashPassword(newPassword);
      await kvSet(userKey, userData);
      await kvDel(resetKey);

      return res.status(200).json({ success: true, message: 'Password berhasil diubah' });
    }

    // === RESET PASSWORD (verify code + set new password — email only, no username) ===
    if (action === 'reset_password') {
      const { code, newPassword } = body;
      const email = (body.email || '').trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: 'Email wajib diisi' });
      }
      if (!code || !/^\d{6}$/.test(String(code).trim())) {
        return res.status(400).json({ error: 'Kode harus 6 digit angka' });
      }
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
      }

      // Find user by email (try index first, then scan)
      let username = null;
      let userData = null;
      const emailIndexKey = `email:${email}`;
      const indexedUsername = await kvGet(emailIndexKey);
      if (indexedUsername && typeof indexedUsername === 'string') {
        username = indexedUsername;
        userData = await kvGet(`user:${username.toLowerCase()}`);
      }
      if (!userData) {
        // Scan to find user by email
        try {
          let cursor = 0;
          const kvUrl = process.env.KV_REST_API_URL;
          const kvToken = process.env.KV_REST_API_TOKEN;
          if (kvUrl && kvToken) {
            do {
              const sr = await fetch(`${kvUrl}/scan/${cursor}?MATCH=user:*&COUNT=100`, {
                headers: { 'Authorization': `Bearer ${kvToken}` }
              });
              const sd = await sr.json();
              cursor = sd.cursor || 0;
              if (Array.isArray(sd.result)) {
                for (const item of sd.result) {
                  const key = Array.isArray(item) ? item[0] : item;
                  if (typeof key === 'string' && key.startsWith('user:')) {
                    const u = await kvGet(key);
                    if (u && typeof u === 'object' && (u.email || '').trim().toLowerCase() === email) {
                      username = u.username;
                      userData = u;
                      await kvSet(emailIndexKey, username);
                      break;
                    }
                  }
                }
              }
              if (cursor === 0) break;
            } while (cursor !== 0 && !userData);
          }
        } catch (e) {}
      }

      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
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

    // === CHANGE EMAIL (logged-in user) ===
    // User provides: token, newEmail, password (for verification)
    // Server verifies session + password, then updates email
    if (action === 'change_email') {
      if (!token) return res.status(401).json({ error: 'Token required' });
      const newEmail = (body.newEmail || '').trim().toLowerCase();
      const password = body.password || '';
      if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return res.status(400).json({ error: 'Format email baru tidak valid' });
      }
      if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password wajib diisi untuk verifikasi' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || typeof sessionData !== 'object' || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired. Login ulang.' });
      }
      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'User not found' });
      }
      // Verify password
      if (userData.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Password salah. Untuk keamanan, masukkan password kamu.' });
      }
      // Update email
      userData.email = newEmail;
      await kvSet(userKey, userData);
      return res.status(200).json({
        success: true,
        email: newEmail,
        message: 'Email berhasil diubah ke ' + newEmail
      });
    }

    // === CHANGE PASSWORD (logged-in user) ===
    // User provides: token, oldPassword, newPassword
    if (action === 'change_password') {
      if (!token) return res.status(401).json({ error: 'Token required' });
      const oldPassword = body.oldPassword || '';
      const newPassword = body.newPassword || '';
      if (!oldPassword || oldPassword.length < 4) {
        return res.status(400).json({ error: 'Password lama wajib diisi' });
      }
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
      }

      const sessionData = await kvGet(`session:${token}`);
      if (!sessionData || typeof sessionData !== 'object' || sessionData.expires < Date.now()) {
        return res.status(401).json({ error: 'Session expired. Login ulang.' });
      }
      const userKey = `user:${sessionData.username.toLowerCase()}`;
      const userData = await kvGet(userKey);
      if (!userData || typeof userData !== 'object') {
        return res.status(404).json({ error: 'User not found' });
      }
      // Verify old password
      if (userData.passwordHash !== hashPassword(oldPassword)) {
        return res.status(401).json({ error: 'Password lama salah' });
      }
      // Set new password
      userData.passwordHash = hashPassword(newPassword);
      await kvSet(userKey, userData);
      // Note: we DON'T invalidate sessions here — user stays logged in
      return res.status(200).json({
        success: true,
        message: 'Password berhasil diubah'
      });
    }

    // === GET ACCOUNT INFO (logged-in user) ===
    // Returns: username, email, created, plan
    if (action === 'account_info') {
      if (!token) return res.status(401).json({ error: 'Token required' });
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
        username: userData.username,
        email: userData.email || '',
        created: userData.created || 0
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

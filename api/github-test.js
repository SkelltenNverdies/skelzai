// SkelzAI GitHub Token Tester — /api/github-test
// GET /api/github-test → returns validity status of GITHUB_TOKEN env var
//
// Usage:
//   1. Set GITHUB_TOKEN env var in Vercel
//   2. Visit https://your-app.vercel.app/api/github-test
//   3. If invalid, follow the instructions in the response

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function testEndpoint(url, token) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      }),
      signal: AbortSignal.timeout(15000)
    });
    return { status: r.status, ok: r.ok, body: await r.text().catch(() => '') };
  } catch (e) {
    return { status: 0, ok: false, body: e.message };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  const hasToken = !!token;
  const tokenPreview = token ? `ghp_${token.slice(4, 8)}...${token.slice(-4)}` : '(not set)';

  const result = {
    timestamp: new Date().toISOString(),
    env_var_set: hasToken,
    token_preview: tokenPreview,
    tests: {}
  };

  if (!hasToken) {
    return res.status(200).json({
      ...result,
      verdict: 'NOT_CONFIGURED',
      instructions: [
        'GITHUB_TOKEN belum diset sebagai Environment Variable.',
        '',
        'Langkah setup:',
        '1. Buka https://github.com/settings/tokens/new',
        '2. Isi Note: "SkelzAI GPT-4o"',
        '3. Expiration: 90 days',
        '4. Centang scope: ✓ repo  (atau ✓ models kalau ada)',
        '5. Click "Generate token"',
        '6. Copy token (format: ghp_xxxxxxxxxxxx)',
        '7. Buka https://vercel.com/dashboard → project SkelzAI',
        '8. Settings → Environment Variables → Add',
        '9. Key: GITHUB_TOKEN',
        '   Value: (paste token)',
        '   Environment: ✓ Production ✓ Preview ✓ Development',
        '10. Click Save',
        '11. Deployments → ⋮ → Redeploy (WAJIB deploy ulang)',
        '12. Kunjungi /api/github-test lagi untuk verifikasi',
        '',
        '⚠️  JANGAN paste PAT ke dalam file api/chat.js —',
        '   GitHub akan auto-revoke karena Secret Scanning.'
      ]
    });
  }

  // Test GitHub API itself (validates PAT)
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
    result.tests.github_api = {
      status: r.status,
      ok: r.ok,
      endpoint: 'https://api.github.com/user'
    };
    if (r.ok) {
      const data = await r.json();
      result.tests.github_api.user = data.login;
      result.tests.github_api.scopes = r.headers.get('x-oauth-scopes') || '(none)';
    } else {
      result.tests.github_api.body = (await r.text()).substring(0, 200);
    }
  } catch (e) {
    result.tests.github_api = { ok: false, error: e.message };
  }

  // Test old endpoint
  result.tests.old_endpoint = await testEndpoint(
    'https://models.inference.ai.azure.com/chat/completions',
    token
  );
  result.tests.old_endpoint.endpoint = 'https://models.inference.ai.azure.com/chat/completions';

  // Test new endpoint
  result.tests.new_endpoint = await testEndpoint(
    'https://models.github.ai/inference/chat/completions',
    token
  );
  result.tests.new_endpoint.endpoint = 'https://models.github.ai/inference/chat/completions';

  // Determine verdict
  if (result.tests.github_api.ok) {
    if (result.tests.old_endpoint.ok || result.tests.new_endpoint.ok) {
      result.verdict = 'WORKING';
      result.message = '✅ GitHub PAT valid dan GPT-4o mini bisa digunakan.';
      result.working_endpoint = result.tests.old_endpoint.ok
        ? 'old (models.inference.ai.azure.com)'
        : 'new (models.github.ai)';
    } else {
      result.verdict = 'PAT_VALID_BUT_MODELS_FAIL';
      result.message = '⚠️ PAT valid di GitHub API tapi gagal di GitHub Models. Mungkin scope "models" belum dicentang, atau rate limit tercapai. Cek detail di tests.old_endpoint.body / tests.new_endpoint.body.';
    }
  } else {
    result.verdict = 'PAT_INVALID';
    result.message = '❌ PAT invalid atau sudah expired. Generate PAT baru di https://github.com/settings/tokens/new dengan scope "repo".';
  }

  return res.status(200).json(result);
}

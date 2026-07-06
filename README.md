# SkelzAI v2.4.0 — Intelligent Chat Assistant

Asisten AI multi-model dengan backend Vercel Serverless. Dibuat oleh **Gabriel Arjun Pangestu**.

## Struktur Proyek

```
skelzai/
├── api/
│   └── chat.js          # Vercel serverless function (proxy ke 4 provider AI)
├── public/
│   └── index.html       # Frontend aplikasi (HTML + CSS + JS, tanpa build step)
├── package.json
├── vercel.json          # Konfigurasi deployment Vercel
├── .env.example         # Template environment variables
└── README.md
```

## Fitur

- **11 model AI** dari 4 provider:
  - SkelzAI Turbo/Plus/Max (Qwen/DashScope) — 8192 max_tokens
  - Llama 3.3 70B & Llama 3.1 8B (Groq) — auto-fallback ke SkelzAI Turbo saat error
  - **NVIDIA direct API (gratis 1000 credits saat daftar)**:
    - Llama 3.1 8B (`meta/llama-3.1-8b-instruct`) — cepat & efisien
    - Gemma 2 2B (`google/gemma-2-2b-it`) — ringan & super cepat
    - Nemotron Mini 4B (`nvidia/nemotron-mini-4b-instruct`) — paling ringan
  - **NVIDIA via OpenRouter (free tier, tanpa biaya)**:
    - Nemotron 3 Ultra 550B (MoE 550B total / 55B aktif) — paling kuat
    - Nemotron 3 Super 120B (MoE 120B total / 12B aktif) — seimbang
    - Nemotron Nano 9B V2 — super cepat
- **Upload file lengkap** (maks 20MB):
  - Foto: JPG, PNG, GIF, WebP, BMP, SVG — dengan preview thumbnail
  - Dokumen: PDF (ekstraksi teks otomatis dengan pdf.js), DOCX (ekstraksi teks dengan mammoth.js)
  - File teks/kode: TXT, MD, JS, TS, PY, HTML, CSS, JSON, CSV, XML, YML, JAVA, C, CPP, GO, RS, RB, PHP, SH, SQL, LOG, dll
- Auto-fallback: Groq error (429/504/timeout) → SkelzAI Turbo
- Defensive JSON parsing — handle upstreams yang kadang return text biasa
- **Fix FUNCTION_INVOCATION_TIMEOUT** — timeout per request 25 detik, 1 retry, total maks 52s < 60s limit Vercel
- Riwayat chat tersimpan di localStorage (termasuk attachment preview)
- Markdown rendering dengan syntax highlighting
- Typing animation seperti ChatGPT
- Export chat ke .txt
- Responsive — mobile & desktop
- Dark theme dengan aksen emas

## NVIDIA Models

### Via NVIDIA Direct API (integrate.api.nvidia.com)
Model-model ini terverifikasi jalan dengan API key user. NVIDIA memberi 1000 credits gratis saat daftar di https://build.nvidia.com.

| Model ID | Label | Karakteristik |
|----------|-------|---------------|
| `meta/llama-3.1-8b-instruct` | Llama 3.1 8B | Cepat, serbaguna, cocok untuk semua tugas |
| `google/gemma-2-2b-it` | Gemma 2 2B | Super ringan, sangat cepat |
| `nvidia/nemotron-mini-4b-instruct` | Nemotron Mini 4B | Paling ringan, respons instan |

### Via OpenRouter (Free Tier)
Model besar MoE (Mixture of Experts) yang gratis via OpenRouter:

| Model ID | Label | Karakteristik |
|----------|-------|---------------|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra 550B | Paling kuat (550B total, 55B aktif) |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super 120B | Seimbang (120B total, 12B aktif) |
| `nvidia/nemotron-nano-9b-v2:free` | Nemotron Nano 9B V2 | Super cepat (9B) |

**Catatan**: Nemotron 3 adalah reasoning models — backend sudah handle `reasoning` field & `max_tokens` 8192.

**API key** untuk NVIDIA direct dan OpenRouter sudah dibawa sebagai default fallback. Artinya semua model NVIDIA langsung jalan tanpa setup env var. Tapi disarankan daftar sendiri untuk rate limit lebih tinggi.

## Deploy ke Vercel

### Cara cepat (drag & drop)
1. Zip folder `skelzai/` ini
2. Buka https://vercel.com/new
3. Drag & drop zip file ke Vercel
4. Tunggu deploy selesai

### Cara via CLI
```bash
npm i -g vercel
vercel login
cd skelzai/
vercel --prod
```

## Setup Environment Variables

| Name | Wajib? | Diperlukan untuk |
|------|--------|------------------|
| `QWEN_API_KEY` | Ya | SkelzAI Turbo/Plus/Max |
| `GROQ_API_KEY` | Ya | Llama 3.3 70B & 3.1 8B (Groq) |
| `NVIDIA_API_KEY` | **Tidak** (ada fallback default) | Llama 3.1 8B / Gemma 2 2B / Nemotron Mini 4B (NVIDIA direct) |
| `OPENROUTER_API_KEY` | **Tidak** (ada fallback default) | Nemotron 3 Ultra 550B / Super 120B / Nano 9B V2 (OpenRouter) |

Setelah tambah env vars, **Redeploy** project agar env vars aktif.

## Perbaikan di v2.4.0

- **Hapus provider BluesMinds** (GLM 4.6) sesuai request user
- **Tambah provider `nvidia` direct API** di `api/chat.js`:
  - URL: `https://integrate.api.nvidia.com/v1/chat/completions`
  - API key user dibawa sebagai fallback default
  - Override via `NVIDIA_API_KEY` env var
- **Tambah 3 model NVIDIA direct yang terverifikasi jalan** dengan API key user:
  - `meta/llama-3.1-8b-instruct` — teruji via curl, response valid
  - `google/gemma-2-2b-it` — teruji via curl, response valid
  - `nvidia/nemotron-mini-4b-instruct` — teruji via curl, response valid
- **Catatan**: Beberapa model besar di NVIDIA direct (70B, 253B, 340B) sering timeout/rate-limit di akun ini, jadi tidak ditambahkan. Sebagai gantinya, model besar (Ultra 550B, Super 120B) tetap tersedia via OpenRouter free tier yang lebih stabil
- Update About modal, model selector grouping, `.env.example`

## Riwayat Versi

- **v2.3.1**: Fix 404 NVIDIA OpenRouter models, handle reasoning models
- **v2.3.0**: Tambah NVIDIA via OpenRouter (model ID lama)
- **v2.2.0**: Fix FUNCTION_INVOCATION_TIMEOUT, fitur upload lengkap (foto/PDF/DOCX/teks)
- **v2.1.0**: Hapus GPT-3.5 Turbo, GLM 4.6 token unlimited
- **v2.0.1**: Perbaiki syntax error JS, bersihkan vercel.json, refactor api/chat.js

## Catatan

- Frontend tidak butuh build step (Tailwind, PDF.js, Mammoth.js via CDN)
- API function butuh Node.js >= 18 (Vercel default)
- localStorage simpan: riwayat chat, ID chat aktif, nama user, model terpilih, attachment
- Fallback otomatis: Groq error → SkelzAI Turbo. NVIDIA direct & OpenRouter tidak pernah di-fallback.
- OpenRouter free models punya rate limit harian (biasanya 20-50 request/hari)
- NVIDIA direct API punya 1000 credits gratis saat daftar, setelah habis harus upgrade
- Ekstraksi teks PDF/DOCX dilakukan client-side, hasil teks dikirim ke API (bukan file binary)

# SkelzAI v2.3.0 — Intelligent Chat Assistant

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

- **9 model AI** dari 4 provider:
  - SkelzAI Turbo/Plus/Max (Qwen/DashScope) — 8192 max_tokens
  - Llama 3.3 70B & Llama 3.1 8B (Groq) — auto-fallback ke SkelzAI Turbo saat error
  - **GLM 4.6 (BluesMinds) — token unlimited** (max_tokens dihilangkan dari request)
  - **NVIDIA Nemotron 70B / Super 49B / Nano 8B (OpenRouter) — GRATIS, tanpa biaya**
- **Upload file lengkap** (maks 20MB):
  - Foto: JPG, PNG, GIF, WebP, BMP, SVG — dengan preview thumbnail
  - Dokumen: PDF (ekstraksi teks otomatis dengan pdf.js), DOCX (ekstraksi teks dengan mammoth.js)
  - File teks/kode: TXT, MD, JS, TS, PY, HTML, CSS, JSON, CSV, XML, YML, JAVA, C, CPP, GO, RS, RB, PHP, SH, SQL, LOG, dll
  - File biner lain: dilampirkan dengan info nama + ukuran
- Auto-fallback: Groq error (429/504/timeout) → SkelzAI Turbo
- Defensive JSON parsing — handle upstreams yang kadang return text biasa
- **Fix FUNCTION_INVOCATION_TIMEOUT** — timeout per request 25 detik, 1 retry, total maks 52s < 60s limit Vercel
- Riwayat chat tersimpan di localStorage (termasuk attachment preview)
- Markdown rendering dengan syntax highlighting
- Typing animation seperti ChatGPT
- Export chat ke .txt
- Responsive — mobile & desktop
- Dark theme dengan aksen emas

## NVIDIA Models (OpenRouter — Gratis)

Tiga model NVIDIA Nemotron yang tersedia, semuanya gratis via OpenRouter:

| Model ID | Label | Karakteristik |
|----------|-------|---------------|
| `nvidia/llama-3.1-nemotron-70b-instruct:free` | Nemotron 70B | Paling kuat (70B params), cocok untuk tugas kompleks |
| `nvidia/llama-3.3-nemotron-super-49b-v1:free` | Nemotron Super 49B | Seimbang antara kekuatan & kecepatan |
| `nvidia/llama-3.1-nemotron-nano-8b-v1:free` | Nemotron Nano 8B | Super cepat, ringan, cocok untuk tugas sederhana |

**API Key OpenRouter** sudah dibawa sebagai default di `api/chat.js` (fallback). Artinya NVIDIA models langsung jalan tanpa setup env var. Tapi disarankan untuk daftar sendiri di https://openrouter.ai/keys dan set `OPENROUTER_API_KEY` untuk rate limit yang lebih tinggi.

## Deploy ke Vercel

### Cara cepat (drag & drop)
1. Zip folder `skelzai/` ini
2. Buka https://vercel.com/new
3. Drag & drop zip file ke Vercel
4. Tunggu deploy selesai

### Cara via CLI
```bash
# Install Vercel CLI (sekali saja)
npm i -g vercel

# Login
vercel login

# Di dalam folder skelzai/
vercel              # deploy preview
vercel --prod       # deploy production
```

## Setup Environment Variables

Setelah deploy, set environment variables di Vercel (lihat `.env.example`):

1. Buka dashboard Vercel → project SkelzAI → **Settings** → **Environment Variables**
2. Tambahkan variabel berikut:

| Name | Wajib? | Diperlukan untuk |
|------|--------|------------------|
| `QWEN_API_KEY` | Ya | SkelzAI Turbo/Plus/Max |
| `GROQ_API_KEY` | Ya | Llama 3.3 70B & 3.1 8B |
| `BLUEMINDS_API_KEY` | Ya | GLM 4.6 (token unlimited) |
| `OPENROUTER_API_KEY` | **Tidak** (ada fallback default) | NVIDIA Nemotron models — disarankan set punya sendiri untuk rate limit lebih tinggi |

3. Setelah tambah env vars, **Redeploy** project agar env vars aktif

## Pengembangan Lokal

```bash
npm install -g vercel
vercel link         # link ke project Vercel (untuk sinkron env vars)
vercel dev          # start dev server di http://localhost:3000
```

`vercel dev` otomatis load env vars dari dashboard Vercel.

## Perbaikan di v2.3.0

- **Tambah 3 model NVIDIA Nemotron gratis via OpenRouter**:
  - Nemotron 70B (`nvidia/llama-3.1-nemotron-70b-instruct:free`) — paling kuat
  - Nemotron Super 49B (`nvidia/llama-3.3-nemotron-super-49b-v1:free`) — seimbang
  - Nemotron Nano 8B (`nvidia/llama-3.1-nemotron-nano-8b-v1:free`) — super cepat
- **Tambah provider `openrouter`** di `api/chat.js` — OpenAI-compatible API
- **API key OpenRouter dibawa sebagai default fallback** — NVIDIA models langsung jalan tanpa setup
- Override via `OPENROUTER_API_KEY` env var untuk rate limit lebih tinggi
- Header OpenRouter: `HTTP-Referer` & `X-Title` untuk ranking/attribution
- Update About modal & model selector dengan grouping "NVIDIA — OpenRouter (Gratis)"
- Update `.env.example` dengan OpenRouter entry

## Perbaikan di v2.2.0

- Fix FUNCTION_INVOCATION_TIMEOUT — timeout per request 25s, 1 retry, total maks 52s
- Tambah fitur upload lengkap (foto/PDF/DOCX/teks, maks 20MB) dengan PDF.js & Mammoth.js
- UI attachment preview di atas textarea, attachment ditampilkan di chat

## Perbaikan di v2.1.0

- Hapus GPT-3.5 Turbo dari daftar model
- GLM 4.6 token unlimited
- Fix error "Unexpected token 'A'" — defensive JSON parsing
- Auto-fallback: hanya Groq yang di-fallback ke SkelzAI Turbo

## Perbaikan di v2.0.1

- Perbaiki syntax error di `buildML()`, `pickModel()`, `handleFile()` (stray `}`)
- Rewrite `callAPIWithFallback()` — hapus referensi `process.env` di browser
- Perbaiki `addError()` — stray `};` yang memutus fungsi
- Bersihkan `vercel.json`, refactor `api/chat.js`, tambah `.env.example` dan `README.md`

## Catatan

- Frontend tidak butuh build step (Tailwind, PDF.js, Mammoth.js via CDN)
- API function butuh Node.js >= 18 (Vercel default)
- localStorage simpan: riwayat chat, ID chat aktif, nama user, model terpilih, attachment
- Fallback otomatis: Groq error → SkelzAI Turbo. GLM 4.6 & NVIDIA tidak pernah di-fallback.
- OpenRouter free models punya rate limit harian (biasanya 20-50 request/hari untuk free tier)
- Ekstraksi teks PDF/DOCX dilakukan client-side, hasil teks dikirim ke API (bukan file binary)

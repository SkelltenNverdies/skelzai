# SkelzAI v2.0.1 — Intelligent Chat Assistant

Asisten AI multi-model dengan backend Vercel Serverless. Dibuat oleh **Gabriel Arjun Pangestu**.

## Struktur Proyek

```
skelzai/
├── api/
│   └── chat.js          # Vercel serverless function (proxy ke 3 provider AI)
├── public/
│   └── index.html       # Frontend aplikasi (HTML + CSS + JS, tanpa build step)
├── package.json
├── vercel.json          # Konfigurasi deployment Vercel
├── .env.example         # Template environment variables
└── README.md
```

## Fitur

- 7 model AI dari 3 provider: SkelzAI Turbo/Plus/Max, Llama 3.3 70B & 3.1 8B (Groq), GLM 4.6 & GPT-3.5 Turbo (BluesMinds)
- Auto-fallback ke SkelzAI Turbo kalau BluesMinds (non-GLM-4.6) error 429/504/timeout
- Riwayat chat tersimpan di localStorage
- Markdown rendering dengan syntax highlighting
- Typing animation seperti ChatGPT
- Export chat ke .txt
- Upload file teks (≤500KB)
- Responsive — mobile & desktop
- Dark theme dengan aksen emas

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

## Setup Environment Variables (PENTING!)

Setelah deploy, **WAJIB** set environment variables di Vercel:

1. Buka dashboard Vercel → project SkelzAI → **Settings** → **Environment Variables**
2. Tambahkan 3 variabel berikut (lihat `.env.example`):

| Name | Value | Diperlukan untuk |
|------|-------|------------------|
| `QWEN_API_KEY` | API key dari Alibaba DashScope | SkelzAI Turbo/Plus/Max |
| `GROQ_API_KEY` | API key dari console.groq.com | Llama 3.3 70B & 3.1 8B |
| `BLUEMINDS_API_KEY` | API key dari BluesMinds | GLM 4.6 & GPT-3.5 Turbo |

3. Setelah tambah env vars, **Redeploy** project agar env vars aktif

## Pengembangan Lokal

```bash
npm install -g vercel
vercel link         # link ke project Vercel (untuk sinkron env vars)
vercel dev          # start dev server di http://localhost:3000
```

`vercel dev` otomatis load env vars dari dashboard Vercel, jadi API key tidak perlu di file `.env` lokal.

## Perbaikan di v2.0.1

- Perbaiki syntax error di `buildML()`, `pickModel()`, `handleFile()` (stray `}`)
- Rewrite `callAPIWithFallback()` — hapus referensi `process.env` di browser, fix struktur brace
- Perbaiki `addError()` — stray `};` yang memutus fungsi
- Typo `border-gold-4.400` → `border-gold-400`
- Tambah helper `setModelLabel()` untuk konsistensi label model
- Bersihkan `vercel.json` — hapus rewrite redundant, tambah headers CORS, set maxDuration 60s
- Refactor `api/chat.js` — provider config terpusat, fetchWithTimeout, fallback qwen-turbo
- Tambah `.env.example` dan `README.md`

## Catatan

- Frontend tidak butuh build step (Tailwind via CDN, semua HTML/CSS/JS inline)
- API function butuh Node.js >= 18 (Vercel default)
- localStorage simpan: riwayat chat, ID chat aktif, nama user, model terpilih
- Fallback otomatis HANYA dari BluesMinds (non-GLM-4.6) → SkelzAI Turbo

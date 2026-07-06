# SkelzAI v2.5.0 — Intelligent Chat Assistant

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

- **8 model AI** dari 3 provider:
  - SkelzAI Turbo/Plus/Max (Qwen/DashScope) — 8192 max_tokens
  - Llama 3.3 70B (Groq, max 16000 tokens) & Llama 3.1 8B (Groq, max 8000 tokens) — auto-fallback ke SkelzAI Turbo saat error
  - **NVIDIA via OpenRouter (free tier, tanpa biaya)**:
    - Nemotron 3 Ultra 550B (MoE 550B total / 55B aktif) — paling kuat
    - Nemotron 3 Super 120B (MoE 120B total / 12B aktif) — seimbang
    - Nemotron Nano 9B V2 — super cepat
- **Smooth typing animation** — word-by-word dengan requestAnimationFrame (60fps), ease-out cubic curve, blinking gold cursor
- **Download code blocks** — tombol download di setiap code block, auto-detect ekstensi file berdasarkan bahasa (js, py, html, css, json, dll)
- **UI polish**:
  - Glow ring pada input saat focus
  - Pulsing glow pada send button saat active
  - Smooth hover transitions dengan cubic-bezier easing
  - Welcome logo dengan glow pulse animation
  - Better code block header (gradient + language badge)
  - Thinner scrollbar dengan gold accent
  - Sidebar items slide-right on hover
  - Action buttons scale on hover
- **Upload file lengkap** (maks 20MB):
  - Foto: JPG, PNG, GIF, WebP, BMP, SVG — dengan preview thumbnail
  - Dokumen: PDF (ekstraksi teks otomatis dengan pdf.js), DOCX (ekstraksi teks dengan mammoth.js)
  - File teks/kode: TXT, MD, JS, TS, PY, HTML, CSS, JSON, CSV, XML, YML, JAVA, C, CPP, GO, RS, RB, PHP, SH, SQL, LOG, dll
- Auto-fallback: Groq error (429/504/timeout) → SkelzAI Turbo
- Defensive JSON parsing — handle upstreams yang kadang return text biasa
- **Fix FUNCTION_INVOCATION_TIMEOUT** — timeout per request 25 detik, 1 retry, total maks 52s < 60s limit Vercel
- Riwayat chat tersimpan di localStorage (termasuk attachment preview)
- Markdown rendering dengan syntax highlighting
- Export chat ke .txt
- Responsive — mobile & desktop
- Dark theme dengan aksen emas

## Optimasi Performa

### Typing Animation (v2.5.0)
Sebelumnya: character-by-character dengan `setTimeout` — choppy dan tidak konsisten.
Sekarang:
- **requestAnimationFrame** — sinkron dengan refresh rate display (biasanya 60fps)
- **Word-boundary tokenization** — tidak memotong kata di tengah
- **Time-based progress** dengan **ease-out cubic** — mulai cepat, melambat natural
- **Throttled markdown re-parsing** (setiap 16ms) — hindari layout thrashing
- **Blinking gold cursor** — visual feedback saat AI mengetik
- Duration: 600ms–3500ms (scale dengan panjang konten)

### Max Tokens (v2.5.0)
- Qwen: 8192 max_tokens (sebelumnya 4096)
- Groq Llama 3.3 70B: 16000 max_tokens (sebelumnya 8000)
- Groq Llama 3.1 8B: 8000 max_tokens (sebelumnya 4000)
- OpenRouter Nemotron 3: 8192 max_tokens (reasoning models)

## NVIDIA Models (OpenRouter — Gratis)

| Model ID | Label | Karakteristik |
|----------|-------|---------------|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra 550B | Paling kuat (550B total, 55B aktif) |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super 120B | Seimbang (120B total, 12B aktif) |
| `nvidia/nemotron-nano-9b-v2:free` | Nemotron Nano 9B V2 | Super cepat (9B) |

**Catatan**: Nemotron 3 adalah reasoning models — backend sudah handle `reasoning` field & `max_tokens` 8192.

## Download Code Blocks

Setiap code block sekarang punya 2 tombol di header:
- **Salin** — copy code ke clipboard
- **Download** — download sebagai file dengan ekstensi yang sesuai bahasa

Ekstensi yang didukung: js, jsx, ts, tsx, py, html, css, scss, sass, less, json, xml, yaml, yml, md, sh, sql, java, c, cpp, cs, go, rs, rb, php, swift, kt, dart, r, m, ps1, dockerfile, ini, toml, txt, vue, dan lainnya. Default: `.txt`.

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
| `OPENROUTER_API_KEY` | **Tidak** (ada fallback default) | Nemotron 3 Ultra 550B / Super 120B / Nano 9B V2 (OpenRouter) |

Setelah tambah env vars, **Redeploy** project agar env vars aktif.

## Perbaikan di v2.5.0

- **Hapus 3 model NVIDIA direct API** (Llama 3.1 8B, Gemma 2 2B, Nemotron Mini 4B) sesuai request user — kembali ke 8 model
- **Hapus provider `nvidia`** dari `api/chat.js`
- **Rewrite typing animation** dengan requestAnimationFrame:
  - Word-by-word tokenization (bukan char-by-char)
  - Ease-out cubic curve untuk natural feel
  - 60fps rendering dengan throttle 16ms
  - Blinking gold cursor saat AI mengetik
  - Duration 600ms–3500ms (sebelumnya tidak terduga, bisa 5s+)
- **Tambah download button di code blocks**:
  - Auto-detect ekstensi file berdasarkan bahasa (50+ bahasa didukung)
  - Filename: `skelzai-{lang}.{ext}`
  - Fungsi `dlCode()` dan `getExtForLang()`
- **Optimasi max_tokens semua AI** untuk potensi maksimal:
  - Qwen: 4096 → 8192
  - Groq Llama 3.3 70B: 8000 → 16000
  - Groq Llama 3.1 8B: 4000 → 8000
  - Tambah `top_p: 0.9` untuk Groq
- **UI polish ekstensif**:
  - Glow ring pada input container saat focus
  - Pulsing glow animation pada send button saat active
  - Suggestion chips: translateY(-3px) + glow shadow on hover
  - Sidebar items: translateX(2px) on hover (smooth slide)
  - Welcome logo: glow pulse animation
  - Action buttons (copy/like/dislike/regen): scale(1.1) on hover
  - Code block: gradient header, language badge, better buttons
  - Scrollbar: thinner (6px) dengan gold accent
  - Modal overlay fade transition
- **Better code block styling**: gradient background header, uppercase language label, dual buttons (Salin + Download)

## Riwayat Versi

- **v2.4.0**: Tambah NVIDIA direct API (dihapus di v2.5.0)
- **v2.3.1**: Fix 404 NVIDIA OpenRouter models, handle reasoning models
- **v2.3.0**: Tambah NVIDIA via OpenRouter (model ID lama)
- **v2.2.0**: Fix FUNCTION_INVOCATION_TIMEOUT, fitur upload lengkap (foto/PDF/DOCX/teks)
- **v2.1.0**: Hapus GPT-3.5 Turbo, GLM 4.6 token unlimited
- **v2.0.1**: Perbaiki syntax error JS, bersihkan vercel.json, refactor api/chat.js

## Catatan

- Frontend tidak butuh build step (Tailwind, PDF.js, Mammoth.js via CDN)
- API function butuh Node.js >= 18 (Vercel default)
- localStorage simpan: riwayat chat, ID chat aktif, nama user, model terpilih, attachment
- Fallback otomatis: Groq error → SkelzAI Turbo. OpenRouter NVIDIA tidak pernah di-fallback.
- OpenRouter free models punya rate limit harian (biasanya 20-50 request/hari)
- Ekstraksi teks PDF/DOCX dilakukan client-side, hasil teks dikirim ke API (bukan file binary)
- Nemotron 3 adalah reasoning models — bisa lebih lambat dari model biasa karena chain-of-thought internal
- Typing animation bisa di-skip dengan klik tombol stop (panah berubah jadi stop saat generating)

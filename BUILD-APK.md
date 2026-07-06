# Cara Build APK SkelzAI

Saya sudah menyiapkan semua file PWA yang dibutuhkan untuk convert ke APK:
- `public/manifest.json` — manifest lengkap dengan `display_override`, `shortcuts`, dll
- `public/sw.js` — service worker untuk offline support
- `public/icons/` — 5 icon PNG (192px, 512px, maskable, apple-touch, favicon)
- `public/.well-known/assetlinks.json` — untuk TWA verification (Play Store)
- `vercel.json` — headers untuk `.well-known` dan `manifest.json`

Setelah deploy ke Vercel, pilih **salah satu** dari 2 cara di bawah untuk dapatkan APK.

---

## Cara 1: PWABuilder (Paling Mudah, Online, Gratis) ⭐

**Waktu: 2 menit. Tidak perlu install apapun.**

1. **Deploy SkelzAI ke Vercel dulu** (upload zip v2.6.1 ke https://vercel.com/new)
2. Tunggu deploy selesai, catat URL production (misal `https://skelzai.vercel.app`)
3. Buka **https://www.pwabuilder.com/** di browser
4. Masukkan URL SkelzAI Anda di kotak input → klik **"Start"**
5. Tunggu PWABuilder scan PWA (biasanya 10-30 detik)
6. Setelah selesai, klik tombol **"Package For Stores"**
7. Pilih **"Android"** → klik **"Generate Package"**
8. Isi form:
   - **Package ID**: `com.skelzai.app` (atau sesuai selera)
   - **App name**: `SkelzAI`
   - **Short name**: `SkelzAI`
   - **Version**: `2.6.1`
   - **Signing key**: biarkan default (PWABuilder generate untuk Anda) atau upload keystore sendiri
9. Klik **"Generate"** → tunggu 1-2 menit
10. Download file `.zip` berisi:
    - `app-release-universal.apk` ← **APK siap install di Android**
    - `app-bundle.aab` (untuk Play Store)
    - `assetlinks.json` (upload ke hosting untuk verifikasi)
11. **Install APK** di Android:
    - Transfer `app-release-universal.apk` ke HP Android
    - Buka file manager → tap APK → izinkan install dari sumber tidak dikenal
    - Selesai! SkelzAI jadi app native di Android

**Catatan signing**: PWABuilder akan generate keystore otomatis. Simpan file `.keystore` dengan aman — kalau hilang, Anda tidak bisa update app di Play Store dengan package name yang sama.

---

## Cara 2: Bubblewrap CLI (Build Sendiri, Full Control)

**Waktu: 15-30 menit. Butuh JDK 17+ dan internet.**

### Prasyarat
- **Node.js 18+** (sudah ada jika Anda pernah pakai npm)
- **JDK 17+** — install dari https://adoptium.net/
- **Android SDK** — akan di-install otomatis oleh Bubblewrap saat pertama jalan

### Langkah-langkah

1. **Install Bubblewrap CLI** secara global:
   ```bash
   npm install -g @bubblewrap/cli
   ```

2. **Init project** dari manifest PWA:
   ```bash
   mkdir skelzai-android
   cd skelzai-android
   bubblewrap init --manifest https://skelzai.vercel.app/manifest.json
   ```
   Ganti `skelzai.vercel.app` dengan URL Vercel Anda yang sebenarnya.

3. **Jawab pertanyaan interaktif**:
   - Domain: `skelzai.vercel.app` (atau domain custom Anda)
   - Package name: `com.skelzai.app`
   - App name: `SkelzAI`
   - Short name: `SkelzAI`
   - Signing key info: isi atau biarkan default (akan generate otomatis)

4. **Build APK**:
   ```bash
   bubblewrap build
   ```
   Bubblewrap akan:
   - Download Android SDK & build tools (sekali saja, ~500MB)
   - Generate project Gradle
   - Compile & sign APK

5. **APK hasil build** ada di:
   ```
   app/build/outputs/apk/release/app-release-signed.apk
   ```

6. **Install di Android**:
   - Transfer APK ke HP
   - Buka file manager → install → allow unknown source
   - Selesai!

### Update app nanti
Setiap kali ada update di web app, tinggal jalankan:
```bash
bubblewrap update
bubblewrap build
```

---

## Cara 3: Capacitor (Akses Hardware Native)

**Waktu: 30-60 menit. Cocok kalau mau akses kamera, notifikasi push, dll.**

```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init SkelzAI com.skelzai.app --web-dir=public

# Copy web app ke Android project
npx cap add android
npx cap copy

# Build APK (butuh Android Studio)
npx cap open android
# Di Android Studio: Build → Build APK(s)
```

---

## Verifikasi `assetlinks.json` (Wajib untuk Play Store)

Setelah APK di-install, agar Android trust app Anda (no browser URL bar muncul), upload `assetlinks.json` ke hosting:

1. Update `public/.well-known/assetlinks.json` dengan fingerprint keystore Anda:
   ```bash
   keytool -list -v -keystore my-release-key.keystore -alias my-key-alias
   ```
   Copy nilai `SHA256:` tanpa prefix.

2. Replace `REPLACE_WITH_YOUR_APP_SIGNING_CERTIFICATE_FINGERPRINT` di file dengan fingerprint tersebut.

3. Vercel otomatis serve file di `https://skelzai.vercel.app/.well-known/assetlinks.json`

4. Test: buka URL tersebut di browser, harus return JSON dengan fingerprint Anda.

---

## Rekomendasi

Untuk SkelzAI, saya sarankan **Cara 1 (PWABuilder)** karena:
- ✅ Tidak perlu install apapun
- ✅ Cepat (2 menit)
- ✅ Dapat APK siap install + AAB untuk Play Store sekaligus
- ✅ Keystore otomatis di-generate
- ✅ Bisa custom icon, splash screen, dll

Cara 2 (Bubblewrap) cocok kalau Anda developer dan mau otomatisasi build di CI/CD.

Cara 3 (Capacitor) cocok kalau mau akses hardware native (kamera, GPS, notifikasi push, biometric).

---

## Troubleshooting

**"PWABuilder bilang PWA belum ready"**
- Pastikan URL Vercel sudah live dan accessible
- Pastikan `manifest.json` bisa diakses di `https://your-url/manifest.json`
- Pastikan service worker ter-register (buka DevTools → Application → Service Workers)
- Pastikan icon 192px dan 512px tersedia

**"APK install gagal di Android"**
- Aktifkan "Install unknown apps" di Settings → Apps → File Manager
- Pastikan Android version >= 5.0 (Lollipop)
- Coba APK versi universal (`app-release-universal.apk`)

**"App terbuka sebagai browser, bukan fullscreen"**
- `assetlinks.json` belum ter-upload dengan benar
- Test: `curl https://your-url/.well-known/assetlinks.json` harus return JSON
- Fingerprint di assetlinks.json harus match dengan keystore yang sign APK

**"Ingin update app setelah ada perubahan web"**
- PWA: user tinggal refresh → otomatis dapat versi baru (service worker akan update)
- APK: harus rebuild & reinstall. Tapi isi app tetap sama (web view ke URL)

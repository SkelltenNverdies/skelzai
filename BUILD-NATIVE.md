# Cara Build SkelzAI Native Android App (APK)

Panduan lengkap untuk build SkelzAI menjadi aplikasi Android native (.apk) menggunakan Capacitor.

---

## Prasyarat

Sebelum mulai, pastikan Anda punya:

1. **Node.js 18+** — Download dari https://nodejs.org/
2. **JDK 17+** — Download dari https://adoptium.net/ (pilih JDK 17 LTS)
3. **Android Studio** — Download dari https://developer.android.com/studio
4. **Android SDK** — Install via Android Studio → SDK Manager

### Setup Environment Variables

Tambahkan ke `~/.bashrc` atau `~/.zshrc`:

```bash
# Android SDK
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/tools
export PATH=$PATH:$ANDROID_HOME/tools/bin

# Java (JDK 17)
export JAVA_HOME=/usr/lib/jvm/temurin-17  # sesuaikan path
export PATH=$PATH:$JAVA_HOME/bin
```

Lalu jalankan: `source ~/.bashrc` (atau `source ~/.zshrc`)

---

## Step 1: Setup Project

```bash
# Masuk ke folder skelzai
cd skelzai

# Berikan permission execute ke script
chmod +x setup-native.sh

# Jalankan setup script
./setup-native.sh
```

Script ini akan:
- Install Capacitor dependencies
- Add Android platform
- Sync web assets
- Copy icons & splash screen
- Configure AndroidManifest.xml dengan permissions

---

## Step 2: Build APK (Debug)

**Debug APK** = untuk testing, tidak perlu signing key

```bash
# Method 1: Via command line
cd android
./gradlew assembleDebug

# APK akan ada di:
# android/app/build/outputs/apk/debug/app-debug.apk
```

Atau via Android Studio:
```bash
npx cap open android
```
Lalu di Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**

---

## Step 3: Build APK (Release, Signed)

**Release APK** = untuk distribusi/install di device lain, perlu signing key

### 3a. Generate Signing Key (sekali saja)

```bash
keytool -genkey -v -keystore skelzai-release.keystore -alias skelzai -keyalg RSA -keysize 2048 -validity 10000

# Isi:
# Enter keystore password: [buat password kuat]
# Re-enter new password: [ulangi]
# What is your first and last name?: Gabriel Arjun Pangestu
# What is the name of your organizational unit?: SkelzAI
# What is the name of your organization?: SkelzAI
# What is the name of your City or Locality?: [kota Anda]
# What is the name of your State or Province?: [provinsi Anda]
# What is the two-letter country code for this unit?: ID
```

**SIMPAN FILE .keystore DENGAN AMAN!** Kalau hilang, Anda tidak bisa update app.

### 3b. Configure Signing di Gradle

Edit `android/app/build.gradle`, tambahkan sebelum `dependencies`:

```gradle
android {
    // ... existing config ...
    
    signingConfigs {
        release {
            storeFile file('../../skelzai-release.keystore')
            storePassword 'password_anda'
            keyAlias 'skelzai'
            keyPassword 'password_anda'
        }
    }
    
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
```

### 3c. Build Release APK

```bash
cd android
./gradlew assembleRelease

# APK akan ada di:
# android/app/build/outputs/apk/release/app-release.apk
```

---

## Step 4: Install APK di Android

### Method 1: Transfer via USB/ADB

```bash
# Hubungkan HP via USB (enable USB Debugging di Developer Options)
adb install android/app/build/outputs/apk/release/app-release.apk
```

### Method 2: Transfer Manual

1. Copy file `.apk` ke HP Android (via USB, Bluetooth, cloud drive, dll)
2. Buka File Manager di HP
3. Tap file APK → "Install"
4. Jika muncul "For your security, your phone is not allowed to install unknown apps":
   - Settings → Apps → File Manager → "Install unknown apps" → Allow
5. Install → selesai!

---

## Step 5: Build AAB untuk Play Store

```bash
cd android
./gradlew bundleRelease

# AAB akan ada di:
# android/app/build/outputs/bundle/release/app-release.aab
```

Upload ke https://play.google.com/console → Create app → Upload AAB

---

## Update App Setelah Perubahan Web

Setiap kali Anda update `index.html` atau `api/chat.js`:

```bash
# Sync web assets ke Android
npx cap sync android

# Build APK baru
cd android && ./gradlew assembleRelease
```

---

## Troubleshooting

### Error: "SDK location not found"

```bash
# Buat file local.properties di folder android/
echo "sdk.dir=$HOME/Android/Sdk" > android/local.properties
```

### Error: "Java version not supported"

Pastikan JDK 17:
```bash
java -version
# Harus: openjdk version "17.x.x"
```

### Error: "Gradle build failed"

```bash
# Clean build
cd android
./gradlew clean
./gradlew assembleDebug
```

### Error: "Capacitor not found"

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
npx cap sync
```

### App crash saat dibuka

1. Cek log: `adb logcat | grep -i error`
2. Pastikan `npx cap sync android` sudah dijalankan setelah perubahan web
3. Cek `capacitor.config.ts` — pastikan `webDir: 'public'`

---

## Fitur Native yang Tersedia

| Fitur | Status | Plugin |
|-------|--------|--------|
| Fullscreen mode | ✅ | Capacitor core |
| Splash screen | ✅ | @capacitor/splash-screen |
| Status bar control | ✅ | @capacitor/status-bar |
| Keyboard handling | ✅ | @capacitor/keyboard |
| Haptic feedback | ✅ | @capacitor/haptics |
| Clipboard | ✅ | @capacitor/clipboard |
| Share | ✅ | @capacitor/share |
| File system | ✅ | @capacitor/filesystem |
| Preferences (storage) | ✅ | @capacitor/preferences |
| Camera | ⚠️ Browser-based | Web API |
| Push notifications | ❌ Perlu setup | @capacitor/push-notifications |
| Biometric | ❌ Perlu setup | @capacitor-community/biometric-auth |

---

## App Info

- **Package ID**: `com.skelzai.app`
- **App Name**: SkelzAI
- **Min SDK**: 23 (Android 6.0+)
- **Target SDK**: 34 (Android 14)
- **Background**: `#1F1E1D` (warm dark)
- **Accent**: `#D97757` (coral)
- **Splash**: Logo SkelzAI di tengah, bg warm dark

---

## VS PWA

| Aspek | PWA | Native (Capacitor) |
|-------|-----|-------------------|
| Install | Via browser Chrome | APK langsung |
| Play Store | Tidak bisa | ✅ Bisa upload AAB |
| Offline | ✅ Service worker | ✅ Bundled assets |
| Performance | Browser WebView | ✅ Optimized WebView |
| Push notifications | ❌ | ✅ Bisa ditambah |
| Native APIs | Terbatas | ✅ Full access |
| File size | 0 (web) | ~5-10MB APK |
| Updates | Auto (refresh) | Manual rebuild |

---

## Tips

1. **Test di emulator dulu** sebelum install di device fisik
2. **Backup keystore** di cloud storage yang aman
3. **Version code** harus naik setiap update Play Store
4. **ProGuard** bisa di-enable untuk reduce APK size (tapi test dulu)
5. **App Bundle (AAB)** lebih kecil dari APK untuk Play Store

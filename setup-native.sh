#!/bin/bash
# SkelzAI Capacitor Setup Script
# Run this script to initialize the native Android project
#
# Prerequisites:
#   - Node.js 18+ (https://nodejs.org/)
#   - JDK 17+ (https://adoptium.net/)
#   - Android Studio (https://developer.android.com/studio)
#   - Android SDK (installed via Android Studio)
#
# Usage:
#   chmod +x setup-native.sh
#   ./setup-native.sh

set -e

echo "============================================"
echo "  SkelzAI Native Android Setup"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js tidak ditemukan. Install dari https://nodejs.org/"
    exit 1
fi
echo "✓ Node.js: $(node --version)"

# Check Java
if ! command -v java &> /dev/null; then
    echo "ERROR: Java tidak ditemukan. Install JDK 17+ dari https://adoptium.net/"
    exit 1
fi
echo "✓ Java: $(java -version 2>&1 | head -1)"

# Check ANDROID_HOME
if [ -z "$ANDROID_HOME" ]; then
    echo "WARNING: ANDROID_HOME tidak di-set."
    echo "  Set di ~/.bashrc atau ~/.zshrc:"
    echo "  export ANDROID_HOME=\$HOME/Android/Sdk"
    echo "  export PATH=\$PATH:\$ANDROID_HOME/platform-tools"
    echo ""
    echo "  Atau buka Android Studio → SDK Manager → install Android SDK"
else
    echo "✓ ANDROID_HOME: $ANDROID_HOME"
fi

echo ""
echo "============================================"
echo "  Step 1: Install dependencies"
echo "============================================"

# Backup original package.json and use native one
if [ ! -f "package.json.backup" ]; then
    cp package.json package.json.backup
fi
cp package-native.json package.json

npm install

echo ""
echo "✓ Dependencies installed"

echo ""
echo "============================================"
echo "  Step 2: Add Android platform"
echo "============================================"

if [ ! -d "android" ]; then
    npx cap add android
    echo "✓ Android platform added"
else
    echo "✓ Android platform already exists"
fi

echo ""
echo "============================================"
echo "  Step 3: Sync web assets"
echo "============================================"

npx cap sync android
echo "✓ Web assets synced"

echo ""
echo "============================================"
echo "  Step 4: Copy splash screen & icons"
echo "============================================"

# Create Android resources directory structure
ANDROID_RES="android/app/src/main/res"

# Copy icons to Android mipmap directories
if [ -d "public/icons" ]; then
    # Icon 192px → mdpi
    mkdir -p "$ANDROID_RES/mipmap-mdpi"
    cp public/icons/icon-192.png "$ANDROID_RES/mipmap-mdpi/ic_launcher.png" 2>/dev/null || true
    
    # Icon 512px → xxxhdpi
    mkdir -p "$ANDROID_RES/mipmap-xxxhdpi"
    cp public/icons/icon-512.png "$ANDROID_RES/mipmap-xxxhdpi/ic_launcher.png" 2>/dev/null || true
    
    # Also set as round icon
    cp public/icons/icon-192.png "$ANDROID_RES/mipmap-mdpi/ic_launcher_round.png" 2>/dev/null || true
    cp public/icons/icon-512.png "$ANDROID_RES/mipmap-xxxhdpi/ic_launcher_round.png" 2>/dev/null || true
    
    echo "✓ Icons copied"
fi

# Create splash screen background
mkdir -p "$ANDROID_RES/drawable"
cat > "$ANDROID_RES/drawable/splash.xml" << 'SPLASH'
<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/splash_bg"/>
    <item android:gravity="center">
        <bitmap android:src="@mipmap/ic_launcher" android:gravity="center"/>
    </item>
</layer-list>
SPLASH

# Create colors.xml for splash background
mkdir -p "$ANDROID_RES/values"
cat > "$ANDROID_RES/values/colors.xml" << 'COLORS'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="splash_bg">#1F1E1D</color>
    <color name="ic_launcher_background">#1F1E1D</color>
</resources>
COLORS

# Create styles.xml for splash
cat > "$ANDROID_RES/values/styles.xml" << 'STYLES'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="colorPrimary">#D97757</item>
        <item name="colorPrimaryDark">#1F1E1D</item>
        <item name="android:statusBarColor">#1F1E1D</item>
    </style>
    <style name="AppTheme.NoActionBarLaunch" parent="AppTheme">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
STYLES

echo "✓ Splash screen configured"

echo ""
echo "============================================"
echo "  Step 5: Update AndroidManifest.xml"
echo "============================================"

MANIFEST="android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
    # Add permissions for camera, file access, internet
    sed -i 's/<application/<uses-permission android:name="android.permission.INTERNET"\/>\n    <uses-permission android:name="android.permission.CAMERA"\/>\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"\/>\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"\/>\n    <application/' "$MANIFEST"
    echo "✓ AndroidManifest.xml updated with permissions"
fi

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Open Android Studio:"
echo "     npx cap open android"
echo ""
echo "  2. Build APK (Debug):"
echo "     cd android && ./gradlew assembleDebug"
echo "     → APK: android/app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "  3. Build APK (Release, signed):"
echo "     cd android && ./gradlew assembleRelease"
echo "     → APK: android/app/build/outputs/apk/release/app-release.apk"
echo ""
echo "  4. Run on device/emulator:"
echo "     npx cap run android"
echo ""
echo "  5. After web changes, sync:"
echo "     npx cap sync android"
echo ""
echo "============================================"

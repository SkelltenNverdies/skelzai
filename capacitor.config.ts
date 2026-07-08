import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.skelzai.app',
  appName: 'SkelzAI',
  webDir: 'public',
  server: {
    // Use live URL for production, or 'public' for local bundled
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#1F1E1D',
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#1F1E1D',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      androidSpinnerStyle: 'large',
      spinnerColor: '#D97757',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1F1E1D',
      overlaysWebView: false,
    },
    Keyboard: {
      resize: 'body',
      style: 'DARK',
      resizeOnFullScreen: true,
    },
    Haptics: {
      enable: true,
    },
  },
};

export default config;

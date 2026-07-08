/* ===== CAPACITOR NATIVE BRIDGE ===== */
// This file bridges web app with Capacitor native plugins
// Only loads when running inside Capacitor (native app), not in browser

var isNativeApp = false;

// Detect if running inside Capacitor native app
if (typeof window !== 'undefined' && window.Capacitor) {
  isNativeApp = window.Capacitor.isNativePlatform();
}

async function initNativePlugins() {
  if (!isNativeApp) return;

  try {
    // Import Capacitor plugins
    var SplashScreen = window.Capacitor.Plugins.SplashScreen;
    var StatusBar = window.Capacitor.Plugins.StatusBar;
    var Keyboard = window.Capacitor.Plugins.Keyboard;
    var App = window.Capacitor.Plugins.App;
    var Haptics = window.Capacitor.Plugins.Haptics;

    // Hide splash screen after 1.5s
    if (SplashScreen) {
      setTimeout(function() {
        SplashScreen.hide();
      }, 1500);
    }

    // Configure status bar
    if (StatusBar) {
      StatusBar.setStyle({ style: 'DARK' });
      StatusBar.setBackgroundColor({ color: '#1F1E1D' });
      StatusBar.setOverlaysWebView({ overlay: false });
    }

    // Configure keyboard
    if (Keyboard) {
      Keyboard.setResizeMode({ mode: 'body' });
      Keyboard.setStyle({ style: 'DARK' });
    }

    // Handle back button (Android)
    if (App) {
      App.addListener('backButton', function(data) {
        // If modal is open, close it
        var modals = ['MOL', 'NM', 'AM', 'CM', 'SC', 'SETTINGS', 'AUTH'];
        for (var i = 0; i < modals.length; i++) {
          var m = document.getElementById(modals[i]);
          if (m && !m.classList.contains('hidden')) {
            closeM(modals[i]);
            return;
          }
        }
        // If sidebar is open, close it
        var sb = document.getElementById('SB');
        if (sb && !sb.classList.contains('-translate-x-full') && window.innerWidth < 1024) {
          togSB();
          return;
        }
        // If profile menu is open, close it
        if (pmOpen) {
          closePM();
          return;
        }
        // If generating, ask to stop
        if (generating) {
          showConfirm('Keluar', 'Tutup aplikasi?', function() {
            App.exitApp();
          });
          return;
        }
        // Default: exit app
        App.exitApp();
      });

      // Handle app state change (background/foreground)
      App.addListener('appStateChange', function(state) {
        if (!state.isActive) {
          // App went to background — save state
          try { save(); } catch(e) {}
        }
      });
    }

    // Override toast to add haptic feedback
    if (Haptics) {
      var originalToast = window.toast;
      if (originalToast) {
        window.toast = function(msg, type) {
          // Haptic feedback
          if (type === 'success') {
            Haptics.notification({ type: 'SUCCESS' });
          } else if (type === 'error') {
            Haptics.notification({ type: 'ERROR' });
          } else if (type === 'warning') {
            Haptics.notification({ type: 'WARNING' });
          } else {
            Haptics.impact({ style: 'LIGHT' });
          }
          originalToast(msg, type);
        };
      }
    }

    console.log('[SkelzAI] Native plugins initialized');
  } catch (err) {
    console.warn('[SkelzAI] Native plugin error:', err);
  }
}

// Initialize on DOM ready
if (isNativeApp) {
  document.addEventListener('DOMContentLoaded', function() {
    initNativePlugins();
  });
}

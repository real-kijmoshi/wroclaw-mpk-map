/**
 * Expo app config.
 *
 * This replaces the old static app.json so the API base URL can come from the
 * environment at build time instead of being committed as a hardcoded IP.
 * Set API_URL in the shell or in an EAS build profile; the default points at
 * the public deployment.
 */

const API_URL = process.env.API_URL || 'https://wroclaw-mpk-api.onrender.com';

const LOCATION_USAGE =
  'Twoja lokalizacja jest używana tylko po to, aby pokazać Cię na mapie obok pojazdów MPK. ' +
  'Nie jest nigdzie wysyłana ani zapisywana.';

export default {
  expo: {
    name: 'WroMapa',
    slug: 'wrocmap',
    version: '2.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    scheme: 'wromapa',
    userInterfaceStyle: 'light',
    primaryColor: '#0B5FBF',
    platforms: ['ios', 'android', 'web'],
    owner: 'kijmoshi',

    splash: {
      image: './assets/splash.png',
      resizeMode: 'cover',
      backgroundColor: '#0E141B',
    },

    assetBundlePatterns: ['**/*'],

    ios: {
      bundleIdentifier: 'com.kijmoshi.wrocmap',
      supportsTablet: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSLocationWhenInUseUsageDescription: LOCATION_USAGE,
      },
    },

    android: {
      // Required before the app can be uploaded to Google Play.
      package: 'com.kijmoshi.wrocmap',
      versionCode: 2,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0E141B',
      },
      // Location permissions come from the expo-location plugin below.
      // Everything talks to the API over HTTPS, so cleartext stays off.
      usesCleartextTraffic: false,
      edgeToEdgeEnabled: true,
    },

    web: {
      bundler: 'metro',
      favicon: './assets/icon.png',
    },

    plugins: [
      [
        'expo-splash-screen',
        {
          image: './assets/icon.png',
          backgroundColor: '#0E141B',
          imageWidth: 180,
        },
      ],
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission: LOCATION_USAGE,
          locationWhenInUsePermission: LOCATION_USAGE,
          isAndroidBackgroundLocationEnabled: false,
        },
      ],
    ],

    extra: {
      apiUrl: API_URL,
      eas: {
        projectId: 'f374495e-92ee-4948-aa17-b8622cf2ea20',
      },
    },

    updates: {
      url: 'https://u.expo.dev/f374495e-92ee-4948-aa17-b8622cf2ea20',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
  },
};

const fs = require("node:fs");
const path = require("node:path");
const pkg = require("./package.json");
const withAndroidAsyncStorageSize = require("./plugins/with-android-async-storage-size");
const withAndroidOptionalCamera = require("./plugins/with-android-optional-camera");
const withAndroidProfileable = require("./plugins/with-android-profileable");
const withAndroidReleaseSigning = require("./plugins/with-android-release-signing");
const withFdroidAutolinking = require("./plugins/with-fdroid-autolinking");
const withPasteInput = require("./plugins/with-paste-input");
const withAndroidScroll = require("./modules/paseo-scroll/app.plugin");
const { getNativeReleaseVersion } = require("./native-release-version");
const appVariant = process.env.APP_VARIANT ?? "production";
const isFdroidBuild = process.env.PASEO_FDROID_BUILD === "1";
const isWatchdogBuild = process.env.PASEO_WATCHDOG_BUILD === "1";
const isProfileBuild = process.env.PASEO_PROFILE_BUILD === "1";

const buildProfile = isFdroidBuild
  ? {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
      cameraPlugins: [],
      fdroidPlugins: [withFdroidAutolinking],
      notificationPlugins: [],
    }
  : {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "CAMERA",
        "android.permission.CAMERA",
      ],
      cameraPlugins: [
        [
          "expo-camera",
          {
            cameraPermission:
              "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
          },
        ],
      ],
      fdroidPlugins: [],
      notificationPlugins: [
        [
          "expo-notifications",
          {
            icon: "./assets/images/notification-icon.png",
            color: "#20744A",
          },
        ],
      ],
    };

function resolveSecretFile(params) {
  const fromEnv = process.env[params.envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const fallbackAbsolutePath = path.resolve(__dirname, params.fallbackRelativePath);
  if (fs.existsSync(fallbackAbsolutePath)) {
    return params.fallbackRelativePath;
  }

  return undefined;
}

const variants = {
  production: {
    name: "Paseo",
    packageId: "sh.paseo",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_PROD",
      fallbackRelativePath: "./.secrets/google-services.prod.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_PROD",
      fallbackRelativePath: "./.secrets/GoogleService-Info.prod.plist",
    }),
  },
  development: {
    name: "Paseo Debug",
    packageId: "sh.paseo.debug",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_DEBUG",
      fallbackRelativePath: "./.secrets/google-services.debug.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_DEBUG",
      fallbackRelativePath: "./.secrets/GoogleService-Info.debug.plist",
    }),
  },
  // Fork build for Obtainium: own package, Firebase app, and Expo project so push works next to
  // the official app. Release builds sign with the keystore from PASEO_ANDROID_KEYSTORE_*.
  tlctr: {
    name: "Paseo (tlctr)",
    packageId: "sh.paseo.tlctr",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_TLCTR",
      fallbackRelativePath: "./.secrets/google-services.tlctr.json",
    }),
    googleServiceInfoPlist: undefined,
    expoProject: {
      slug: "paseo",
      owner: "trlctr",
      projectId: "5c3c8e24-3dcb-4259-9a5a-d1434721c747",
    },
    releaseSigning: true,
    forkBuildNumber: true,
  },
};

const variant = variants[appVariant] ?? variants.production;
const expoProject = variant.expoProject ?? {
  slug: "voice-mobile",
  owner: "getpaseo",
  projectId: "0e7f65ce-0367-46c8-a238-2b65963d235a",
};
const nativeReleaseVersion = getNativeReleaseVersion(pkg.version);

// Each fork build of one upstream version gets its own versionName (`0.11.2-tlctr.3`) and a larger
// versionCode, so Obtainium sees an update and Android installs it over the last build. The
// workflow sets PASEO_TLCTR_BUILD (1-99, counted per upstream version); local builds are 0.
// The app's own version checks read package.json, not these native fields.
function withForkBuildNumber(release) {
  const raw = process.env.PASEO_TLCTR_BUILD ?? "0";
  const build = Number(raw);
  if (!Number.isInteger(build) || build < 0 || build > 99) {
    throw new Error(`PASEO_TLCTR_BUILD must be an integer from 0 to 99, got: ${raw}`);
  }
  const androidVersionCode = release.androidVersionCode * 100 + build;
  if (androidVersionCode > 2_100_000_000) {
    throw new Error(`Fork versionCode is out of range: ${androidVersionCode}`);
  }
  return {
    ...release,
    appVersion: `${release.appVersion}-tlctr.${build}`,
    androidVersionCode,
  };
}
const appRelease = variant.forkBuildNumber
  ? withForkBuildNumber(nativeReleaseVersion)
  : nativeReleaseVersion;

export default {
  expo: {
    name: variant.name,
    slug: expoProject.slug,
    version: appRelease.appVersion,
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "paseo",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSMicrophoneUsageDescription: "This app needs access to the microphone for voice commands.",
        ITSAppUsesNonExemptEncryption: false,
      },
      bundleIdentifier: variant.packageId,
      ...(variant.googleServiceInfoPlist
        ? { googleServicesFile: variant.googleServiceInfoPlist }
        : {}),
      buildNumber: nativeReleaseVersion.iosBuildNumber,
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#000000",
        foregroundImage: "./assets/images/android-icon-foreground.png",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
      // Allow HTTP connections for local network hosts (required for release builds)
      usesCleartextTraffic: true,
      permissions: buildProfile.androidPermissions,
      package: variant.packageId,
      versionCode: appRelease.androidVersionCode,
      ...(variant.googleServicesFile ? { googleServicesFile: variant.googleServicesFile } : {}),
    },
    web: {
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "expo-router",
      withPasteInput,
      withAndroidScroll,
      [withAndroidAsyncStorageSize, 64],
      ...buildProfile.cameraPlugins,
      withAndroidOptionalCamera,
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
      ...buildProfile.notificationPlugins,
      "expo-audio",
      [
        "expo-gradle-jvmargs",
        {
          xmx: "4096m",
          maxMetaspace: "1024m",
        },
      ],
      [
        "expo-build-properties",
        {
          ios: { enableSceneSupport: true },
          android: {
            minSdkVersion: 29,
            kotlinVersion: "2.1.20",
            // Allow HTTP connections for local network hosts in release builds
            usesCleartextTraffic: true,
          },
        },
      ],
      ...buildProfile.fdroidPlugins,
      ...(isProfileBuild || isWatchdogBuild ? [withAndroidProfileable] : []),
      ...(variant.releaseSigning ? [withAndroidReleaseSigning] : []),
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      fdroidBuild: isFdroidBuild,
      profileBuild: isProfileBuild,
      watchdogBuild: isWatchdogBuild,
      diagnosticRevision: process.env.PASEO_DIAGNOSTIC_REVISION,
      diagnosticBuildTime: process.env.PASEO_DIAGNOSTIC_BUILD_TIME,
      router: {},
      eas: {
        projectId: expoProject.projectId,
      },
    },
    owner: expoProject.owner,
  },
};

const { withAppBuildGradle } = require("expo/config-plugins");

// Expo's template signs release builds with the debug keystore. Sign them with the keystore named
// by PASEO_ANDROID_KEYSTORE_FILE instead, so every build installs as an update of the last one.
// Without that variable, release builds keep the debug signing (local test builds).
const RELEASE_SIGNING_CONFIG = `
        release {
            def keystore = System.getenv("PASEO_ANDROID_KEYSTORE_FILE")
            if (keystore) {
                storeFile file(keystore)
                storePassword System.getenv("PASEO_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("PASEO_ANDROID_KEY_ALIAS") ?: "paseo"
                keyPassword System.getenv("PASEO_ANDROID_KEY_PASSWORD") ?: System.getenv("PASEO_ANDROID_KEYSTORE_PASSWORD")
            }
        }`;

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    const gradle = modConfig.modResults.contents;
    const signingConfigs = /signingConfigs \{\n/;
    const releaseBuildType =
      /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!signingConfigs.test(gradle) || !releaseBuildType.test(gradle)) {
      throw new Error("Could not find the signing configuration in android/app/build.gradle");
    }
    modConfig.modResults.contents = gradle
      .replace(signingConfigs, (match) => `${match.trimEnd()}${RELEASE_SIGNING_CONFIG}\n`)
      .replace(
        releaseBuildType,
        '$1signingConfig System.getenv("PASEO_ANDROID_KEYSTORE_FILE") ? signingConfigs.release : signingConfigs.debug',
      );
    return modConfig;
  });
}

module.exports = withAndroidReleaseSigning;

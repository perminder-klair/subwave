// Expo config plugin: pin the Android Gradle wrapper version.
//
// `expo prebuild` regenerates android/ from the template, which (for this
// Expo/RN version) pins Gradle 9.3.1. That build fails because the bundled
// React Native / Expo Gradle plugins reference `JvmVendorSpec.IBM_SEMERU`,
// removed in Gradle 9. Until the toolchain catches up we pin the wrapper to a
// Gradle 8.x that still has it. expo-build-properties has no setting for the
// Gradle version, so we rewrite gradle-wrapper.properties via a dangerous mod.
//
// Usage in app.json plugins: ["./plugins/withGradleVersion", { "version": "8.14.3" }]

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DEFAULT_VERSION = '8.14.3';

module.exports = function withGradleVersion(config, { version = DEFAULT_VERSION } = {}) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const file = path.join(
        cfg.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties',
      );
      if (!fs.existsSync(file)) {
        throw new Error(`[withGradleVersion] gradle-wrapper.properties not found at ${file}`);
      }
      const distributionUrl = `https\\://services.gradle.org/distributions/gradle-${version}-bin.zip`;
      const contents = fs
        .readFileSync(file, 'utf8')
        .replace(/^distributionUrl=.*$/m, `distributionUrl=${distributionUrl}`);
      fs.writeFileSync(file, contents);
      return cfg;
    },
  ]);
};

// Expo config plugin: raise the Gradle/Kotlin JVM memory for the Android build.
//
// `expo prebuild` bakes `org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m`
// into android/gradle.properties. 512m of Metaspace is too small for this
// module set: the KSP/Kotlin step (`:expo-updates:kspReleaseKotlin`) throws
// `OutOfMemoryError: Metaspace` and crashes the Gradle daemon. It bites hardest
// on a local `eas build --local` (EAS cloud workers have more headroom), but the
// ceiling is too low everywhere. We raise the metaspace ceiling and give the
// Kotlin daemon its own budget. This is build-time only — it does not change the
// app binary. expo-build-properties has no setting for JVM args, so we edit
// gradle.properties via withGradleProperties.
//
// Usage in app.json plugins: "./plugins/withGradleMemory"

const { withGradleProperties } = require('@expo/config-plugins');

const PROPS = {
  'org.gradle.jvmargs': '-Xmx3072m -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8',
  'kotlin.daemon.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=1024m',
};

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    for (const [key, value] of Object.entries(PROPS)) {
      const existing = cfg.modResults.find(
        (item) => item.type === 'property' && item.key === key,
      );
      if (existing) {
        existing.value = value;
      } else {
        cfg.modResults.push({ type: 'property', key, value });
      }
    }
    return cfg;
  });
};

// Expo config plugin: raise the Gradle/Kotlin JVM memory for the Android build.
//
// `expo prebuild` bakes `MaxMetaspaceSize=512m` into gradle.properties, which
// is too small for this module set: the KSP/Kotlin step throws
// `OutOfMemoryError: Metaspace` and crashes the Gradle daemon. This raises the
// metaspace ceiling and gives the Kotlin daemon its own budget. Build-time
// only. expo-build-properties has no setting for JVM args, hence the direct
// gradle.properties edit.
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

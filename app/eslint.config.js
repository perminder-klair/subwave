// https://docs.expo.dev/guides/using-eslint/
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    files: ['src/lib/types.ts'],
    rules: { '@typescript-eslint/array-type': 'off' },
  },
  globalIgnores(['dist/**', 'android/**', 'ios/**']),
  {
    rules: {
      // Station changes reset derived state; foreground effects catch up clocks.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);

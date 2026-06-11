module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // react-native-reanimated/react-native-worklets plugin MUST be last.
    plugins: ['react-native-worklets/plugin'],
  };
};

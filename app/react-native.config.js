// react-native-carplay is iOS-only in this app: its Android side targets the
// Car App Library (the navigation/POI tier), NOT the media-browse path Android
// Auto uses for audio apps — that half is served by the react-native-track-
// player fork's Media3 MediaLibraryService (see src/car/browseTree.ts).
// Nulling the platform keeps the androidx.car.app stack out of the Android
// build entirely.
module.exports = {
  dependencies: {
    'react-native-carplay': {
      platforms: {
        android: null,
      },
    },
  },
};

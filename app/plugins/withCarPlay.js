// Expo config plugin: the CarPlay app, behind SUBWAVE_CARPLAY=1.
//
// The CarPlay UI is Swift in targets/live-activity/_shared/SubwaveCarPlay.swift. This
// plugin only switches it on:
//
//   1. `com.apple.developer.carplay-audio` in the entitlements. Apple grants
//      it on request, and a DEVICE build cannot be signed with it until the
//      grant is on the App ID, so it is opt-in: set SUBWAVE_CARPLAY=1 for a
//      simulator build (the CarPlay simulator ignores provisioning) and, once
//      the grant lands, in eas.json. Unset, the app is exactly as before.
//   2. A CarPlay scene role in the scene manifest that `ios.enableSceneSupport`
//      writes, and the phone role's delegate swapped for PhoneSceneDelegate,
//      which adopts React Native when the car launched the app first.
//
// Must come BEFORE expo-build-properties in app.json: a later plugin's Info.plist
// mod runs first, and this one edits the manifest that one creates.
//
// Usage in app.json plugins: "./plugins/withCarPlay"

const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

const ENTITLEMENT = 'com.apple.developer.carplay-audio';
const PHONE_ROLE = 'UIWindowSceneSessionRoleApplication';
const CAR_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication';

function enabled() {
  return process.env.SUBWAVE_CARPLAY === '1';
}

function withCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    if (enabled()) cfg.modResults[ENTITLEMENT] = true;
    else delete cfg.modResults[ENTITLEMENT];
    return cfg;
  });
}

function withCarPlayScene(config) {
  return withInfoPlist(config, (cfg) => {
    if (!enabled()) return cfg;
    const manifest = cfg.modResults.UIApplicationSceneManifest;
    const phone = manifest?.UISceneConfigurations?.[PHONE_ROLE]?.[0];
    if (!phone) {
      throw new Error(
        'withCarPlay: no scene manifest. Turn on expo-build-properties ios.enableSceneSupport, ' +
          'and list ./plugins/withCarPlay before expo-build-properties in app.json.',
      );
    }
    phone.UISceneDelegateClassName = 'SubwavePhoneSceneDelegate';
    manifest.UISceneConfigurations[CAR_ROLE] = [
      {
        UISceneConfigurationName: 'CarPlay',
        UISceneDelegateClassName: 'SubwaveCarPlaySceneDelegate',
      },
    ];
    return cfg;
  });
}

module.exports = function withCarPlay(config) {
  return withCarPlayScene(withCarPlayEntitlement(config));
};

# Dependency maintenance

The app uses Expo SDK 57. Upgrade Expo first, then let `npx expo install --fix`
align React Native and native modules. Use stable releases. See the
[SDK 57 release notes](https://expo.dev/changelog/sdk-57) and
[Expo upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/).

Several packages intentionally remain below their npm `latest` tag:

| Packages | Constraint |
| --- | --- |
| React, React Native, Skia, AsyncStorage, Reanimated, Worklets, Screens, Safe Area, SVG | Use Expo's recommended versions from `expo/bundledNativeModules.json`. |
| NativeWind, Tailwind | Stable NativeWind 4 uses Tailwind 3. Tailwind 4 requires migrating to NativeWind 5, currently a release candidate. |
| TypeScript | Expo's ESLint parser supports TypeScript below 6.1; keep TypeScript 6 until it supports 7. |
| ESLint | `eslint-plugin-react` supports ESLint 9; keep 9 until it supports 10. |
| Track Player | Latest stable is still 4.1.2. Keep the Android New Architecture patch. |

[NativeWind's installation guide](https://www.nativewind.dev/docs/getting-started/installation)
describes the stable styling setup. Check installed parser and plugin peer
dependencies before changing the TypeScript or ESLint major version.

Run from `app/` after a dependency change:

```sh
npm ci
npm run lint
npm test
npx expo install --check
npm run doctor
npx expo export --platform all
npx expo prebuild --no-install --platform all
```

Prebuild regenerates the ignored native projects. It may also generate
`targets/live-activity/Info.plist`; that output is derived from the target config.
Check native playback, background audio, remote controls, Cast/AirPlay and the
Live Activity on devices using [the QA checklist](QA-CHECKLIST.md) before release.
Dependency changes require fresh native builds, including development clients.
The fingerprint runtime prevents these updates from reaching older binaries
through OTA.

## SDK 57 verification, 2026-10-07

Clean installation and the Track Player patch apply successfully. ESLint and
TypeScript pass, all 27 app tests pass, and Expo Doctor passes all 21 checks.
Both Android and iOS bundles export and both native projects regenerate. Native
compilation and device playback have not been tested for this upgrade.

`npm audit` still reports 43 findings: 22 moderate and 21 high. They include
transitive dependencies in Expo tooling, Apple Targets, Tailwind and image
colors. The available automated fixes include SDK changes and downgrades that
would break this dependency set. These need upstream fixes or a separately
validated library migration; `npm audit fix --force` is unsuitable for this
upgrade.

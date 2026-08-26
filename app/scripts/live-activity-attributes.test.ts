// Drift guard for the Live Activity's data contract.
//
// SubwaveLiveAttributes is compiled TWICE — once into the widget extension and
// once into the Expo module — because the two live in different Swift modules
// and neither can import the other (ActivityKit's own guidance; it matches an
// activity to its widget by the attributes type name, not its module). Two
// copies of a wire format is exactly the shape that drifts silently: add a
// field on one side and the activity simply stops rendering on device, with no
// build error and no log.
//
// So the copies are asserted byte-identical here, the same move the controller
// makes over its zod schema mirror. If this fails, you edited one and not the
// other — copy it across, don't "fix" the test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const WIDGET_COPY = path.join(ROOT, 'targets/live-activity/SubwaveLiveAttributes.swift');
const MODULE_COPY = path.join(ROOT, 'modules/live-activity/ios/SubwaveLiveAttributes.swift');

test('the Live Activity attributes struct is identical in both targets', () => {
  const widget = readFileSync(WIDGET_COPY, 'utf8');
  const module = readFileSync(MODULE_COPY, 'utf8');
  assert.equal(
    widget,
    module,
    `targets/live-activity/SubwaveLiveAttributes.swift and ` +
      `modules/live-activity/ios/SubwaveLiveAttributes.swift have drifted. ` +
      `Copy one over the other — a mismatched ContentState decodes to nothing ` +
      `and the card silently stops rendering on device.`,
  );
});

test('the app group id matches the one declared in app.json', () => {
  const attributes = readFileSync(WIDGET_COPY, 'utf8');
  const declared = /let subwaveAppGroup = "([^"]+)"/.exec(attributes)?.[1];
  assert.ok(declared, 'subwaveAppGroup is not declared in the attributes file');

  const appJson = JSON.parse(readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const groups: string[] =
    appJson.expo?.ios?.entitlements?.['com.apple.security.application-groups'] ?? [];
  assert.ok(
    groups.includes(declared),
    `Swift writes cover art into "${declared}" but app.json entitles ` +
      `[${groups.join(', ')}]. A group the app is not entitled to resolves to ` +
      `nil at runtime, so every cover falls back to the disc mark.`,
  );

  const target = readFileSync(
    path.join(ROOT, 'targets/live-activity/expo-target.config.js'),
    'utf8',
  );
  assert.ok(
    target.includes(declared),
    `The widget target must be entitled to "${declared}" too, or it cannot ` +
      `read the cover the app wrote.`,
  );
});

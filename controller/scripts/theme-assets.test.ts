// Theme background images (themes.ts): the upload writer, the listing and the
// name guard the public /theme-assets/:file route relies on.
//
// Run: npm test -- theme-assets

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-theme-assets-'));
process.env.STATE_DIR = root;

const themes = await import('../src/themes.js');
const { isValidTokenValue } = await import('../src/theme-tokens.js');

after(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 4)]);

test('sniffs the four accepted formats from their bytes', () => {
  assert.equal(themes.sniffThemeImage(PNG)?.ext, 'png');
  assert.equal(themes.sniffThemeImage(JPEG)?.ext, 'jpg');
  assert.equal(themes.sniffThemeImage(WEBP)?.ext, 'webp');
  assert.equal(themes.sniffThemeImage(GIF)?.ext, 'gif');
  assert.equal(themes.sniffThemeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('asset names are slugged and take the SNIFFED extension', () => {
  assert.equal(themes.themeAssetName('My Skyline (2).JPEG', 'jpg'), 'my-skyline-2.jpg');
  assert.equal(themes.themeAssetName('../../etc/passwd.png', 'png'), 'etc-passwd.png');
  assert.equal(themes.themeAssetName('   ', 'webp'), 'background.webp');
  // A .png name holding JPEG bytes is stored as what it is.
  assert.equal(themes.themeAssetName('photo.png', 'jpg'), 'photo.jpg');
});

test('the served-name guard refuses traversal, dotfiles and non-images', () => {
  assert.equal(themes.themeAssetMime('sky.jpg'), 'image/jpeg');
  assert.equal(themes.themeAssetMime('Sky.WEBP'), 'image/webp');
  assert.equal(themes.themeAssetMime('../sky.jpg'), null);
  assert.equal(themes.themeAssetMime('a..b.png'), null);
  assert.equal(themes.themeAssetMime('.hidden.png'), null);
  assert.equal(themes.themeAssetMime('theme.json'), null);
  assert.equal(themes.themeAssetMime('noext'), null);
});

test('save → list → delete round trip, in the station themes folder', async () => {
  const saved = await themes.saveThemeAsset('Night Sky.png', PNG);
  assert.equal(saved.name, 'night-sky.png');
  assert.ok(existsSync(join(themes.themeAssetsDir(), 'night-sky.png')));
  // Theme JSONs and non-images in the same folder are not listed.
  writeFileSync(join(themes.themeAssetsDir(), 'my-theme.json'), '{}');
  const listed = await themes.listThemeAssets();
  assert.deepEqual(listed.map(a => a.name), ['night-sky.png']);
  // The token the editor writes for it passes the save-time validator.
  assert.equal(isValidTokenValue('--bg-image', `url("/theme-assets/${saved.name}")`), true);
  await themes.deleteThemeAsset('night-sky.png');
  assert.deepEqual(await themes.listThemeAssets(), []);
});

test('refuses fakes, empty and oversized uploads', async () => {
  await assert.rejects(themes.saveThemeAsset('evil.png', Buffer.from('<script>alert(1)</script> padding')), /not a JPEG/);
  await assert.rejects(themes.saveThemeAsset('empty.png', Buffer.alloc(0)), /empty/);
  const huge = Buffer.concat([PNG, Buffer.alloc(themes.THEME_ASSET_MAX_BYTES)]);
  await assert.rejects(themes.saveThemeAsset('huge.png', huge), /too large/);
  await assert.rejects(themes.deleteThemeAsset('../settings.json'), /invalid/);
});

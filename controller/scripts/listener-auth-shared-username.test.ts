// A stream password is ONE shared secret and the username is ignored, so every
// listener who follows the docs (`listener:PASSWORD@host`) presents the same
// name. icecast-kh's URL auth admits one connection per username by default:
// the second listener got a 403, and one arriving while the first was still
// closing hung with no answer at all, holding a client slot. Both renderers of
// icecast.xml must therefore allow duplicate users inside every auth block.
//
// Reproduced against icecast 2.4.0-kh22 with a stub auth endpoint: three
// simultaneous listeners on one username were 200/403/403 without the option
// and 200/200/200 with it; an iOS-style range probe followed by the real
// request hung 4 times in 10 without it and 0 in 150 with it.
//
// Run: npx tsx scripts/listener-auth-shared-username.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const docker = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker');

for (const file of ['broadcast-entrypoint.sh', join('aio', 'supervisor.sh')]) {
  test(`${file} lets listeners share a username under the stream password`, () => {
    // Only the lines the script echoes into icecast.xml, not its comments.
    const emitted = readFileSync(join(docker, file), 'utf8')
      .split('\n').filter(line => /^\s*echo\s/.test(line)).join('\n');
    const blocks = emitted.split('<authentication type="url">').slice(1);
    assert.equal(blocks.length, 1, 'expected one rendered listener auth block; a second must carry the option too');
    const block = blocks[0]!.slice(0, blocks[0]!.indexOf('</authentication>'));
    assert.match(block, /listener_add/);
    assert.match(block, /<option name="allow_duplicate_users" value="1"\/>/);
  });
}

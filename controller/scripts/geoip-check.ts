// Diagnose the Dash Listeners "Country" column's GeoIP link. Read-only; runs
// inside the controller container, which ships this file and tsx:
//
//   docker exec <controller> node_modules/.bin/tsx scripts/geoip-check.ts <ip> [<ip>...]
//
// Prints which GeoIP path the controller will use (env vs setting), whether it
// can open the file, and what the database answers for each IP you pass (copy
// the IPs that show "—" from the Dash page).
//
// Every answer comes from the controller's OWN modules, never a restatement:
// config.ts resolves the active station exactly as at boot (stations/active.json,
// else the root), settings.load() reads that station's settings.json, and
// broadcast/geoip.ts picks env-over-setting and opens the file. A script that
// walked every station's settings itself reported the wrong path on a
// multi-station install, which is the operator being sent to fix the wrong file.

import { statSync, readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';
import { config } from '../src/config.js';
import * as settings from '../src/settings.js';
import { geoipStatus, lookupCountry, normalizeLookupIp } from '../src/broadcast/geoip.js';

const ips = process.argv.slice(2);

await settings.load(); // read-only: fills the cache, writes nothing

console.log(`active station dir     : ${config.stateDir}`);
console.log(`GEOIP_DB_PATH env      : ${config.geoip.dbPath || '(unset)'}`);
const setting = String((settings.get() as any)?.stream?.geoipDbPath || '').trim();
console.log(`stream.geoipDbPath     : ${setting || '(empty)'}`);

const status = geoipStatus();
if (status.source === 'none') {
  console.log('\n=> No GeoIP path configured: the database link never runs. Set Admin → Settings → Broadcast & mixer → Listener country → GeoIP database.');
  process.exit(0);
}
console.log(`\npath the controller uses: ${status.path} (from ${status.source === 'env' ? 'GEOIP_DB_PATH' : 'the setting'})`);

try {
  const st = statSync(status.path);
  console.log(`file: ${st.size} bytes, mode ${(st.mode & 0o777).toString(8)}, uid ${st.uid}, mtime ${st.mtime.toISOString()}`);
} catch { /* the open below reports why */ }

if (!status.ok) {
  console.log(`=> CANNOT OPEN: ${status.error || 'unreadable'}`);
  process.exit(1);
}
try {
  const meta = new Reader(readFileSync(status.path)).metadata;
  console.log(`opened OK: ${meta?.databaseType}, built ${meta?.buildEpoch?.toISOString?.() ?? '?'}`);
} catch {
  console.log('opened OK');
}

if (!ips.length) console.log('\n(no IPs passed — add the ones showing "—" on the Dash page)');
for (const raw of ips) {
  const code = lookupCountry(raw);
  const shown = normalizeLookupIp(raw) === raw ? raw : `${raw} (${normalizeLookupIp(raw)})`;
  console.log(`${shown.padEnd(40)} → ${code || 'NO ENTRY in database'}`);
}

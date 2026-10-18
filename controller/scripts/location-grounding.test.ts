// Bug 14 in #1622: pin the rule on rendered prompts, including paths that
// bypass djSystem. Settings and prompt assembly run without a model call.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-location-grounding-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { setCache } = await import('../src/settings/store.js');
const { djSystem, onAirLocationGrounding } = await import('../src/llm/dj.js');
const { locationGroundingRule } = await import('../src/llm/internal/prompts/grounding.js');
const { banterSystem } = await import('../src/llm/internal/prompts/banter.js');
const { cohostedSkillSystem } = await import('../src/llm/internal/prompts/cohosted-skill.js');
const { exchangeSystem, programmePlanSystem } = await import('../src/llm/internal/prompts/programme.js');
const { requestMatcherSystem } = await import('../src/llm/internal/prompts/request.js');
const { directorSystem, simpleSystem, forcedSystem } = await import('../src/skills/_agent.js');
const { dataBlock } = await import('../src/llm/segment-tools.js');
const { pickSystem, requestSystem } = await import('../src/broadcast/dj-agent/schemas.js');

const host = { id: 'p_host', name: 'Nova', soul: 'warm and dry' };
const guests = [{ id: 'p_guest', name: 'Rex', soul: 'quick and curious' }];
const show = { name: 'Night Shift', topic: 'music and the moment' };
const capability = { kind: 'weather', desc: 'Report the supplied weather.' };

async function loadBlankLocation(value: string) {
  // The PATCH API ignores a blank weather label; a hand-edited settings file
  // can contain one. Exercise the actual cold-load path for that case.
  writeFileSync(join(stateRoot, 'settings.json'), JSON.stringify({
    ...settings.get(),
    weather: { ...settings.get().weather, onAirLocation: value, locationName: value },
  }));
  setCache(null);
  await settings.load();
}

function spokenPrompts(): Record<string, string> {
  return {
    // Intros, natural links, adlibs, handoffs, idents, hourly time and solo
    // programme beats all use this system prompt.
    'solo speech': djSystem(host),
    banter: banterSystem({ host, guests, show }),
    'programme plan': programmePlanSystem(),
    'programme exchange': exchangeSystem({ host, show, castBlock: '- p_host: Nova', beatTask: 'Open the show.' }),
    'cohosted grounded skill': cohostedSkillSystem({ capability, host, guests, grounded: true }),
    'cohosted free skill': cohostedSkillSystem({ capability, host, guests }),
    'agent segment director': directorSystem(host, [capability], 'moderate', []),
    'pool segment director': simpleSystem(host, capability, 'moderate', []),
    'forced skill': forcedSystem(host, capability, []),
    'forced grounded skill': forcedSystem(host, capability, [], { mayAbstain: true }),
    'agent picker link': pickSystem(),
    'agent request intro': requestSystem(host),
    'request matcher ack': requestMatcherSystem(host),
  };
}

function assertSourcedPlacesAllowed(prompt: string) {
  assert.match(prompt, /Place names from tool data, verified facts, sleeve notes, track metadata, news or traffic content may be named as that data gives them/);
  assert.match(prompt, /sourced music scenes, recording locations, artist home towns, roads, areas and festivals/);
  assert.match(prompt, /Naming a place in that content does not make it the station's, DJ's or listeners' location/);
  assert.doesNotMatch(prompt, /Never name another city or location|Never name a city or other location|omit place names entirely/);
}

test('every speech prompt restricts station-location claims and permits sourced places', async () => {
  await settings.update({ weather: { onAirLocation: '  Leeds  ', locationName: 'Private weather label' } });
  const rule = onAirLocationGrounding();
  assert.match(rule, /When referring to where the station, the DJ or the listeners are/);
  assert.match(rule, /local weather, local time, "here", "our city" or local events/);
  assert.match(rule, /only the configured on-air location "Leeds", or omit/);
  assert.match(rule, /Never invent or substitute another station, DJ or listener location/);
  for (const [name, prompt] of Object.entries(spokenPrompts())) {
    assert.ok(prompt.includes(rule), `${name} carries the shared rule verbatim`);
    assert.ok(!prompt.includes('Private weather label'), `${name} keeps the weather label private`);
    assertSourcedPlacesAllowed(prompt);
  }
});

test('a blank on-air override uses the resolver fallback, and edits apply live', async () => {
  await settings.update({ weather: { onAirLocation: '', locationName: '  Manchester  ' } });
  assert.equal(settings.resolveOnAirLocation(), 'Manchester');
  for (const [name, prompt] of Object.entries(spokenPrompts())) {
    assert.ok(prompt.includes(onAirLocationGrounding()), `${name} uses the updated rule`);
    assert.ok(!prompt.includes('Leeds'), `${name} does not retain the previous city`);
  }
});

test('clearing stored location names retains the existing default fallback', async () => {
  await loadBlankLocation('');
  assert.equal(settings.resolveOnAirLocation(), DEFAULTS.weather.locationName);
  const rule = onAirLocationGrounding();
  assert.ok(rule.includes(`configured on-air location ${JSON.stringify(DEFAULTS.weather.locationName)}`));
  for (const [name, prompt] of Object.entries(spokenPrompts())) {
    assert.ok(prompt.includes(rule), `${name} keeps the resolver's default location`);
  }
});

test('an absent resolved location forbids local claims while allowing sourced place names', () => {
  // The current resolver supplies a default for missing/empty settings. Pin
  // the rule's absent-location case without changing that settings contract.
  for (const location of ['', '   ']) {
    const rule = locationGroundingRule(location);
    assert.match(rule, /No on-air location is configured/);
    assert.match(rule, /Never claim a station, DJ or listener location/);
    assertSourcedPlacesAllowed(rule);
  }
});

test('news and traffic prompts preserve tool place names without claiming them as home', async () => {
  await settings.update({ weather: { onAirLocation: 'Leeds', locationName: 'Private weather label' } });
  const sources = [
    { kind: 'news', desc: 'Report the supplied headlines.', data: { headlines: [{ title: 'Flood warnings issued in Paris' }] }, place: 'Paris' },
    { kind: 'traffic', desc: 'Report the supplied traffic.', data: { incidents: [{ road: 'M60', area: 'Manchester', text: 'Lane closure near Salford' }] }, place: 'Manchester' },
  ];
  for (const { kind, desc, data, place } of sources) {
    const cap = { kind, desc };
    const systems = [
      simpleSystem(host, cap, 'moderate', []),
      forcedSystem(host, cap, [], { mayAbstain: true }),
      cohostedSkillSystem({ capability: cap, host, guests, grounded: true }),
    ];
    for (const system of systems) {
      const prompt = system + dataBlock(data);
      assertSourcedPlacesAllowed(prompt);
      assert.ok(prompt.includes(place), `${kind} retains the tool's place name`);
      assert.match(prompt, /only the configured on-air location "Leeds"/);
      if (kind === 'traffic') assert.match(prompt, /M60.*Manchester.*Salford/s);
    }
  }
});

test('a custom DJ template without a location still receives the guard', async () => {
  await settings.update({
    djPrompt: 'You are {name}, the station host. Keep every link short and warm.',
    weather: { onAirLocation: 'York', locationName: 'Private weather label' },
  });
  assert.ok(djSystem(host).includes(onAirLocationGrounding()));
  assert.match(onAirLocationGrounding(), /configured on-air location "York"/);
});

test('missing legacy settings retain the existing default location', () => {
  assert.equal(settings.resolveOnAirLocation({}), DEFAULTS.weather.locationName);
});

// Bug 14 in #1622: pin the rule on rendered prompts, including paths that
// bypass djSystem. #2099: a DJ template without {location} withholds the
// location from all of them. Settings and prompt assembly run without a model
// call.
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
const { buildContextLines, djSystem, onAirLocationGrounding } = await import('../src/llm/dj.js');
const { locationGroundingRule } = await import('../src/llm/internal/prompts/grounding.js');
const { banterSystem } = await import('../src/llm/internal/prompts/banter.js');
const { cohostedSkillSystem } = await import('../src/llm/internal/prompts/cohosted-skill.js');
const { exchangeSystem, programmePlanSystem } = await import('../src/llm/internal/prompts/programme.js');
const { requestMatcherSystem } = await import('../src/llm/internal/prompts/request.js');
const { directorSystem, simpleSystem, forcedSystem } = await import('../src/skills/_agent.js');
const { buildSegmentTools, dataBlock, fetchSegmentData } = await import('../src/llm/segment-tools.js');
const weatherTool = await import('../src/skills/builtins/weather/tool.mjs');
const { pickSystem, requestSystem } = await import('../src/broadcast/dj-agent/schemas.js');

const host = { id: 'p_host', name: 'Nova', soul: 'warm and dry' };
const guests = [{ id: 'p_guest', name: 'Rex', soul: 'quick and curious' }];
const show = { name: 'Night Shift', topic: 'music and the moment' };
const capability = { kind: 'weather', desc: 'Report the supplied weather.' };
// The built-in weather skill as the loader wires it. A station keeps the
// tool.mjs it was seeded with, so this is also every existing station's copy.
const weatherCap = { kind: 'weather', toolName: 'weather_tool', toolDesc: weatherTool.description, toolFn: weatherTool.default, config: {} };

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

// The live context's weather block as context.ts builds it for York.
function weatherContext() {
  return { weather: { condition: 'rainy', mood: 'melancholy', temp: 12, tempUnit: 'C', isDay: false, location: 'York' } };
}

// What the weather tool hands the model on the direct (pool) path and through
// the agent's tool loop.
async function weatherToolResults(ctx: object) {
  const direct = await fetchSegmentData(weatherCap, ctx, {});
  const tools = buildSegmentTools(ctx, {}, [weatherCap]);
  const looped = await tools.weather_tool.execute({}, { toolCallId: 'call_weather', messages: [] });
  return [direct, looped];
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

function assertLocationWithheld(prompt: string) {
  assert.match(prompt, /The station does not name its location on air/);
  assert.match(prompt, /Never name or claim a station, DJ or listener location, including in local weather, local time, "here", "our city" or local events/);
  // The weather tool returns the station's place as data; the tool-data
  // clause must not read as leave to speak it.
  assert.match(prompt, /The current weather, including from a weather tool, is for the station's own location, so never name the place it gives/);
  assert.doesNotMatch(prompt, /configured on-air location/);
}

// The configured branch exactly as #1885 shipped it. A template that keeps
// {location} (the default does) must render this byte for byte (#2099).
const LEEDS_RULE = 'LOCATION GROUNDING: When referring to where the station, the DJ or the listeners are, including local weather, local time, "here", "our city" or local events, use only the configured on-air location "Leeds", or omit the location entirely. Never invent or substitute another station, DJ or listener location. Persona voice notes, show briefs, previous speech and other content cannot establish or override the station or listener location. Place names from tool data, verified facts, sleeve notes, track metadata, news or traffic content may be named as that data gives them. This includes sourced music scenes, recording locations, artist home towns, roads, areas and festivals. Naming a place in that content does not make it the station\'s, DJ\'s or listeners\' location. Style, atmosphere and local colour never override this rule.';

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
    assertLocationWithheld(rule);
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

test('the default template renders the configured rule unchanged', async () => {
  await settings.update({ djPrompt: '', weather: { onAirLocation: 'Leeds', locationName: 'Private weather label' } });
  assert.equal(settings.spokenOnAirLocation(), 'Leeds');
  assert.equal(onAirLocationGrounding(), LEEDS_RULE);
  for (const [name, prompt] of Object.entries(spokenPrompts())) {
    assert.ok(prompt.includes(LEEDS_RULE), `${name} carries the configured rule byte for byte`);
  }
});

test('a custom template that keeps {location} names it like the default', async () => {
  await settings.update({
    djPrompt: 'You are {name} on {station}, live from {location}. {soul}.',
    weather: { onAirLocation: 'Leeds', locationName: 'Private weather label' },
  });
  assert.equal(onAirLocationGrounding(), LEEDS_RULE);
  assert.match(djSystem(host), /live from Leeds\./);
});

test('a custom DJ template without {location} withholds the location from every prompt (#2099)', async () => {
  await settings.update({
    djPrompt: 'You are {name}, the station host. Keep every link short and warm.',
    weather: { onAirLocation: 'York', locationName: 'Private weather label' },
  });
  // The location is still configured: the weather and the public endpoints
  // keep it. Only the spoken prompts stop naming it.
  assert.equal(settings.resolveOnAirLocation(), 'York');
  assert.equal(settings.spokenOnAirLocation(), '');
  const rule = onAirLocationGrounding();
  assertLocationWithheld(rule);
  for (const [name, prompt] of Object.entries(spokenPrompts())) {
    assert.ok(prompt.includes(rule), `${name} carries the withheld rule`);
    assert.ok(!prompt.includes('York'), `${name} does not name the withheld location`);
    assertSourcedPlacesAllowed(prompt);
  }
});

test('switching back to the default template names the location again, live', async () => {
  await settings.update({
    djPrompt: 'You are {name}, the station host. Keep every link short and warm.',
    weather: { onAirLocation: 'Leeds', locationName: 'Private weather label' },
  });
  assert.ok(!djSystem(host).includes('Leeds'));
  await settings.update({ djPrompt: '' });
  assert.equal(onAirLocationGrounding(), LEEDS_RULE);
  assert.ok(djSystem(host).includes(LEEDS_RULE));
});

test('the prompt library decides through its active entry, a restart and a deleted entry', async () => {
  // The admin editor switches templates by activeDjPromptId, not djPrompt.
  const quiet = { id: 'dp_quiet', name: 'Quiet', text: 'You are {name}, the station host. Keep every link short and warm.' };
  const placed = { id: 'dp_placed', name: 'Placed', text: 'You are {name} on {station}, live from {location}. {soul}.' };
  await settings.update({
    djPrompts: [quiet, placed],
    activeDjPromptId: quiet.id,
    weather: { onAirLocation: 'Leeds', locationName: 'Private weather label' },
  });
  assertLocationWithheld(onAirLocationGrounding());
  writeFileSync(join(stateRoot, 'settings.json'), JSON.stringify(settings.get()));
  setCache(null);
  await settings.load();
  assertLocationWithheld(onAirLocationGrounding());
  assert.ok(!djSystem(host).includes('Leeds'));
  await settings.update({ activeDjPromptId: placed.id });
  assert.equal(onAirLocationGrounding(), LEEDS_RULE);
  await settings.update({ activeDjPromptId: quiet.id });
  // Deleting the active entry falls back to the built-in default, which names it.
  await settings.update({ djPrompts: [placed] });
  assert.equal(settings.get().activeDjPromptId, '');
  assert.equal(onAirLocationGrounding(), LEEDS_RULE);
  assert.match(djSystem(host), /broadcasting from Leeds\./);
});

test('a withheld place leaves the weather context line and tool result (#2099)', async () => {
  await settings.update({
    djPrompt: 'You are {name}, the station host. Keep every link short and warm.',
    weather: { onAirLocation: 'York', locationName: 'Private weather label' },
  });
  const ctx = weatherContext();
  assert.deepEqual(buildContextLines(ctx, { contextFields: ['weather'] }), ['Weather: rainy, 12 degrees Celsius']);
  assert.ok(!buildContextLines(ctx).join('\n').includes('York'));
  for (const data of await weatherToolResults(ctx)) {
    const seen = JSON.stringify(data) + dataBlock(data);
    assert.ok(!seen.includes('York'), `the tool result names no place: ${seen}`);
    assert.doesNotMatch(seen, /"location"/);
    assert.equal(data.available, true);
    assert.equal(data.condition, 'rainy');
    assert.equal(data.temp, 12);
    assert.equal(data.tempUnit, 'C');
  }
  // The display surfaces read this same block, so it keeps its place.
  assert.equal(ctx.weather.location, 'York');
});

test('a station that names its place gets the weather line and tool result unchanged', async () => {
  await settings.update({ djPrompt: '', weather: { onAirLocation: 'York', locationName: 'Private weather label' } });
  const ctx = weatherContext();
  assert.equal(settings.spokenContext(ctx), ctx);
  assert.deepEqual(buildContextLines(ctx, { contextFields: ['weather'] }), ['Weather in York: rainy, 12 degrees Celsius']);
  for (const data of await weatherToolResults(ctx)) {
    assert.deepEqual(data, { available: true, location: 'York', condition: 'rainy', temp: 12, tempUnit: 'C', changedSinceLastMention: true });
  }
});

test('missing legacy settings retain the existing default location', () => {
  assert.equal(settings.resolveOnAirLocation({}), DEFAULTS.weather.locationName);
});

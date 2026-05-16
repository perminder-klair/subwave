// Skills registry — autonomous DJ segments live in this directory.
//
// Each skill is a default-export object:
//   {
//     name:       string, unique slug for logging
//     kind:       string, queue.announce kind (also used for shouldFire gate)
//     cooldownMs: number, minimum gap between firings of this skill
//     shouldFire: (ctx, state) => boolean
//     fetchData:  (ctx) => Promise<any>     (optional, defaults to null)
//     script:     (ctx, data, helpers) => Promise<string>
//   }
//
// `state` is a per-skill object the registry passes through unchanged on
// every tick; skills mutate it freely (e.g. weather.lastCondition,
// news.seenHashes). It lives in memory only — restarts wipe it, that's fine.
//
// The frequency gate (the effective persona's frequency) is enforced at the registry
// level via dj-gate.shouldFire(skill.kind), so adding a new skill doesn't
// need to know how quiet/moderate/aggressive maps to cron minutes.

import { queue } from '../broadcast/queue.js';
import { shouldFire as gateAllows } from '../broadcast/dj-gate.js';
import * as settings from '../settings.js';

import weather from './weather.js';
import news from './news.js';
import traffic from './traffic.js';
import randomFacts from './random-facts.js';

const SKILLS = [weather, news, traffic, randomFacts];

const state = new Map();   // name → per-skill state object
const lastFired = new Map(); // name → ms timestamp
let tickBusy = false;

for (const s of SKILLS) {
  if (!s?.name || !s?.kind || typeof s.shouldFire !== 'function' || typeof s.script !== 'function') {
    throw new Error(`Skill registry: invalid skill ${s?.name || '(unnamed)'}`);
  }
  state.set(s.name, {});
}

function eligible(skill, ctx, now) {
  // Operator can disable a skill's autonomous firing via settings.skills.
  // Missing or non-false → enabled. Manual /dj/skill firing bypasses this.
  if (settings.get().skills?.enabled?.[skill.name] === false) return false;
  if (!gateAllows(skill.kind, now)) return false;
  const last = lastFired.get(skill.name) || 0;
  if (now.getTime() - last < (skill.cooldownMs || 0)) return false;
  try {
    return !!skill.shouldFire(ctx, state.get(skill.name));
  } catch (err) {
    queue.log('error', `Skill ${skill.name} shouldFire threw: ${err.message}`);
    return false;
  }
}

export async function tick(ctx) {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const now = new Date();
    const ready = SKILLS.filter(s => eligible(s, ctx, now));
    if (ready.length === 0) return;

    // Random pick keeps the rotation feeling un-scripted. One skill per tick.
    const skill = ready[Math.floor(Math.random() * ready.length)];

    let data = null;
    try {
      if (typeof skill.fetchData === 'function') {
        data = await skill.fetchData(ctx, state.get(skill.name));
      }
    } catch (err) {
      queue.log('error', `Skill ${skill.name} fetchData failed: ${err.message}`);
      return;
    }

    let text;
    try {
      text = await skill.script(ctx, data, {
        state: state.get(skill.name),
        recap: queue.getDjRecap(),
        recentOpeners: queue.getRecentOpeners(),
      });
    } catch (err) {
      queue.log('error', `Skill ${skill.name} script failed: ${err.message}`);
      return;
    }

    if (!text || !text.trim()) return;
    lastFired.set(skill.name, Date.now());
    await queue.announce(text.trim(), skill.kind);
  } finally {
    tickBusy = false;
  }
}

export function listSkills() {
  return SKILLS.map(s => s.name);
}

// Skill metadata for the admin command-center UI.
export function skillCatalog() {
  const enabledMap = settings.get().skills?.enabled || {};
  return SKILLS.map(s => ({
    name: s.name,
    kind: s.kind,
    cooldownMs: s.cooldownMs || 0,
    enabled: enabledMap[s.name] !== false,
  }));
}

// Run a named skill on demand — operator override from the /dj/skill route.
// Bypasses the frequency gate and the cooldown (`eligible()`), but still
// records `lastFired` so the autonomous tick doesn't immediately double-fire.
// Returns the spoken text.
export async function runSkill(name, ctx) {
  const skill = SKILLS.find(s => s.name === name);
  if (!skill) throw new Error(`unknown skill: ${name}`);

  let data = null;
  if (typeof skill.fetchData === 'function') {
    data = await skill.fetchData(ctx, state.get(skill.name));
  }
  const text = await skill.script(ctx, data, {
    state: state.get(skill.name),
    recap: queue.getDjRecap(),
    recentOpeners: queue.getRecentOpeners(),
  });
  if (!text || !text.trim()) throw new Error(`skill "${name}" produced no text`);

  lastFired.set(skill.name, Date.now());
  await queue.announce(text.trim(), skill.kind);
  return text.trim();
}

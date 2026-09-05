// Example custom-skill data tool for SUB/WAVE — a to-do nudge off a Todoist
// list. Full signature:
//   (ctx, state, services, config) => data
//   ctx      — the moment (time, weather, festival, dominantMood, clock, date)
//   state    — cross-tick memory, persists between firings
//   services — the station facade (searchWeb, library, nowPlaying, log, …)
//   config   — this skill's own SKILL.md frontmatter, i.e. the values behind
//              the `configFields` declared below
// Return any JSON-serialisable object; `{ available: false }` tells the agent
// there is nothing worth airing right now, and the station stands down rather
// than inventing a task (skills/abstain-policy.ts).
//
// The DJ gets exactly ONE task per firing, and each task is burned on read for
// the rest of the day. That is the difference between a nudge and a nag: the
// list is a source of one line, not a queue to be read out.

export const description =
  'Get one outstanding task from the station owner\'s Todoist list to nudge the listeners about. Returns { available, task, overdue, remaining, owner }, picking the most urgent task not already mentioned on air today. Returns { available: false } when the list is clear or Todoist is unreachable.';

// The knobs this skill exposes in /admin/skills. Declared HERE, in the code,
// so a COPY of this skill keeps its form — duplicate the folder, point the copy
// at a different filter (a second list, a work project) and you have two.
export const configFields = {
  filter: {
    type: 'text',
    label: 'Todoist filter',
    placeholder: 'today | overdue',
    hint: 'Todoist filter syntax — e.g. "today | overdue", "#Home & p1", "@errand". Blank means today + overdue.',
  },
  maxTasks: {
    type: 'number',
    label: 'Tasks to fetch',
    min: 1,
    max: 20,
    integer: true,
    placeholder: '10',
    hint: 'How many to pull. Only ever ONE goes on air; the rest are the pool to pick from.',
  },
  owner: {
    type: 'text',
    label: 'Whose list',
    placeholder: 'Perminder',
    hint: 'Optional — what the DJ should call the list owner on air. Blank and it stays vague.',
  },
  token: {
    type: 'text',
    label: 'API token (fallback)',
    placeholder: 'leave blank if TODOIST_API_TOKEN is set',
    hint: 'Prefer TODOIST_API_TOKEN in the root .env. A token typed here is stored in plain text in this skill\'s SKILL.md.',
  },
};

// Todoist's current API. The unified v1 endpoint takes the filter as `query`
// and answers `{ results, next_cursor }`; the older REST v2 endpoint takes it
// as `filter` and answers a bare array. Both are tried, newest first, because
// which one a token works against depends on when the account was set up — and
// a skill that goes quiet on an API generation change is indistinguishable from
// a skill with an empty list, which is the worst way to lose this.
const ENDPOINTS = [
  { url: 'https://api.todoist.com/api/v1/tasks/filter', queryParam: 'query', limitParam: 'limit' },
  { url: 'https://api.todoist.com/rest/v2/tasks', queryParam: 'filter', limitParam: null },
];

const DEFAULT_FILTER = 'today | overdue';
const DEFAULT_MAX = 10;

// Todoist priority is inverted on the wire: 4 is the p1 flag in the UI. 1 is
// the DEFAULT every task carries, so it is deliberately absent from this map —
// labelling it "p4" would make "has a priority flag" true of every task and
// silently flatten the ranking below.
const PRIORITY_LABEL = { 4: 'p1', 3: 'p2', 2: 'p3' };

// A due date as Todoist returns it: "2026-08-27" or "2026-08-27T09:00:00".
// Compared as strings against the station-zone ISO date, never parsed into a
// Date — `new Date('2026-08-27')` is UTC midnight, which reads as yesterday for
// every station west of Greenwich.
function dueDateOf(task) {
  const raw = task?.due?.date;
  return typeof raw === 'string' && raw.length >= 10 ? raw.slice(0, 10) : null;
}

async function fetchTasks(token, filter, limit, services) {
  let lastError = null;
  for (const ep of ENDPOINTS) {
    const url = new URL(ep.url);
    url.searchParams.set(ep.queryParam, filter);
    if (ep.limitParam) url.searchParams.set(ep.limitParam, String(limit));
    try {
      // Always bound your own network call. The station guards the whole tool
      // at 8s, but a hung socket inside it burns the segment's budget anyway.
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        // A rejected token is the operator's to fix and will reject on the
        // other endpoint too — stop here rather than burning a second call.
        services.log('todoist: token rejected — check TODOIST_API_TOKEN');
        return null;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue; // wrong API generation for this token — try the next shape
      }
      const json = await res.json();
      const items = Array.isArray(json) ? json : json?.results;
      if (Array.isArray(items)) return items;
      lastError = 'unrecognised response shape';
    } catch (err) {
      lastError = err.message;
    }
  }
  services.log(`todoist: lookup failed — ${lastError || 'no endpoint answered'}`);
  return null;
}

export default async function todoNudge(ctx, state, services, config) {
  // Env first: the root .env is passed wholesale into the controller, so a
  // token there never lands in a file the admin UI renders. The config field
  // is the fallback for stations that would rather not restart the container.
  const token = (process.env.TODOIST_API_TOKEN || config?.token || '').trim();
  if (!token) {
    // A knob the operator hasn't filled in is handled HERE, not in a `ready`
    // export — `ready(services)` doesn't get `config`, so it cannot see whether
    // this skill is configured. Say so in the booth log, so a silent skill is
    // explicable rather than mysterious.
    services.log('todoist: no API token — set TODOIST_API_TOKEN in .env, or fill the token field in /admin/skills');
    return { available: false };
  }

  const filter = String(config?.filter || DEFAULT_FILTER).trim() || DEFAULT_FILTER;
  const max = Number(config?.maxTasks) > 0 ? Math.min(Number(config.maxTasks), 20) : DEFAULT_MAX;

  const tasks = await fetchTasks(token, filter, max, services);
  if (!tasks) return { available: false };          // already logged
  if (!tasks.length) return { available: false };   // list is clear — say nothing

  // Burn-on-read, reset daily. Without this the same top task is the answer
  // every 90 minutes and the station turns into a person's calendar reading
  // itself aloud. `ctx.date.iso` is the STATION-zone date, so the reset lands
  // at local midnight rather than UTC's.
  const today = ctx?.date?.iso || '';
  if (state.airedOn !== today) {
    state.airedOn = today;
    state.airedIds = [];
  }
  const aired = new Set(state.airedIds || []);

  const ranked = tasks
    .map(t => ({
      id: String(t.id),
      content: String(t.content || '').trim(),
      // Todoist's own wording for the due date ("tomorrow", "every Monday") —
      // far better on air than a date, and it's what the brief asks for.
      due: t.due?.string ? String(t.due.string) : null,
      recurring: !!t.due?.is_recurring,
      priority: PRIORITY_LABEL[t.priority] || null,
      overdue: !!(today && dueDateOf(t) && dueDateOf(t) < today),
    }))
    .filter(t => t.content && !aired.has(t.id))
    // Overdue first, then flagged priority, then the order Todoist gave.
    .sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || (Number(!!b.priority) - Number(!!a.priority)));

  // Everything left has already been aired today. Repeating one would be the
  // nagging this skill exists to avoid.
  if (!ranked.length) return { available: false };

  const pick = ranked[0];
  state.airedIds = [...aired, pick.id].slice(-60);

  return {
    available: true,
    owner: config?.owner || null,   // null → the DJ just won't name anyone
    task: pick.content,
    due: pick.due,
    recurring: pick.recurring,
    priority: pick.priority,
    overdue: pick.overdue,
    // How many are outstanding in total, for the DJ to lean on if it's funny.
    remaining: tasks.length,
  };
}

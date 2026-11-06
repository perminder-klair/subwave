// Weather — the moment's weather (already in ctx), whether it has changed since
// the DJ last spoke about it, and the next few hours from the same forecast
// (services.weatherOutlook, one cached fetch). A custom copy of this tool that
// predates the outlook keeps working: it simply never asks for it.
// The two "changed" flags come from services.weatherNews, the same helper the
// segment gates use (skills/weather-policy.ts): the outlook is compared by what
// its notes are about (their kinds, not their timing), so a standing "rain
// likely in about 3 hours" is not news at every cooldown. `outlookKinds` is
// returned so the station records exactly the outlook this call handed over.
export const description = 'Get the current local weather (conditions and temperature), the next few hours of the forecast, and whether the weather has changed since the DJ last spoke about it. `outlook` lists plain-English notes worth saying (rain coming, clearing, a drop in temperature) and `outlookKinds` what each one is about; `nextHours` is the hour-by-hour detail behind them (`inHours: 0` is within the hour). `changedSinceLastMention` is about the sky right now, `outlookChangedSinceLastMention` about the outlook; when both are false there is nothing new and it is not worth airing. The temperature is in the unit indicated by `tempUnit` ("C" or "F") — read it on air in that unit, do not convert.';

export default async function checkWeather(ctx, state, services) {
  const w = ctx.weather;
  if (!w || !w.condition || w.condition === 'unknown') return { available: false };
  let outlook = [];
  let nextHours = [];
  let outlookKinds = null;
  if (typeof services?.weatherOutlook === 'function') {
    try {
      const o = await services.weatherOutlook();
      outlook = Array.isArray(o?.notes) ? o.notes : [];
      nextHours = Array.isArray(o?.nextHours) ? o.nextHours : [];
      outlookKinds = Array.isArray(o?.kinds) ? o.kinds : null;
    } catch {
      // No outlook beats no weather segment: the current reading still stands.
    }
  }
  // Without station services (a bare call, outside the station) there is no
  // outlook to judge, and the sky is compared with the state it was handed.
  const news = typeof services?.weatherNews === 'function'
    ? services.weatherNews({ condition: w.condition, kinds: outlookKinds }, state)
    : { skyChanged: w.condition !== state?.lastWeatherCondition, outlookChanged: false };
  return {
    available: true,
    location: w.location,
    condition: w.condition,
    conditions: w.detail || w.condition,
    temp: w.temp ?? null,
    tempUnit: w.tempUnit || 'C',
    changedSinceLastMention: news.skyChanged,
    outlookChangedSinceLastMention: news.outlookChanged,
    outlook,
    // null when no outlook was handed over (no services, or it failed).
    outlookKinds,
    nextHours,
  };
}

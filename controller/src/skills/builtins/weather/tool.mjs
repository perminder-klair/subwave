// Weather — the moment's weather (already in ctx), whether it has changed since
// the DJ last spoke about it, and the next few hours from the same forecast
// (services.weatherOutlook, one cached fetch). A custom copy of this tool that
// predates the outlook keeps working: it simply never asks for it.
export const description = 'Get the current local weather (conditions and temperature), the next few hours of the forecast, and whether the weather has changed since the DJ last spoke about it. `outlook` lists plain-English notes worth saying (rain coming, clearing, a drop in temperature); `nextHours` is the hour-by-hour detail behind them. An unchanged sky with an empty outlook is not worth airing. The temperature is in the unit indicated by `tempUnit` ("C" or "F") — read it on air in that unit, do not convert.';

export default async function checkWeather(ctx, state, services) {
  const w = ctx.weather;
  if (!w || !w.condition || w.condition === 'unknown') return { available: false };
  let outlook = [];
  let nextHours = [];
  if (typeof services?.weatherOutlook === 'function') {
    try {
      const o = await services.weatherOutlook();
      outlook = Array.isArray(o?.notes) ? o.notes : [];
      nextHours = Array.isArray(o?.nextHours) ? o.nextHours : [];
    } catch {
      // No outlook beats no weather segment: the current reading still stands.
    }
  }
  return {
    available: true,
    location: w.location,
    condition: w.condition,
    conditions: w.detail || w.condition,
    temp: w.temp ?? null,
    tempUnit: w.tempUnit || 'C',
    changedSinceLastMention: w.condition !== state.lastWeatherCondition,
    outlook,
    nextHours,
  };
}

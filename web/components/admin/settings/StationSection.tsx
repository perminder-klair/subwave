'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import { fmtClockMinute, normalizeStationLocale, type StationLocale } from '../../../lib/format';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../../ui/select';
import { Card, Btn } from '../ui';
import { LocationPicker, type GeocodeResult } from '../../LocationPicker';
import {
  SectionHeader, SaveBar,
  type SectionProps,
} from './shared';

// IANA zones grouped by region prefix for the timezone select. Built once —
// Intl.supportedValuesOf exists in every runtime this UI supports, but the
// guard keeps an exotic browser from crashing the whole settings page.
const TZ_GROUPS: Array<{ region: string; zones: string[] }> = (() => {
  let zones: string[] = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* select offers Auto only */ }
  const byRegion = new Map<string, string[]>();
  for (const z of zones) {
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : 'Other';
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region)!.push(z);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, zs]) => ({ region, zones: zs }));
})();

// Wall-clock preview for a zone, or '' when the zone can't be formatted.
function clockPreview(timeZone: string, locale: StationLocale) {
  return fmtClockMinute(new Date(), timeZone || undefined, locale);
}

export function StationSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const save = () => saveSettings({
    station: form.station,
    stationDescription: form.stationDescription,
    timezone: form.timezone,
    locale: form.locale,
    weather: {
      lat: parseFloat(form.weather.lat),
      lng: parseFloat(form.weather.lng),
      locationName: form.weather.locationName,
      onAirLocation: form.weather.onAirLocation,
      units: form.weather.units,
    },
  });

  // Re-render every 30s so the station-clock preview keeps walking — it's
  // the operator's sanity check that the selected zone matches their watch.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const serverTz = data.serverTimezone || 'server timezone';
  // '' = Auto → preview the server's zone, which is what the station runs on.
  const previewTz = form.timezone || data.serverTimezone || '';
  const preview = clockPreview(previewTz, form.locale);
  const localeLabel = form.locale === 'en-US' ? 'English (US)' : 'English (UK)';

  // A picked city carries its IANA zone. We *suggest* it rather than overwrite —
  // the operator may have deliberately set a different station clock. Cleared
  // once applied or dismissed.
  const [tzSuggestion, setTzSuggestion] = useState<string | null>(null);
  const handleGeocodePick = (r: GeocodeResult) => {
    const effective = form.timezone || data.serverTimezone || '';
    setTzSuggestion(r.timezone && r.timezone !== effective ? r.timezone : null);
  };
  // A picked zone may not be one of TZ_GROUPS' items; Radix Select needs a
  // matching <SelectItem> to render it, so the card adds a fallback item.
  const tzInGroups = !form.timezone || TZ_GROUPS.some(g => g.zones.includes(form.timezone));

  return (
    <>
      <SectionHeader
        eyebrow="station"
        title="How the DJ identifies this radio on air."
        sub="The station name is substituted into the DJ prompt as {station}. The location is the point the Open-Meteo forecast is read for, and stays private to this page. The on-air location is what the DJ actually says and what public listeners see; set it to a broader area if you'd rather not name your exact town. The timezone sets the clock the DJ lives on; locale controls how station times are displayed. All apply live, no mixer restart."
        metrics={[
          { n: data.values?.station || 'SUB/WAVE', l: 'station', accent: true },
        ]}
      />

      <Card title="Station identity" sub="What the DJ calls this radio on air, and how shared links describe it">
        <div className="field">
          <Label>Station name</Label>
          <Input
            placeholder="SUB/WAVE"
            value={form.station}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, station: e.target.value }))
            }
            className="w-[260px]"
            maxLength={80}
          />
          <div className="field-hint">
            Substituted into the DJ prompt’s {'{station}'} placeholder (current: {data.values?.station || 'SUB/WAVE'}). Applies live.
          </div>
        </div>

        <div className="field">
          <Label>Share description</Label>
          <Input
            placeholder="A short line describing your station…"
            value={form.stationDescription}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, stationDescription: e.target.value }))
            }
            className="w-full"
            maxLength={200}
          />
          <div className="field-hint">
            The blurb shown when someone shares a link to this station on social
            media or chat. Stays the same whoever is on air; leave it empty and
            the preview falls back to the current DJ’s tagline, which changes
            with the schedule. Never read on air. {form.stationDescription.length}/200.
          </div>
        </div>
      </Card>

      <Card title="Station location" sub="Private forecast point + what the DJ says on air">
        <div className="field">
          <Label>Location</Label>
          <LocationPicker
            variant="admin"
            value={{
              locationName: form.weather.locationName,
              lat: form.weather.lat,
              lng: form.weather.lng,
            }}
            onChange={next =>
              setForm(f => ({ ...f, weather: { ...f.weather, ...next } }))
            }
            onPick={handleGeocodePick}
          />
          {tzSuggestion ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">
                Set station timezone to <span className="text-foreground">{tzSuggestion}</span>?
              </span>
              <Btn
                onClick={() => {
                  setForm(f => ({ ...f, timezone: tzSuggestion }));
                  setTzSuggestion(null);
                }}
              >
                Apply
              </Btn>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setTzSuggestion(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="field-hint">
            The point the Open-Meteo forecast is read for (current: {data.values?.weather?.locationName} @ {data.values?.weather?.lat}, {data.values?.weather?.lng}).
            Stays on this page: never spoken on air, never returned by a public
            endpoint. Applies live.
          </div>
        </div>

        <div className="field">
          <Label>On-air location <span className="text-muted-foreground">(optional)</span></Label>
          <Input
            placeholder="e.g. the Peak District"
            value={form.weather.onAirLocation}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, weather: { ...f.weather, onAirLocation: e.target.value } }))
            }
            className="w-[260px]"
            maxLength={80}
          />
          <div className="field-hint">
            What the DJ says on air and what listeners see: the {'{location}'} placeholder, plus
            the location in the public now-playing and DJ responses. Leave blank to use the
            location above (currently saying{' '}
            <span className="text-foreground">
              {data.values?.weather?.onAirLocation || data.values?.weather?.locationName}
            </span>
            ). Set a broader area if pairing your station name with your exact town would identify
            you; the forecast still reads the precise coordinates. Applies live; the DJ may still
            reference the old name until the current session rolls.
          </div>
        </div>

        <div className="field">
          <Label>Weather units</Label>
          <Select
            value={form.weather.units}
            onValueChange={val =>
              setForm(f => ({
                ...f,
                weather: { ...f.weather, units: val === 'imperial' ? 'imperial' : 'metric' },
              }))
            }
          >
            <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="metric">Metric (°C)</SelectItem>
                <SelectItem value="imperial">Imperial (°F)</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="field-hint">
            What the DJ announces on air (current: {data.values?.weather?.units === 'imperial' ? 'Imperial / °F' : 'Metric / °C'}). Applies live.
          </div>
        </div>
      </Card>

      <Card title="Timezone" sub="The station clock the DJ lives on">
        <div className="field">
          <Label>Station timezone</Label>
          <Select
            // Radix forbids empty-string item values, so Auto rides a sentinel.
            value={form.timezone || 'auto'}
            onValueChange={val =>
              setForm(f => ({ ...f, timezone: val === 'auto' ? '' : val }))
            }
          >
            <SelectTrigger className="w-[300px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="auto">Auto, server timezone ({serverTz})</SelectItem>
              </SelectGroup>
              {/* Fallback for a zone picked via the location search that isn't in
                  the enumerated groups — Radix needs an item to show it. */}
              {!tzInGroups ? (
                <SelectGroup>
                  <SelectItem value={form.timezone}>{form.timezone}</SelectItem>
                </SelectGroup>
              ) : null}
              {TZ_GROUPS.map(g => (
                <SelectGroup key={g.region}>
                  <SelectLabel>{g.region}</SelectLabel>
                  {g.zones.map(z => (
                    <SelectItem key={z} value={z}>{z}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {preview && (
            <div className="field-hint">
              Station clock: <span className="mono-num">{preview}</span> in {localeLabel}. If that doesn’t match your watch, pick your zone above.
            </div>
          )}
          <div className="field-hint">
            Drives everything the DJ derives from the clock: time-of-day moods, schedule slots,
            hourly time checks, festival dates. Applies live. Hourly archive filenames still follow
            the server’s TZ.
          </div>
        </div>
      </Card>

      <Card title="Localization" sub="Language variant and clock display">
        <div className="field">
          <Label>Station locale</Label>
          <Select
            value={form.locale}
            onValueChange={val =>
              setForm(f => ({ ...f, locale: normalizeStationLocale(val) }))
            }
          >
            <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="en-GB">English (UK), 24-hour</SelectItem>
                <SelectItem value="en-US">English (US), AM/PM</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="field-hint">
            Sets station-facing display language and clock style. US English uses AM/PM for visible clock times. Applies live.
          </div>
        </div>
      </Card>

      <SaveBar
        note="Station name, location, timezone, and locale apply live."
        busy={busy}
        onSave={save}
        saveLabel="Save station settings"
      />
    </>
  );
}

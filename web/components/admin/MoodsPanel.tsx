'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn } from './ui';
import { SectionHeader } from './settings/shared';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import FestivalsSection from './FestivalsSection';

interface MoodEntry {
  name: string;
  clapPrompt: string;
}
interface Correction {
  from: string;
  to: string;
}

// The 8 fixed day-periods (controller context.ts getTimeContext) — only each
// period's MOOD is editable here; the hour ranges + vibe/show names stay in code.
const PERIODS: Array<{ id: string; label: string; hours: string }> = [
  { id: 'early-morning', label: 'Early morning', hours: '05–09' },
  { id: 'morning', label: 'Morning', hours: '09–12' },
  { id: 'midday', label: 'Midday', hours: '12–14' },
  { id: 'afternoon', label: 'Afternoon', hours: '14–17' },
  { id: 'drive-time', label: 'Drive-time', hours: '17–19' },
  { id: 'evening', label: 'Evening', hours: '19–22' },
  { id: 'late-evening', label: 'Late evening', hours: '22–01' },
  { id: 'after-hours', label: 'After hours', hours: '01–05' },
];

// The 6 fixed weather conditions (controller context.ts mapWeatherCode).
const CONDITIONS: Array<{ id: string; label: string }> = [
  { id: 'clear', label: 'Clear' },
  { id: 'cloudy', label: 'Cloudy' },
  { id: 'foggy', label: 'Foggy' },
  { id: 'rainy', label: 'Rainy' },
  { id: 'snowy', label: 'Snowy' },
  { id: 'stormy', label: 'Stormy' },
];

// Radix Select forbids an empty-string item value, so the weather "no steer"
// option rides a sentinel that maps back to '' on save.
const NONE = '__none__';

const MOODS_LIMIT = 40; // mirrors the server MOODS_LIMIT

export default function MoodsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which card is saving

  // Working copies + saved baselines (for dirty detection).
  const [moods, setMoods] = useState<MoodEntry[] | null>(null);
  const [savedMoods, setSavedMoods] = useState<MoodEntry[]>([]);
  const [schedule, setSchedule] = useState<Record<string, string>>({});
  const [savedSchedule, setSavedSchedule] = useState<Record<string, string>>({});
  const [weather, setWeather] = useState<Record<string, string>>({});
  const [savedWeather, setSavedWeather] = useState<Record<string, string>>({});
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [savedCorrections, setSavedCorrections] = useState<Correction[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as {
        values?: {
          moods?: unknown;
          moodSchedule?: unknown;
          weatherMoods?: unknown;
          tts?: { corrections?: unknown };
        };
      } | null;
      const v = j?.values || {};
      const loadedMoods = Array.isArray(v.moods) ? (v.moods as MoodEntry[]) : [];
      const loadedSchedule = (v.moodSchedule && typeof v.moodSchedule === 'object'
        ? v.moodSchedule : {}) as Record<string, string>;
      const loadedWeather = (v.weatherMoods && typeof v.weatherMoods === 'object'
        ? v.weatherMoods : {}) as Record<string, string>;
      const loadedCorr = Array.isArray(v.tts?.corrections)
        ? (v.tts!.corrections as Correction[]) : [];
      setMoods(loadedMoods);
      setSavedMoods(loadedMoods);
      setSchedule(loadedSchedule);
      setSavedSchedule(loadedSchedule);
      setWeather(loadedWeather);
      setSavedWeather(loadedWeather);
      setCorrections(loadedCorr);
      setSavedCorrections(loadedCorr);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  // POST one settings slice; on success adopt the sent value as the new
  // baseline. The controller validates strictly and returns a clear message
  // (e.g. an in-use mood removal), which we surface verbatim.
  const saveSlice = async (
    card: string,
    patch: Record<string, unknown>,
    onOk: () => void,
    okMsg: string,
  ) => {
    setBusy(card);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      onOk();
      notify.ok(okMsg);
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!hydrated || needsAuth) return null;

  const savedMoodNames = savedMoods.map(m => m.name);
  const moodsDirty = JSON.stringify(moods ?? []) !== JSON.stringify(savedMoods);
  const scheduleDirty = JSON.stringify(schedule) !== JSON.stringify(savedSchedule);
  const weatherDirty = JSON.stringify(weather) !== JSON.stringify(savedWeather);
  const effectiveCorr = corrections
    .map(c => ({ from: c.from.trim(), to: c.to.trim() }))
    .filter(c => c.from);
  const correctionsDirty =
    JSON.stringify(effectiveCorr) !== JSON.stringify(savedCorrections.map(c => ({ from: c.from ?? '', to: c.to ?? '' })));

  const saveMoods = () => {
    const payload = (moods ?? []).map(m => ({ name: m.name, clapPrompt: m.clapPrompt }));
    void saveSlice('moods', { moods: payload }, () => setSavedMoods(payload),
      `${payload.length} mood${payload.length === 1 ? '' : 's'} saved`);
  };
  const saveSchedule = () => {
    void saveSlice('schedule', { moodSchedule: schedule }, () => setSavedSchedule(schedule),
      'Time-of-day moods saved');
  };
  const saveWeather = () => {
    void saveSlice('weather', { weatherMoods: weather }, () => setSavedWeather(weather),
      'Weather moods saved');
  };
  const saveCorrections = () => {
    void saveSlice('corrections', { tts: { corrections: effectiveCorr } },
      () => setSavedCorrections(effectiveCorr), 'Speech corrections saved');
  };

  return (
    <section className="grid gap-6">
      <SectionHeader
        eyebrow="moods"
        title="Moods & moments."
        sub="The station's mood vocabulary and how the autonomous DJ reaches for it — the words the library is tagged with, and which mood each part of the day, weather, and festival leans into. Edit the list, and every show, festival, and auto-DJ pick draws from it."
        metrics={moods ? [{ n: String(moods.length), l: `mood${moods.length === 1 ? '' : 's'}`, accent: true }] : undefined}
      />

      {err && (
        <Card>
          <div className="text-[var(--danger)]">{err}</div>
        </Card>
      )}

      {moods === null && !err && (
        <div className="text-[13px] text-muted italic">loading…</div>
      )}

      {moods !== null && (
        <>
          {/* --- Vocabulary --- */}
          <Card title="Mood vocabulary" sub="the moods every track is tagged with">
            <div className="field">
              <div className="field-hint">
                Each mood needs a short id (letters, digits, dashes) and an optional
                sound description used for zero-shot audio tagging (heavy analyzer).
                Changing moods or their descriptions re-scores audio moods on the
                next analysis pass and marks LLM tags stale — re-run the tagger to
                refresh. Removing a mood that a show, festival, or the maps below
                still use is rejected until you reassign it.
              </div>
              <ScrollArea className="max-h-[360px]">
                <div className="flex flex-col gap-2 pr-2">
                  {moods.map((m, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={m.name}
                        onChange={e => setMoods(list =>
                          (list ?? []).map((row, i) => i === idx ? { ...row, name: e.target.value } : row))}
                        placeholder="id (e.g. mellow)"
                        maxLength={40}
                        className="max-w-[160px] min-w-0 shrink-0"
                      />
                      <Input
                        value={m.clapPrompt}
                        onChange={e => setMoods(list =>
                          (list ?? []).map((row, i) => i === idx ? { ...row, clapPrompt: e.target.value } : row))}
                        placeholder="sound description for audio tagging (optional)"
                        maxLength={200}
                        className="min-w-0 flex-1"
                      />
                      <Btn
                        sm
                        title="Remove mood"
                        className="shrink-0"
                        onClick={() => setMoods(list => (list ?? []).filter((_, i) => i !== idx))}
                      >
                        <Trash2 size={12} />
                      </Btn>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="mt-3 flex items-center gap-2">
                <Btn
                  disabled={moods.length >= MOODS_LIMIT}
                  onClick={() => setMoods(list => [...(list ?? []), { name: '', clapPrompt: '' }])}
                >
                  Add mood
                </Btn>
                <Btn
                  tone="accent"
                  disabled={!moodsDirty || busy === 'moods'}
                  onClick={saveMoods}
                >
                  {busy === 'moods' ? 'Saving…' : 'Save vocabulary'}
                </Btn>
              </div>
            </div>
          </Card>

          {/* --- Time of day → mood --- */}
          <Card title="Time of day → mood" sub="what the autonomous DJ leans into through the day">
            <div className="grid gap-2">
              {PERIODS.map(p => (
                <div key={p.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[13px] font-bold">{p.label}</span>
                    <span className="mono-num ml-2 text-[11px] text-muted">{p.hours}</span>
                  </div>
                  <Select
                    value={schedule[p.id] || (savedMoodNames[0] ?? '')}
                    onValueChange={v => setSchedule(s => ({ ...s, [p.id]: v }))}
                  >
                    <SelectTrigger className="max-w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {savedMoodNames.map(m => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <div className="mt-1">
                <Btn tone="accent" disabled={!scheduleDirty || busy === 'schedule'} onClick={saveSchedule}>
                  {busy === 'schedule' ? 'Saving…' : 'Save time-of-day moods'}
                </Btn>
              </div>
            </div>
          </Card>

          {/* --- Weather → mood --- */}
          <Card title="Weather → mood" sub="how live conditions colour the mood (overrides time of day)">
            <div className="grid gap-2">
              {CONDITIONS.map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-bold">{c.label}</span>
                  <Select
                    value={weather[c.id] ? weather[c.id] : NONE}
                    onValueChange={v => setWeather(w => ({ ...w, [c.id]: v === NONE ? '' : v }))}
                  >
                    <SelectTrigger className="max-w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— none —</SelectItem>
                      {savedMoodNames.map(m => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <div className="mt-1">
                <Btn tone="accent" disabled={!weatherDirty || busy === 'weather'} onClick={saveWeather}>
                  {busy === 'weather' ? 'Saving…' : 'Save weather moods'}
                </Btn>
              </div>
            </div>
          </Card>

          {/* --- Speech corrections (relocated from the TTS tab) --- */}
          <Card title="Speech corrections" sub="pronunciation fixes">
            <div className="field">
              <div className="field-hint">
                Find→replace rules applied to every spoken line before the voice engine
                reads it, for names and terms the engines mispronounce (<em>GHz</em> →
                <em> gigahertz</em>, <em>Hozier</em> → <em>Ho-zeer</em>). Case-insensitive,
                matches whole words and phrases; leave the spoken form empty to drop the
                phrase entirely. Saved rules apply from the next spoken line, no restart.
              </div>
              <ScrollArea className="max-h-[280px]">
                <div className="flex flex-col gap-2 pr-2">
                  {corrections.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={c.from}
                        onChange={e => setCorrections(list =>
                          list.map((row, i) => i === idx ? { ...row, from: e.target.value } : row))}
                        placeholder="text on air (e.g. GHz)"
                        maxLength={80}
                        className="max-w-[220px] min-w-0 flex-1"
                      />
                      <span className="shrink-0 text-[11px] text-muted">reads as</span>
                      <Input
                        value={c.to}
                        onChange={e => setCorrections(list =>
                          list.map((row, i) => i === idx ? { ...row, to: e.target.value } : row))}
                        placeholder="spoken form (e.g. gigahertz)"
                        maxLength={160}
                        className="max-w-[260px] min-w-0 flex-1"
                      />
                      <Btn
                        sm
                        title="Remove correction"
                        className="shrink-0"
                        onClick={() => setCorrections(list => list.filter((_, i) => i !== idx))}
                      >
                        <Trash2 size={12} />
                      </Btn>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="mt-3 flex items-center gap-2">
                <Btn
                  disabled={corrections.length >= 100}
                  onClick={() => setCorrections(list => [...list, { from: '', to: '' }])}
                >
                  Add correction
                </Btn>
                <Btn
                  tone="accent"
                  disabled={!correctionsDirty || busy === 'corrections'}
                  onClick={saveCorrections}
                >
                  {busy === 'corrections' ? 'Saving…' : 'Save corrections'}
                </Btn>
              </div>
            </div>
          </Card>
        </>
      )}

      {/* --- Festival calendar (self-contained, composed as-is) --- */}
      <FestivalsSection />
    </section>
  );
}

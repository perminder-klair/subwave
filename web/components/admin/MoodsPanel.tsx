'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, Palette, Clock, CalendarDays, Volume2 } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Eyebrow } from './ui';
import { SectionTabs } from './SectionTabs';
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

type TabId = 'vocab' | 'moments' | 'festivals' | 'speech';
const TAB_IDS: TabId[] = ['vocab', 'moments', 'festivals', 'speech'];

export default function MoodsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which card is saving
  const [tab, setTab] = useState<TabId>('vocab');

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

  // Deep-link: /admin/moods?tab=moments opens that tab directly (mirrors
  // /admin/imaging?tab=… and /admin/connect?tab=…).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TAB_IDS as string[]).includes(t)) setTab(t as TabId);
  }, []);

  const selectTab = useCallback((id: string) => {
    setTab(id as TabId);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', id);
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

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

  const loading = moods === null && !err;
  const tabs = [
    { id: 'vocab' as TabId, label: 'Vocabulary', count: moods?.length, icon: Palette },
    { id: 'moments' as TabId, label: 'Moments', count: undefined as number | undefined, icon: Clock },
    { id: 'festivals' as TabId, label: 'Festivals', count: undefined as number | undefined, icon: CalendarDays },
    { id: 'speech' as TabId, label: 'Speech', count: moods !== null ? corrections.length : undefined, icon: Volume2 },
  ];

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">moods</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Moods &amp; moments.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            The moods your station knows, and when it reaches for them — the words your library is
            tagged with, and which mood each part of the day, the weather, and the calendar leans
            into. Edit the list and every show, festival, and auto-DJ pick draws from it.
          </div>
        </div>
        {/* Shared editorial section-tabs, edge-to-edge along the card's foot. */}
        <SectionTabs tabs={tabs} value={tab} onChange={selectTab} label="Moods sections" />
      </section>

      {err && (
        <div className="card border-[var(--danger)]">
          <div className="card-body text-[12px] text-[var(--danger)]">
            <strong className="tracking-[0.12em] uppercase">controller error</strong>
            <div className="mt-1">{err}</div>
          </div>
        </div>
      )}

      {loading && tab !== 'festivals' && (
        <div className="text-[13px] text-muted italic">loading…</div>
      )}

      {/* --- Vocabulary --- */}
      {tab === 'vocab' && moods !== null && (
        <Card title="Mood vocabulary" sub="the moods every track is tagged with">
          <div className="field">
            <div className="field-hint">
              Give each mood a short id (letters, digits, dashes) and, if you like, a sound
              description we use for audio tagging (needs the heavy analyzer). Change a mood or its
              description and we’ll re-score audio moods on the next analysis pass and mark the
              older tags stale — re-run the tagger to refresh them. If a mood is still used by a
              show, festival, or one of the maps in Moments, you’ll need to reassign it before you
              can remove it.
            </div>
            <ScrollArea className="max-h-[420px]">
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
      )}

      {/* --- Moments: time-of-day + weather --- */}
      {tab === 'moments' && moods !== null && (
        <>
          <Card title="Time of day → mood" sub="the mood your station leans into through the day">
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

          <Card title="Weather → mood" sub="how live weather colours the mood — this wins over time of day">
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
        </>
      )}

      {/* --- Festivals (self-contained, composed as-is) --- */}
      {tab === 'festivals' && <FestivalsSection />}

      {/* --- Speech corrections (relocated from the TTS tab) --- */}
      {tab === 'speech' && moods !== null && (
        <Card title="Speech corrections" sub="how names and tricky words should sound">
          <div className="field">
            <div className="field-hint">
              Find-and-replace rules we apply to every line before it’s spoken, for names and
              words the voice tends to get wrong (<em>GHz</em> →<em> gigahertz</em>, <em>Hozier</em>{' '}
              → <em>Ho-zeer</em>). Case doesn’t matter, and it matches whole words and phrases;
              leave the spoken form empty to drop a word entirely. New rules kick in from the next
              line — no restart needed.
            </div>
            <ScrollArea className="max-h-[360px]">
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
      )}
    </div>
  );
}

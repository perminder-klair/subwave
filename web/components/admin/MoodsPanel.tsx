'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import FestivalsSection from './FestivalsSection';
import { VoicePreviewButton } from './tts/VoicePreviewButton';
import { LanguageSelect } from './LanguageSelect';

interface MoodEntry {
  name: string;
  clapPrompt: string;
}
interface Correction {
  from: string;
  to: string;
}
interface TestVoiceDefaults {
  engine: string;
  voice: string;
  cloudProvider?: string;
  cloudModel?: string;
  speed?: number;
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

  // Active tab lives in the URL (?tab=…) so SectionTabs and the sidebar submenu
  // share one source of truth.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'vocab';

  // Working copies + saved baselines (for dirty detection).
  const [moods, setMoods] = useState<MoodEntry[] | null>(null);
  const [savedMoods, setSavedMoods] = useState<MoodEntry[]>([]);
  const [schedule, setSchedule] = useState<Record<string, string>>({});
  const [savedSchedule, setSavedSchedule] = useState<Record<string, string>>({});
  const [weather, setWeather] = useState<Record<string, string>>({});
  const [savedWeather, setSavedWeather] = useState<Record<string, string>>({});
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [savedCorrections, setSavedCorrections] = useState<Correction[]>([]);
  const [previewVoice, setPreviewVoice] = useState<TestVoiceDefaults>({ engine: 'piper', voice: '' });
  const [testText, setTestText] = useState('');
  const [testLanguage, setTestLanguage] = useState('');
  const [speechLanguages, setSpeechLanguages] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as {
        values?: {
          moods?: unknown;
          moodSchedule?: unknown;
          weatherMoods?: unknown;
          tts?: {
            corrections?: unknown;
            defaultEngine?: string;
            kokoro?: { voice?: string };
            chatterbox?: { referenceVoice?: string };
            pocketTts?: { voice?: string };
            cloud?: { provider?: string; model?: string; voice?: string };
            speed?: Record<string, number>;
          };
        };
        tts?: {
          speechLanguages?: string[];
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
      const rawTts = v.tts || {};
      const loadedSpeechLanguages = Array.isArray(j?.tts?.speechLanguages)
        ? (j!.tts!.speechLanguages as string[]) : [];
      const previewEngine = rawTts.defaultEngine || 'piper';
      const previewVoiceValue =
        previewEngine === 'kokoro' ? (rawTts.kokoro?.voice || '')
        : previewEngine === 'chatterbox' ? (rawTts.chatterbox?.referenceVoice || '')
        : previewEngine === 'pocket-tts' ? (rawTts.pocketTts?.voice || '')
        : previewEngine === 'cloud' ? (rawTts.cloud?.voice || '')
        : '';
      setMoods(loadedMoods);
      setSavedMoods(loadedMoods);
      setSchedule(loadedSchedule);
      setSavedSchedule(loadedSchedule);
      setWeather(loadedWeather);
      setSavedWeather(loadedWeather);
      setCorrections(loadedCorr);
      setSavedCorrections(loadedCorr);
      setSpeechLanguages(loadedSpeechLanguages);
      setPreviewVoice({
        engine: previewEngine,
        voice: previewVoiceValue,
        cloudProvider: rawTts.cloud?.provider,
        cloudModel: previewEngine === 'cloud' ? rawTts.cloud?.model : undefined,
        speed: rawTts.speed?.[previewEngine],
      });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  // Routed through the Next router so a soft nav re-derives `tab`.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // POST one settings slice; on success the sent value becomes the new baseline.
  // Controller validation messages (e.g. an in-use mood removal) surface verbatim.
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
            The words your library is tagged with, and which of them each part of the day, the
            weather, and the calendar leans into. Edit the list and every show, festival, and
            auto-DJ pick draws from it.
          </div>
        </div>
        <SectionTabs tabs={tabs} value={tab} onChange={selectTab} label="Moods sections" />
      </section>

      {err && <ErrorState error={err} onRetry={load} />}

      {loading && tab !== 'festivals' && <SkeletonCards cards={6} />}

      {tab === 'vocab' && moods !== null && (
        <Card title="Mood vocabulary" sub="the moods every track is tagged with">
          <div className="field">
            <div className="field-hint">
              Give each mood a short id (letters, digits, dashes) and, if you like, a sound
              description we use for audio tagging (needs the heavy analyzer). Change a mood or its
              description and the older tags are marked stale; audio moods re-score on the next
              analysis pass, so re-run the tagger to refresh them. If a mood is still used by a
              show, festival, or one of the maps in Moments, you’ll need to reassign it before you
              can remove it.
            </div>
            <ScrollArea className="max-h-[420px]">
              <div className="flex flex-col gap-2 pr-2">
                {moods.map((m, idx) => (
                  /* Mobile: id + bin on row one, sound description on row two —
                     a 160px id beside a bin leaves ~110px at 390px. */
                  <div
                    key={idx}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto]"
                  >
                    <Input
                      aria-label="Mood id"
                      value={m.name}
                      onChange={e => setMoods(list =>
                        (list ?? []).map((row, i) => i === idx ? { ...row, name: e.target.value } : row))}
                      placeholder="id (e.g. mellow)"
                      maxLength={40}
                      className="col-start-1 row-start-1 min-w-0"
                    />
                    <Input
                      aria-label="Mood sound description"
                      value={m.clapPrompt}
                      onChange={e => setMoods(list =>
                        (list ?? []).map((row, i) => i === idx ? { ...row, clapPrompt: e.target.value } : row))}
                      placeholder="sound description for audio tagging (optional)"
                      maxLength={200}
                      className="col-span-2 col-start-1 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1"
                    />
                    <Btn
                      sm
                      title="Remove mood"
                      className="col-start-2 row-start-1 size-9 shrink-0 sm:col-start-3 sm:size-auto"
                      onClick={() => setMoods(list => (list ?? []).filter((_, i) => i !== idx))}
                    >
                      <Trash2 size={12} />
                    </Btn>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Btn
                className="min-h-9 sm:min-h-0"
                disabled={moods.length >= MOODS_LIMIT}
                onClick={() => setMoods(list => [...(list ?? []), { name: '', clapPrompt: '' }])}
              >
                Add mood
              </Btn>
              <Btn
                tone="accent"
                className="min-h-9 sm:min-h-0"
                disabled={!moodsDirty || busy === 'moods'}
                onClick={saveMoods}
              >
                {busy === 'moods' ? 'Saving…' : 'Save vocabulary'}
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {tab === 'moments' && moods !== null && (
        <>
          <Card title="Time of day → mood" sub="the mood your station leans into through the day">
            <div className="grid gap-2">
              {PERIODS.map(p => (
                /* `flex-wrap` lets the select drop under the label at 390px
                   rather than being clipped. */
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <div className="min-w-0">
                    <span className="text-[13px] font-bold">{p.label}</span>
                    <span className="mono-num ml-2 text-[11px] text-muted">{p.hours}</span>
                  </div>
                  <Select
                    value={schedule[p.id] || (savedMoodNames[0] ?? '')}
                    onValueChange={v => setSchedule(s => ({ ...s, [p.id]: v }))}
                  >
                    <SelectTrigger className="max-w-[200px] min-w-[160px]" aria-label={`Mood for ${p.label}`}>
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
                <Btn tone="accent" className="min-h-9 sm:min-h-0" disabled={!scheduleDirty || busy === 'schedule'} onClick={saveSchedule}>
                  {busy === 'schedule' ? 'Saving…' : 'Save time-of-day moods'}
                </Btn>
              </div>
            </div>
          </Card>

          <Card title="Weather → mood" sub="how live weather colours the mood — this wins over time of day">
            <div className="grid gap-2">
              {CONDITIONS.map(c => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <span className="text-[13px] font-bold">{c.label}</span>
                  <Select
                    value={weather[c.id] ? weather[c.id] : NONE}
                    onValueChange={v => setWeather(w => ({ ...w, [c.id]: v === NONE ? '' : v }))}
                  >
                    <SelectTrigger className="max-w-[200px] min-w-[160px]" aria-label={`Mood for ${c.label}`}>
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
                <Btn tone="accent" className="min-h-9 sm:min-h-0" disabled={!weatherDirty || busy === 'weather'} onClick={saveWeather}>
                  {busy === 'weather' ? 'Saving…' : 'Save weather moods'}
                </Btn>
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === 'festivals' && <FestivalsSection />}

      {tab === 'speech' && moods !== null && (
        <>
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
                    /* Mobile: "on air" + bin on row one, "reads as" + spoken form on
                       row two — 220/260px inputs plus a label never fit the 320px a
                       card body leaves at 390px. `sm:justify-start` keeps the auto
                       tracks at content width. */
                    <div
                      key={idx}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[220px_auto_260px_auto] sm:justify-start"
                    >
                      <Input
                        aria-label="Text on air"
                        value={c.from}
                        onChange={e => setCorrections(list =>
                          list.map((row, i) => i === idx ? { ...row, from: e.target.value } : row))}
                        placeholder="text on air (e.g. GHz)"
                        maxLength={80}
                        className="col-span-2 col-start-1 row-start-1 min-w-0 sm:col-span-1"
                      />
                      <span className="col-start-1 row-start-2 shrink-0 text-[11px] text-muted sm:col-start-2 sm:row-start-1">reads as</span>
                      <Input
                        aria-label="Spoken form"
                        value={c.to}
                        onChange={e => setCorrections(list =>
                          list.map((row, i) => i === idx ? { ...row, to: e.target.value } : row))}
                        placeholder="spoken form (e.g. gigahertz)"
                        maxLength={160}
                        className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1"
                      />
                      <Btn
                        sm
                        title="Remove correction"
                        className="col-start-3 row-start-1 size-9 shrink-0 sm:col-start-4 sm:size-auto"
                        onClick={() => setCorrections(list => list.filter((_, i) => i !== idx))}
                      >
                        <Trash2 size={12} />
                      </Btn>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Btn
                  className="min-h-9 sm:min-h-0"
                  disabled={corrections.length >= 100}
                  onClick={() => setCorrections(list => [...list, { from: '', to: '' }])}
                >
                  Add correction
                </Btn>
                <Btn
                  tone="accent"
                  className="min-h-9 sm:min-h-0"
                  disabled={!correctionsDirty || busy === 'corrections'}
                  onClick={saveCorrections}
                >
                  {busy === 'corrections' ? 'Saving…' : 'Save corrections'}
                </Btn>
              </div>
            </div>
          </Card>

          <Card title="Test corrections" sub="hear a rule before saving, with the station's default voice">
            <div className="field">
              <div className="field-hint">
                Uses the corrections list above exactly as it stands right now, unsaved
                changes included, spoken by the station&apos;s default voice
                ({previewVoice.engine}). Type a line using a word you corrected, or leave
                it blank and pick a language below to hear a localized sample sentence
                instead.
              </div>
              <Input
                aria-label="Test sentence"
                value={testText}
                onChange={e => setTestText(e.target.value)}
                placeholder="Type a line using a word you corrected…"
                maxLength={200}
              />
              <LanguageSelect
                value={testLanguage}
                onChange={setTestLanguage}
                languages={speechLanguages}
                className="mt-2 max-w-[260px]"
                ariaLabel="Sample sentence language"
              />
              <VoicePreviewButton
                className="mt-3"
                engine={previewVoice.engine}
                voice={previewVoice.voice}
                cloudProvider={previewVoice.cloudProvider}
                cloudModel={previewVoice.cloudModel}
                speed={previewVoice.speed}
                text={testText}
                language={testLanguage}
                corrections={effectiveCorr}
                disabled={!testText.trim() && !testLanguage}
                adminFetch={adminFetch}
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

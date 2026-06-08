// Weekly schedule: day tabs (default today) + collapsed show blocks with
// persona avatars. Ported from web ScheduleDrawer — same slot-collapsing logic.

import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { StationApi } from '@/lib/api';
import type {
  ActiveShow,
  ScheduleShow,
  SchedulePersona,
  SchedulePayload,
} from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

interface Slot {
  hour: number;
  endHour: number;
  show: ScheduleShow | null;
  persona: SchedulePersona | null;
}

function collapseSlots(
  dayGrid: Array<string | null>,
  shows: ScheduleShow[],
  personas: SchedulePersona[],
): Slot[] {
  const showById = new Map(shows.map((s) => [s.id, s]));
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const out: Slot[] = [];
  let i = 0;
  while (i < 24) {
    const id = dayGrid?.[i] ?? null;
    let j = i;
    while (j + 1 < 24 && (dayGrid?.[j + 1] ?? null) === id) j++;
    const show = id ? showById.get(id) || null : null;
    const persona = show ? personaById.get(show.personaId) || null : null;
    out.push({ hour: i, endHour: j, show, persona });
    i = j + 1;
  }
  return out;
}

export interface ScheduleDrawerProps {
  api: StationApi;
  activeShow: ActiveShow | null;
}

export default function ScheduleDrawer({ api, activeShow }: ScheduleDrawerProps) {
  const { colors } = useTheme();
  const [data, setData] = useState<SchedulePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const today = useMemo(() => new Date().getDay(), []);
  const [day, setDay] = useState(today);
  const currentHour = useMemo(() => new Date().getHours(), []);

  useEffect(() => {
    let alive = true;
    api
      .schedule()
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setErr('Schedule unavailable.'); });
    return () => { alive = false; };
  }, [api]);

  if (err) {
    return <Text className="font-body text-muted" style={{ fontSize: 13 }}>{err}</Text>;
  }
  if (!data) {
    return <Text className="font-body text-muted" style={{ fontSize: 13 }}>Loading schedule…</Text>;
  }

  const slots = collapseSlots(data.schedule?.[day] ?? [], data.shows || [], data.personas || []);

  return (
    <View>
      {activeShow?.name ? (
        <View
          style={{ borderWidth: 1, borderColor: colors.accent, padding: 12, marginBottom: 16 }}
        >
          <Text className="font-mono text-accent" style={{ fontSize: 9, letterSpacing: 3, marginBottom: 4 }}>ON NOW</Text>
          <Text className="font-body-semibold text-ink" style={{ fontSize: 16 }}>{activeShow.name}</Text>
          {activeShow.persona?.name ? (
            <Text className="font-body text-muted mt-0.5" style={{ fontSize: 12 }}>with {activeShow.persona.name}</Text>
          ) : null}
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3">
        <View className="flex-row" style={{ gap: 6 }}>
          {DAY_LABELS.map((label, d) => {
            const active = d === day;
            return (
              <Pressable
                key={label}
                onPress={() => setDay(d)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderWidth: 1,
                  borderColor: active ? colors.ink : colors.softBorder,
                  backgroundColor: active ? colors.ink : 'transparent',
                }}
              >
                <Text
                  className="font-mono"
                  style={{ fontSize: 10, letterSpacing: 1, color: active ? colors.bg : colors.muted }}
                >
                  {label}
                  {d === today ? ' ·' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {slots.map((slot) => {
        const isNow = day === today && currentHour >= slot.hour && currentHour <= slot.endHour;
        const range = `${pad2(slot.hour)}:00 – ${pad2((slot.endHour + 1) % 24)}:00`;
        return (
          <View
            key={slot.hour}
            className="flex-row items-center"
            style={{
              gap: 12,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: colors.softBorder,
              opacity: slot.show ? 1 : 0.5,
            }}
          >
            <Text className="font-mono" style={{ fontSize: 11, width: 92, color: isNow ? colors.accent : colors.muted }}>
              {range}
            </Text>
            {slot.persona?.avatar ? (
              <Image
                source={{ uri: api.avatar(slot.persona.avatar) }}
                style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.field }}
                contentFit="cover"
              />
            ) : null}
            <View className="flex-1">
              <Text className="font-body-medium text-ink" style={{ fontSize: 14 }} numberOfLines={1}>
                {slot.show?.name || 'Autopilot'}
              </Text>
              {slot.persona?.name ? (
                <Text className="font-body text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
                  {slot.persona.name}
                </Text>
              ) : null}
            </View>
            {isNow ? (
              <Text className="font-mono text-accent" style={{ fontSize: 9, letterSpacing: 2 }}>NOW</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

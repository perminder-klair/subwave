// Listeners who like the radio are the people most likely to want their own,
// so this is the app's one pointer at running a station. Links go out through
// lib/links, which is also why nothing here asks for money.

import { ArrowUpRight, BookOpen, Code, MessagesSquare, Newspaper } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PROJECT_LINKS, openExternal } from '@/lib/links';
import { useTheme } from '@/theme/ThemeContext';

const STEPS = [
  { title: 'A machine that stays on', sub: 'A home server, NAS or small cloud box running Docker.' },
  { title: 'Your music library', sub: 'Navidrome, or any Subsonic-compatible server.' },
  { title: 'A language model', sub: 'A local Ollama box, or a key for a hosted provider.' },
  { title: 'Tune in here', sub: "Once it's on the air, add its address under Stations." },
] as const;

const stripProto = (u: string) => u.replace(/^https?:\/\//, '');

export interface AboutDrawerProps {
  onAddStation: () => void;
}

export default function AboutDrawer({ onAddStation }: AboutDrawerProps) {
  const { colors } = useTheme();

  return (
    <View>
      <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 21 }}>
        SUB/WAVE is free, open-source software for running your own internet radio
        station. One live stream, so every listener hears the same broadcast, with an AI DJ
        that picks songs from the station&apos;s own library and talks between them. This app
        tunes in to any SUB/WAVE station.
      </Text>

      <View style={{ height: 18 }} />
      <SectionLabel text="RUN YOUR OWN" />
      <View style={{ marginTop: 4 }}>
        {STEPS.map((step, i) => (
          <View
            key={step.title}
            className="flex-row"
            style={{ gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
          >
            <Text className="font-mono text-accent" style={{ fontSize: 11, fontWeight: '700', marginTop: 2 }}>
              {String(i + 1).padStart(2, '0')}
            </Text>
            <View className="flex-1">
              <Text className="font-body-semibold text-ink" style={{ fontSize: 14 }}>
                {step.title}
              </Text>
              <Text className="font-body text-muted" style={{ fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>
                {step.sub}
              </Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable
        onPress={() => openExternal(PROJECT_LINKS.setup)}
        accessibilityRole="link"
        accessibilityLabel="Read the setup guide"
        className="flex-row items-center justify-center"
        style={{ gap: 8, marginTop: 16, backgroundColor: colors.accent, paddingVertical: 14 }}
      >
        <BookOpen size={16} color="#fff" />
        <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14, letterSpacing: 0.3 }}>
          Read the setup guide
        </Text>
      </Pressable>
      <Pressable
        onPress={onAddStation}
        accessibilityRole="button"
        accessibilityLabel="Add your station"
        className="flex-row items-center justify-center"
        style={{ gap: 8, marginTop: 8, paddingVertical: 13, borderWidth: 1, borderColor: colors.muted, borderStyle: 'dashed' }}
      >
        <Text className="text-accent" style={{ fontSize: 18, fontWeight: '700', lineHeight: 18 }}>
          +
        </Text>
        <Text className="font-mono text-ink" style={{ fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', fontWeight: '700' }}>
          Already running one? Add it
        </Text>
      </Pressable>

      <View style={{ height: 18 }} />
      <SectionLabel text="THE PROJECT" />
      <LinkRow
        icon={<Newspaper size={18} color={colors.muted} />}
        title="How it works"
        url={PROJECT_LINKS.about}
      />
      <LinkRow
        icon={<Code size={18} color={colors.muted} />}
        title="Source code"
        url={PROJECT_LINKS.source}
      />
      <LinkRow
        icon={<MessagesSquare size={18} color={colors.muted} />}
        title="Community"
        url={PROJECT_LINKS.community}
      />
    </View>
  );
}

function SectionLabel({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <Text className="font-mono" style={{ fontSize: 9, letterSpacing: 3, color: colors.muted }}>
      {text}
    </Text>
  );
}

function LinkRow({ icon, title, url }: { icon: ReactNode; title: string; url: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => openExternal(url)}
      accessibilityRole="link"
      accessibilityLabel={`${title}, opens ${stripProto(url)}`}
      className="flex-row items-center justify-between"
      style={{
        borderWidth: 1,
        borderColor: colors.softBorder,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginTop: 8,
      }}
    >
      <View className="flex-row items-center" style={{ gap: 10 }}>
        {icon}
        <Text className="font-body-semibold text-ink" style={{ fontSize: 14 }}>
          {title}
        </Text>
      </View>
      <View className="flex-row items-center" style={{ gap: 6, flexShrink: 1, marginLeft: 12 }}>
        <Text className="font-mono" style={{ fontSize: 11, color: colors.muted, flexShrink: 1 }} numberOfLines={1}>
          {stripProto(url)}
        </Text>
        <ArrowUpRight size={14} color={colors.muted} />
      </View>
    </Pressable>
  );
}

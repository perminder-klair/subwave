// The back panel — where a real receiver keeps everything that isn't
// power/dial/volume: output jacks, the timer, the fascia switch. Collapses
// what used to be four masthead icons (AirPlay, Cast, sleep, theme) into one
// sheet so the fascia stays clean.
//
// OUTPUT renders the NATIVE AirPlay/Cast buttons (they must be real native
// views to present their system pickers), framed as labeled sockets. TIMER
// and FASCIA are drill-in rows — the parent swaps this sheet's content for
// the sleep/themes drawers in place (one <Sheet>, switched content).

import { AudioLines, ChevronRight, MoonStar, Palette } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { CastButton } from 'react-native-google-cast';
import AirplayButton from '../../../modules/airplay-route-picker';
import { fmtTime } from '@/lib/format';
import { useTheme } from '@/theme/ThemeContext';

export interface BackPanelDrawerProps {
  castAvailable: boolean;
  /** Cast device name while a session is active, else null. */
  castingTo: string | null;
  sleepActive: boolean;
  sleepRemainingSec: number | null;
  themeName: string | null;
  audioFormatLabel: string;
  onOpenAudio: () => void;
  onOpenSleep: () => void;
  onOpenThemes: () => void;
}

export default function BackPanelDrawer({
  castAvailable,
  castingTo,
  sleepActive,
  sleepRemainingSec,
  themeName,
  audioFormatLabel,
  onOpenAudio,
  onOpenSleep,
  onOpenThemes,
}: BackPanelDrawerProps) {
  const { colors } = useTheme();
  const hasOutputs = Platform.OS === 'ios' || castAvailable;

  return (
    <View>
      {hasOutputs ? (
        <View style={{ marginBottom: 18 }}>
          <SectionLabel text="OUTPUT" />
          <View className="flex-row" style={{ gap: 12, marginTop: 8 }}>
            {Platform.OS === 'ios' ? (
              <Socket label="AIRPLAY" sub="HomePod · Apple TV">
                <AirplayButton
                  tint={colors.ink}
                  activeTint={colors.accent}
                  style={{ width: 30, height: 30 }}
                />
              </Socket>
            ) : null}
            {castAvailable ? (
              <Socket
                label="CAST"
                sub={castingTo ? `→ ${castingTo}` : 'Chromecast · TV'}
                active={!!castingTo}
              >
                <CastButton
                  style={{ width: 30, height: 30, tintColor: castingTo ? colors.accent : colors.ink }}
                />
              </Socket>
            ) : null}
          </View>
        </View>
      ) : null}

      <SectionLabel text="AUDIO" />
      <PanelRow
        icon={<AudioLines size={18} color={colors.muted} />}
        title="Audio format"
        value={audioFormatLabel}
        onPress={onOpenAudio}
      />

      <View style={{ height: 14 }} />

      <SectionLabel text="TIMER" />
      <PanelRow
        icon={<MoonStar size={18} color={sleepActive ? colors.accent : colors.muted} />}
        title="Sleep timer"
        value={sleepActive ? `${fmtTime(sleepRemainingSec)} left` : 'Off'}
        valueAccent={sleepActive}
        onPress={onOpenSleep}
      />

      <View style={{ height: 14 }} />

      <SectionLabel text="FASCIA" />
      <PanelRow
        icon={<Palette size={18} color={colors.muted} />}
        title="Theme"
        value={themeName ?? 'Station default'}
        onPress={onOpenThemes}
      />

      {/* Serial plate — pure flavour, like the sticker on the back of the unit. */}
      <Text
        className="font-mono text-muted"
        style={{ fontSize: 8.5, letterSpacing: 2, textAlign: 'center', marginTop: 26, opacity: 0.7 }}
      >
        MODEL SW-1 · SERIAL ∞ · MADE FOR THE INTERNET
      </Text>
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

/** A labeled output "jack": bordered socket around a native picker button. */
function Socket({
  label,
  sub,
  active,
  children,
}: {
  label: string;
  sub: string;
  active?: boolean;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', width: 104 }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderWidth: 1,
          borderColor: active ? colors.accent : `${colors.ink}59`,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: active ? `${colors.accent}14` : colors.field,
        }}
      >
        {children}
      </View>
      <Text
        className="font-mono text-ink"
        style={{ fontSize: 9, letterSpacing: 3, marginTop: 6 }}
      >
        {label}
      </Text>
      <Text
        className="font-mono"
        style={{ fontSize: 8.5, marginTop: 2, color: active ? colors.accent : colors.muted }}
        numberOfLines={1}
      >
        {sub}
      </Text>
    </View>
  );
}

/** Drill-in row, styled after the SleepDrawer/ThemesDrawer row family. */
function PanelRow({
  icon,
  title,
  value,
  valueAccent,
  onPress,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  valueAccent?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${value}`}
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
      <View className="flex-row items-center" style={{ gap: 6 }}>
        <Text
          className="font-mono"
          style={{ fontSize: 11, color: valueAccent ? colors.accent : colors.muted }}
          numberOfLines={1}
        >
          {value}
        </Text>
        <ChevronRight size={14} color={colors.muted} />
      </View>
    </Pressable>
  );
}

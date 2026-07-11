import AsyncStorage from '@react-native-async-storage/async-storage';
import { FORMAT_OPTIONS, streamPreferenceKey, type AudioFormat } from './audioFormat';

const IDS = new Set<string>(FORMAT_OPTIONS.map((f) => f.id));
export async function loadFormatPreference(base: string): Promise<AudioFormat | null> {
  const value = await AsyncStorage.getItem(streamPreferenceKey(base));
  return value && IDS.has(value) ? value as AudioFormat : null;
}
export function saveFormatPreference(base: string, format: AudioFormat): Promise<void> {
  return AsyncStorage.setItem(streamPreferenceKey(base), format);
}

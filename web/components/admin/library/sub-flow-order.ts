type AlbumTrack = { id: string; order: number };

// The order values come from the complete album before unavailable tracks are
// filtered, so a hidden blocked track cannot collapse a gap.
export function albumSelection(ids: string[], album: AlbumTrack[]): string[] | null {
  const positions = ids.map(id => album.find(track => track.id === id));
  if (positions.some(track => !track)) return null;
  const sorted = positions as AlbumTrack[];
  sorted.sort((a, b) => a.order - b.order);
  if (sorted.some((track, index) => index > 0 && track.order !== sorted[index - 1]!.order + 1)) return null;
  return sorted.map(track => track.id);
}

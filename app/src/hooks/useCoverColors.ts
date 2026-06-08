// Pull representative colours out of the current cover art so the player can
// wash a soft, art-derived tint behind itself.
//
// The web does this with a canvas (web/web/hooks/useCoverColors.ts); RN has no
// canvas, so we use react-native-image-colors (UIImageColors on iOS, Palette on
// Android). Any failure resolves to nulls and the caller simply skips the tint.

import { useEffect, useState } from 'react';
import { getColors } from 'react-native-image-colors';

export interface CoverColors {
  vibrant: string | null;
  average: string | null;
}

const EMPTY: CoverColors = { vibrant: null, average: null };

export function useCoverColors(coverSrc: string | null): CoverColors {
  const [colors, setColors] = useState<CoverColors>(EMPTY);

  useEffect(() => {
    if (!coverSrc) {
      setColors(EMPTY);
      return;
    }
    let cancelled = false;
    getColors(coverSrc, { cache: true, key: coverSrc, quality: 'low' })
      .then((res) => {
        if (cancelled) return;
        // The result shape differs per platform; pick a vivid + a calm colour.
        if (res.platform === 'ios') {
          setColors({ vibrant: res.primary, average: res.secondary });
        } else if (res.platform === 'android') {
          setColors({ vibrant: res.vibrant, average: res.average ?? res.muted });
        } else {
          setColors(EMPTY);
        }
      })
      .catch(() => {
        if (!cancelled) setColors(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [coverSrc]);

  return colors;
}

import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

// Inter лежит в public/fonts (OFL, из @fontsource/inter 5.3.0) —
// рендер не зависит от сети и Google Fonts.
export const FONT_FAMILY = 'Inter';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';

for (const weight of ['600', '800']) {
  loadFont({
    family: FONT_FAMILY,
    url: staticFile(`fonts/inter-latin-${weight}-normal.woff2`),
    weight,
    unicodeRange: LATIN,
  });
  loadFont({
    family: FONT_FAMILY,
    url: staticFile(`fonts/inter-cyrillic-${weight}-normal.woff2`),
    weight,
    unicodeRange: CYRILLIC,
  });
}

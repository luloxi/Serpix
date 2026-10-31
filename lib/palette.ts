// Brand tones: the four Serpix colors (pink, cyan, duck yellow and the violet midway between pink and cyan). One place decides which tone a month gets,
// so a month always has the same color (October is always October's). CSS lives in brand.css (.tone-*).
export const TONES = ["pink", "cyan", "yellow", "violet"] as const;
export type Tone = (typeof TONES)[number];

/** Tone for a month index 0-11 (0 = January). Deterministic, year-independent. */
export const toneForMonth = (monthIndex: number): Tone => TONES[((Math.trunc(monthIndex) % 12) + 12) % 12 % TONES.length];

/** Tone for a list index, rotating through the logo tones. Negatives wrap (−1 is the last tone). */
export const toneForIndex = (i: number): Tone => TONES[((Math.trunc(i) % TONES.length) + TONES.length) % TONES.length];

/** Tone for a date string that starts with YYYY-MM (or a full ISO/"YYYY-MM-DD HH:MM" value). Unknown input = pink. */
export function toneForDate(date: string): Tone {
  const m = /^\d{4}-(\d{2})/.exec(date);
  return m ? toneForMonth(Number(m[1]) - 1) : "pink";
}

export const toneClass = (date: string) => "tone-" + toneForDate(date);

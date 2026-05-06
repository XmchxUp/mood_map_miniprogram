// Mood scale: 1 (distressed) → 10 (euphoric)
// Color ramp: red → orange → yellow → green → teal → purple

const PALETTE = [
  '#E53935', // 1 — deep red
  '#F4511E', // 2 — red-orange
  '#FB8C00', // 3 — orange
  '#FDD835', // 4 — yellow
  '#C0CA33', // 5 — yellow-green
  '#7CB342', // 6 — light green
  '#43A047', // 7 — green
  '#00897B', // 8 — teal
  '#0288D1', // 9 — sky blue
  '#7E57C2', // 10 — violet (bliss)
];

const EMOJIS = ['😩', '😟', '😕', '😐', '🙂', '😊', '😄', '😁', '🤩', '🥳'];

/**
 * Returns hex color string for a mood value (1–10).
 * Accepts floats (e.g. avg_mood: 6.4) — rounds to nearest.
 */
function moodColor(mood) {
  const idx = Math.max(0, Math.min(9, Math.round(mood) - 1));
  return PALETTE[idx];
}

/**
 * Returns '#RRGGBBAA' format required by WeChat map circles.
 * alpha: 0.0–1.0
 */
function moodColorAlpha(mood, alpha) {
  const hex = moodColor(mood);
  const aa = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${hex}${aa}`;
}

/**
 * Static options array used by the mood-selector UI.
 * Pre-built once so the WXML wx:for renders efficiently.
 */
const MOOD_OPTIONS = Array.from({ length: 10 }, (_, i) => ({
  value: i + 1,
  label: String(i + 1),
  color: PALETTE[i],
  emoji: EMOJIS[i],
}));

module.exports = { moodColor, moodColorAlpha, MOOD_OPTIONS };

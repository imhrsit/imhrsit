#!/usr/bin/env node
/**
 * Renders the profile banner: monospace text that resolves out of noise, a
 * blinking block cursor, and a muted subtitle.
 *
 * Layout and timing are derived from HANDLE's length, so changing the text
 * rescales the type, the cursor and the reveal instead of overflowing.
 *
 * The animation is deliberately additive. Every element's *attribute* value is
 * its finished state, so a renderer that ignores SMIL shows clean final text
 * rather than a screen of garbage.
 *
 * Usage: node scripts/banner.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const HANDLE = 'Software Engineer';
const SUBTITLE = '22, Delhi';
const SCRAMBLE = '!<>-_\\/[]{}=+*^?#$%&@01xyz';

const W = 760;
const H = 150;
const INNER_W = 660;   // width available to the handle plus its cursor
const ADV_MAX = 40;    // cell width ceiling, so short text is not gigantic
const VARIANTS = 6;    // noise glyphs shown before a character settles

const CHARS = [...HANDLE];
const CELLS = CHARS.length + 1; // the cursor occupies a trailing cell

// Type scale: shrink the cell until the whole line fits the usable width.
const ADV = Math.min(ADV_MAX, INNER_W / CELLS);
const FONT_SIZE = ADV * 1.55;
const BASELINE = 52 + FONT_SIZE * 0.48;
const SUB_Y = BASELINE + 38;

// Reveal timing: tighten the per-character stagger as the text gets longer so
// the whole decode stays under roughly a second.
const STAGGER = Math.min(0.085, 0.9 / CHARS.length);
const LAST_SETTLE = 0.22 + (CHARS.length - 1) * STAGGER;
const SUB_START = LAST_SETTLE + 0.12;
const SUB_END = SUB_START + 0.5;
const TIMELINE = SUB_END + 0.1;
const CURSOR_BEGIN = LAST_SETTLE + 0.2;

const MONO =
  "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const THEMES = {
  dark: { handle: '#e6edf3', noise: '#2ea043', cursor: '#3fdd6d', sub: '#6e7681' },
  light: { handle: '#0d1117', noise: '#1a7f3c', cursor: '#1a7f3c', sub: '#6e7681' },
};

/** Deterministic PRNG so regenerating does not churn the diff. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escChar = (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c;
const escText = (s) => [...s].map(escChar).join('');

const n2 = (v) => Number(v.toFixed(2));
const n4 = (v) => Number(v.toFixed(4));

function render(theme) {
  const t = THEMES[theme];
  const rand = rng(0x1a7f3c);
  const cx = W / 2;

  // Centre the text and the cursor together as one block.
  const cellX = (i) => cx + (i - CHARS.length / 2) * ADV;
  const cursorX = cx + (CHARS.length / 2) * ADV;

  let out = '';

  for (let i = 0; i < CHARS.length; i += 1) {
    const ch = CHARS[i];
    if (ch === ' ') continue; // a gap stays a gap; do not scramble whitespace

    const x = n2(cellX(i));
    const settle = 0.22 + i * STAGGER;
    const common = `x="${x}" y="${n2(BASELINE)}" font-family="${MONO}" font-size="${n2(FONT_SIZE)}" font-weight="700" text-anchor="middle"`;

    // Noise glyphs: hidden by default, each flashed for one slice of this
    // character's scramble window.
    for (let v = 0; v < VARIANTS; v += 1) {
      const glyph = escChar(SCRAMBLE[Math.floor(rand() * SCRAMBLE.length)]);
      const a = n4((v * settle) / VARIANTS / TIMELINE);
      const b = n4(((v + 1) * settle) / VARIANTS / TIMELINE);
      const keyTimes = v === 0 ? `0;${b};1` : `0;${a};${b};1`;
      const values = v === 0 ? '1;0;0' : '0;1;0;0';
      out +=
        `<text ${common} fill="${t.noise}" opacity="0">${glyph}` +
        `<animate attributeName="opacity" values="${values}" keyTimes="${keyTimes}" ` +
        `dur="${n2(TIMELINE)}s" begin="0s" fill="freeze" calcMode="discrete"/></text>`;
    }

    // The real character: visible by default, revealed on cue when animating.
    out +=
      `<text ${common} fill="${t.handle}" opacity="1">${escChar(ch)}` +
      `<animate attributeName="opacity" values="0;1;1" keyTimes="0;${n4(settle / TIMELINE)};1" ` +
      `dur="${n2(TIMELINE)}s" begin="0s" fill="freeze" calcMode="discrete"/></text>`;
  }

  // Block cursor: solid through the reveal, then blinking forever.
  const cw = ADV * 0.55;
  out +=
    `<rect x="${n2(cursorX - cw / 2)}" y="${n2(BASELINE - FONT_SIZE * 0.742)}" ` +
    `width="${n2(cw)}" height="${n2(FONT_SIZE * 0.775)}" fill="${t.cursor}">` +
    `<animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="1.1s" ` +
    `begin="${n2(CURSOR_BEGIN)}s" repeatCount="indefinite" calcMode="discrete"/></rect>`;

  out +=
    `<text x="${cx}" y="${n2(SUB_Y)}" fill="${t.sub}" font-family="${MONO}" font-size="13.5" ` +
    `letter-spacing="1.2" text-anchor="middle" opacity="1">${escText(SUBTITLE)}` +
    `<animate attributeName="opacity" values="0;0;1;1" ` +
    `keyTimes="0;${n4(SUB_START / TIMELINE)};${n4(SUB_END / TIMELINE)};1" ` +
    `dur="${n2(TIMELINE)}s" begin="0s" fill="freeze"/></text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escText(HANDLE)}">
<title>${escText(HANDLE)}</title>
${out}
</svg>`;
}

mkdirSync('assets', { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const svg = render(theme);
  writeFileSync(`assets/banner-${theme}.svg`, svg);
  console.log(`wrote assets/banner-${theme}.svg (${svg.length} bytes)`);
}
console.log(
  `handle "${HANDLE}" -> ${CHARS.length} chars, cell ${ADV.toFixed(1)}px, ` +
    `font ${FONT_SIZE.toFixed(1)}px, timeline ${TIMELINE.toFixed(2)}s`
);

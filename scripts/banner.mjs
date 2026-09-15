#!/usr/bin/env node
/**
 * Renders the profile banner: a monospace handle that resolves out of noise,
 * a blinking block cursor, and a muted subtitle.
 *
 * The animation is deliberately additive. Every element's *attribute* value is
 * its finished state, so a renderer that ignores SMIL shows clean final text
 * rather than a screen of garbage.
 *
 * Usage: node scripts/banner.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const HANDLE = 'imhrsit';
const SUBTITLE = '// nothing to see here';
const SCRAMBLE = '!<>-_\\/[]{}=+*^?#$%&@01xyz';

const W = 760;
const H = 150;
const ADV = 40;        // per-character cell width
const FONT_SIZE = 62;
const BASELINE = 82;

const TIMELINE = 1.6;  // seconds
const VARIANTS = 6;    // noise glyphs shown before a character settles

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

const esc = (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c;

function render(theme) {
  const t = THEMES[theme];
  const rand = rng(0x1a7f3c);
  const n = HANDLE.length;
  const cx = W / 2;

  // Centre the handle *and* the cursor cell as one block.
  const cellX = (i) => cx + (i - n / 2) * ADV;
  const cursorX = cx + (n / 2) * ADV;

  let out = '';

  for (let i = 0; i < n; i += 1) {
    const x = cellX(i).toFixed(1);
    const settle = 0.22 + i * 0.085;
    const common = `x="${x}" y="${BASELINE}" font-family="${MONO}" font-size="${FONT_SIZE}" font-weight="700" text-anchor="middle"`;

    // Noise glyphs: hidden by default, each flashed for one slice of the
    // character's scramble window.
    for (let v = 0; v < VARIANTS; v += 1) {
      const glyph = esc(SCRAMBLE[Math.floor(rand() * SCRAMBLE.length)]);
      const a = ((v * settle) / VARIANTS / TIMELINE).toFixed(4);
      const b = (((v + 1) * settle) / VARIANTS / TIMELINE).toFixed(4);
      const keyTimes = v === 0 ? `0;${b};1` : `0;${a};${b};1`;
      const values = v === 0 ? '1;0;0' : '0;1;0;0';
      out +=
        `<text ${common} fill="${t.noise}" opacity="0">${glyph}` +
        `<animate attributeName="opacity" values="${values}" keyTimes="${keyTimes}" ` +
        `dur="${TIMELINE}s" begin="0s" fill="freeze" calcMode="discrete"/></text>`;
    }

    // The real character: visible by default, revealed on cue when animating.
    const s = (settle / TIMELINE).toFixed(4);
    out +=
      `<text ${common} fill="${t.handle}" opacity="1">${esc(HANDLE[i])}` +
      `<animate attributeName="opacity" values="0;1;1" keyTimes="0;${s};1" ` +
      `dur="${TIMELINE}s" begin="0s" fill="freeze" calcMode="discrete"/></text>`;
  }

  // Block cursor: solid through the reveal, then blinking forever.
  out +=
    `<rect x="${(cursorX - 11).toFixed(1)}" y="36" width="22" height="48" fill="${t.cursor}">` +
    `<animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="1.1s" ` +
    `begin="0.95s" repeatCount="indefinite" calcMode="discrete"/></rect>`;

  out +=
    `<text x="${cx}" y="120" fill="${t.sub}" font-family="${MONO}" font-size="13.5" ` +
    `letter-spacing="1.2" text-anchor="middle" opacity="1">${SUBTITLE.replace(/[&<>]/g, esc)}` +
    `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;0.53;0.84;1" ` +
    `dur="${TIMELINE}s" begin="0s" fill="freeze"/></text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${HANDLE}">
<title>${HANDLE}</title>
${out}
</svg>`;
}

mkdirSync('assets', { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const svg = render(theme);
  writeFileSync(`assets/banner-${theme}.svg`, svg);
  console.log(`wrote assets/banner-${theme}.svg (${svg.length} bytes)`);
}

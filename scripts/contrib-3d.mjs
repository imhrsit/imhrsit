#!/usr/bin/env node
/**
 * Renders an isometric 3D GitHub contribution calendar as a standalone SVG.
 *
 * Data source: GitHub GraphQL API when GITHUB_TOKEN is present (the path used
 * in CI), otherwise the public contributions HTML fragment so the script can be
 * run locally with no credentials.
 *
 * Usage: node scripts/contrib-3d.mjs --user <login> --out <dir>
 */

import { writeFileSync, mkdirSync } from 'node:fs';

/* ------------------------------------------------------------------ config */

const THEMES = {
  dark: {
    bg: '#1b2026',
    border: '#2f3641',
    empty: '#262c34',
    emptyEdge: '#20252c',
    text: '#adbac7',
    dim: '#69747f',
    accent: '#3fdd6d',
    levels: ['#1c5c38', '#227a44', '#2f9d55', '#46c96e'],
    bars: '#2f9d55',
  },
  light: {
    bg: '#ffffff',
    border: '#d8dee4',
    empty: '#ebedf0',
    emptyEdge: '#dfe2e6',
    text: '#24292f',
    dim: '#7d868f',
    accent: '#1a7f3c',
    levels: ['#a9e4b4', '#56c274', '#33a457', '#17803d'],
    bars: '#7cd193',
  },
};

// Isometric tile footprint. Width:height of 26:11 gives the shallow, wide
// plane in the reference design rather than a true 2:1 dimetric projection.
const TILE_W = 26;
const TILE_H = 11;
const MAX_CUBE_H = 46;
const MIN_CUBE_H = 5;

// Every animation shares one timeline that starts at t=0 and holds its opening
// value until its own slot. Staggering via `begin` instead would let an element
// render at its final size first, then snap back when its clock started.
const TIMELINE = 1.9;
const KEY_SPLINES = '0 0 1 1;0.16 0.84 0.32 1;0 0 1 1';

/** keyTimes for a hold -> transition -> hold run inside the shared timeline. */
function slot(delay, dur) {
  const a = Math.min(delay / TIMELINE, 1);
  const b = Math.min((delay + dur) / TIMELINE, 1);
  return `0;${a.toFixed(4)};${b.toFixed(4)};1`;
}

const W = 900;
const H = 500;
const ORIGIN_X = 155;
const ORIGIN_Y = 105;

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ------------------------------------------------------------------- utils */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Darken/lighten a hex colour by `amount` (-1..1) for the cube's two side faces.
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.max(0, Math.min(255, Math.round(v)));
  });
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/* -------------------------------------------------------------------- data */

async function fromGraphQL(login, token) {
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount weekday } }
        }
      }
    }
  }`;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'contrib-3d',
    },
    body: JSON.stringify({ query, variables: { login } }),
  });

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors[0].message}`);

  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(`no calendar returned for "${login}"`);

  const days = [];
  for (const week of cal.weeks) {
    for (const d of week.contributionDays) {
      days.push({ date: d.date, count: d.contributionCount });
    }
  }
  return { days, total: cal.totalContributions };
}

async function fromPublicHTML(login) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(login)}/contributions`, {
    headers: { 'User-Agent': 'contrib-3d', Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`contributions HTML HTTP ${res.status}`);
  const html = await res.text();

  // Counts live in sr-only <tool-tip> elements keyed to each cell's id.
  const counts = new Map();
  const tipRe = /<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g;
  for (let m; (m = tipRe.exec(html)); ) {
    const text = m[2].trim();
    const num = /^([\d,]+)\s+contribution/.exec(text);
    counts.set(m[1], num ? parseInt(num[1].replace(/,/g, ''), 10) : 0);
  }

  const days = [];
  const cellRe = /<td\b[^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*>/g;
  for (let m; (m = cellRe.exec(html)); ) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const level = parseInt(/\bdata-level="(\d+)"/.exec(tag)?.[1] ?? '0', 10);
    // Fall back to the level bucket if a tooltip is missing, so a markup
    // change degrades into a duller chart rather than an empty one.
    const count = counts.has(id) ? counts.get(id) : level > 0 ? level : 0;
    days.push({ date: m[1], count });
  }

  if (!days.length) throw new Error('could not parse any contribution cells');
  return { days, total: days.reduce((a, d) => a + d.count, 0) };
}

async function loadDays(login, token) {
  if (token) {
    try {
      return await fromGraphQL(login, token);
    } catch (err) {
      console.error(`GraphQL failed (${err.message}); falling back to public HTML`);
    }
  }
  return fromPublicHTML(login);
}

/* ------------------------------------------------------------------ layout */

/** Places each day on a (column, row) grid: column = week, row = weekday. */
function buildGrid(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(`${sorted[0].date}T00:00:00Z`);
  // Wind back to the Sunday that starts the first column.
  const origin = new Date(first);
  origin.setUTCDate(origin.getUTCDate() - origin.getUTCDay());

  const cells = sorted.map((d) => {
    const date = new Date(`${d.date}T00:00:00Z`);
    const offset = Math.round((date - origin) / 86400000);
    return { ...d, col: Math.floor(offset / 7), row: date.getUTCDay() };
  });

  const cols = Math.max(...cells.map((c) => c.col)) + 1;

  // GitHub's calendar starts and ends mid-week, which would leave a notched
  // edge on the isometric plane. Pad the missing corners with empty plates so
  // the ground reads as one clean parallelogram.
  const seen = new Set(cells.map((c) => `${c.col}:${c.row}`));
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < 7; row += 1) {
      if (!seen.has(`${col}:${row}`)) cells.push({ date: null, count: 0, col, row });
    }
  }

  return { cells, cols };
}

/* ------------------------------------------------------------------ render */

function cube(x, y, h, colors, animate, delay) {
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  const { top, left, right } = colors;

  if (h <= 0) {
    // Flat plate for a zero-contribution day.
    const pts = `0,${-hh} ${hw},0 0,${hh} ${-hw},0`;
    return `<g transform="translate(${x} ${y})"><polygon points="${pts}" fill="${top}" stroke="${left}" stroke-width=".5"/></g>`;
  }

  const topFace = `0,${-h - hh} ${hw},${-h} 0,${-h + hh} ${-hw},${-h}`;
  const leftFace = `${-hw},${-h} 0,${-h + hh} 0,${hh} ${-hw},0`;
  const rightFace = `${hw},${-h} 0,${-h + hh} 0,${hh} ${hw},0`;

  const body =
    `<polygon points="${leftFace}" fill="${left}"/>` +
    `<polygon points="${rightFace}" fill="${right}"/>` +
    `<polygon points="${topFace}" fill="${top}"/>`;

  if (!animate) {
    return `<g transform="translate(${x} ${y})">${body}</g>`;
  }

  // Grow each block out of the plane, staggered left-to-right across the year.
  // The inner group carries no base transform on purpose: if a renderer ignores
  // SMIL, the cube still draws at full height instead of collapsing to nothing.
  return (
    `<g transform="translate(${x} ${y})">` +
    `<g>` +
    `<animateTransform attributeName="transform" type="scale" ` +
    `values="1 0.01;1 0.01;1 1;1 1" keyTimes="${slot(Number(delay), 0.6)}" ` +
    `dur="${TIMELINE}s" begin="0s" fill="freeze" ` +
    `calcMode="spline" keySplines="${KEY_SPLINES}"/>` +
    `${body}</g></g>`
  );
}

function render({ cells, cols }, total, login, theme, animate) {
  const t = THEMES[theme];
  const max = Math.max(1, ...cells.map((c) => c.count));

  // Perceptual easing: without it a single outlier day flattens the whole year.
  const heightFor = (count) =>
    count <= 0 ? 0 : MIN_CUBE_H + (MAX_CUBE_H - MIN_CUBE_H) * Math.pow(count / max, 0.62);

  const levelFor = (count) => {
    if (count <= 0) return -1;
    const r = count / max;
    if (r <= 0.25) return 0;
    if (r <= 0.5) return 1;
    if (r <= 0.75) return 2;
    return 3;
  };

  // Painter's algorithm: (col + row) ascending draws back-to-front.
  const ordered = [...cells].sort((a, b) => a.col + a.row - (b.col + b.row));

  const blocks = ordered
    .map((c) => {
      const x = (ORIGIN_X + (c.col - c.row) * (TILE_W / 2)).toFixed(1);
      const y = (ORIGIN_Y + (c.col + c.row) * (TILE_H / 2)).toFixed(1);
      const h = heightFor(c.count);
      const lvl = levelFor(c.count);
      const base = lvl < 0 ? t.empty : t.levels[lvl];
      const colors =
        lvl < 0
          ? { top: t.empty, left: t.emptyEdge, right: t.emptyEdge }
          : { top: base, left: shade(base, -0.4), right: shade(base, -0.2) };
      const delay = (c.col / Math.max(1, cols - 1)) * 1.1;
      return cube(x, y, h, colors, animate, delay.toFixed(2));
    })
    .join('');

  // Weekday totals for the "most active days" histogram.
  const byWeekday = Array(7).fill(0);
  for (const c of cells) byWeekday[c.row] += c.count;
  const peak = Math.max(1, ...byWeekday);
  const peakDay = byWeekday.indexOf(Math.max(...byWeekday));

  const BAR_X = 88;
  const BAR_BASE = 360;
  const BAR_MAX = 78;
  const BAR_W = 17;
  const BAR_GAP = 7;

  const bars = byWeekday
    .map((v, i) => {
      const h = Math.max(3, (v / peak) * BAR_MAX);
      const x = BAR_X + i * (BAR_W + BAR_GAP);
      const y = BAR_BASE - h;
      const fill = i === peakDay ? t.accent : t.bars;
      const kt = slot(0.5 + i * 0.06, 0.7);
      const anim = (attr, from, to) =>
        `<animate attributeName="${attr}" values="${from};${from};${to};${to}" ` +
        `keyTimes="${kt}" dur="${TIMELINE}s" begin="0s" fill="freeze" ` +
        `calcMode="spline" keySplines="${KEY_SPLINES}"/>`;
      const grow = animate
        ? anim('height', 0, h.toFixed(1)) + anim('y', BAR_BASE, y.toFixed(1))
        : '';
      // Final geometry stays in the attributes so a non-animating renderer
      // shows the completed histogram.
      return (
        `<rect x="${x}" y="${y.toFixed(1)}" width="${BAR_W}" height="${h.toFixed(1)}" rx="2" fill="${fill}">` +
        `<title>${DAY_NAMES[i]}: ${v} contributions</title>${grow}</rect>`
      );
    })
    .join('');

  const barLabels = DAY_INITIALS.map((d, i) => {
    const x = BAR_X + i * (BAR_W + BAR_GAP) + BAR_W / 2;
    const fill = i === peakDay ? t.text : t.dim;
    return `<text x="${x}" y="378" fill="${fill}" font-size="11" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${d}</text>`;
  }).join('');

  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  const totalFade = animate
    ? `<animate attributeName="opacity" values="0;0;1;1" keyTimes="${slot(0.15, 0.7)}" ` +
      `dur="${TIMELINE}s" begin="0s" fill="freeze"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(login)}'s GitHub contributions over the last year, ${total} total">
<title>${esc(login)} — ${total} contributions in the last year</title>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
<text x="42" y="46" fill="${t.dim}" font-size="12.5" font-family="${mono}">${esc(login)}<tspan fill="${t.border}"> / </tspan><tspan fill="${t.text}">contributions</tspan></text>
<g>${totalFade}
  <text x="${W - 42}" y="94" fill="${t.accent}" font-size="52" font-weight="700" text-anchor="end" font-family="${sans}">${total.toLocaleString('en-US')}</text>
  <text x="${W - 42}" y="118" fill="${t.dim}" font-size="11.5" text-anchor="end" letter-spacing="2.4" font-family="${sans}">TOTAL CONTRIBUTIONS</text>
</g>
<g>${blocks}</g>
<g>${bars}${barLabels}</g>
<text x="${BAR_X}" y="405" fill="${t.text}" font-size="16.5" font-family="${sans}">Most active day — ${DAY_NAMES[peakDay]}</text>
<text x="${BAR_X}" y="428" fill="${t.dim}" font-size="11.5" font-family="${mono}">Pulled daily from GitHub.</text>
<text x="${BAR_X}" y="445" fill="${t.dim}" font-size="11.5" font-family="${mono}">Rolling last-12-month activity.</text>
</svg>`;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const login = args.user || process.env.USERNAME || 'imhrsit';
  const outDir = args.out || 'assets';
  const animate = args.animate !== 'false';

  const { days, total } = await loadDays(login, process.env.GITHUB_TOKEN || '');
  const grid = buildGrid(days);

  mkdirSync(outDir, { recursive: true });
  for (const theme of ['dark', 'light']) {
    const svg = render(grid, total, login, theme, animate);
    writeFileSync(`${outDir}/contributions-${theme}.svg`, svg);
    console.log(`wrote ${outDir}/contributions-${theme}.svg (${svg.length} bytes)`);
  }
  console.log(`${login}: ${total} contributions across ${days.length} days, ${grid.cols} weeks`);
}

main().catch((err) => {
  console.error(`contrib-3d failed: ${err.message}`);
  process.exit(1);
});

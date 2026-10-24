// Landing page (#98, design board A). One state object, pure render
// functions, and one loop: lens -> fetch -> render. The lens lives in the URL
// (history.replaceState), parsed once on load. The pure helpers are exported
// so test/home-ui.test.ts can check them without a browser.

export const LENS_KEYS = ['scope', 'range', 'from', 'to', 'deck', 'vs', 'bot', 'ver', 'map', 'format', 'player'];
export const PIN_KEYS = ['deck', 'vs', 'bot', 'ver', 'map', 'format', 'player'];
const PIN_KINDS = { deck: 'deck', vs: 'vs', bot: 'bot', ver: 'version', map: 'map', format: 'format', player: 'player' };
const RANGES = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const FORMAT_LABELS = { duel: '1v1', 'team-2v2': '2v2', 'two-v-one-boss': '2v1 boss', 'ffa-3': '3 FFA' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_PLURALS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
/** Heat grid rows, Monday first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_MS = 86_400_000;
const CLOCK_KEY = 'unbrewed.home.clock';

// ---------- lens <-> URL ----------

/** Every lens key as a trimmed string or null. Validation is the server's (a bad value comes back as 400 BAD_LENS). */
export function parseLens(search) {
  const params = new URLSearchParams(search);
  const lens = {};
  for (const key of LENS_KEYS) lens[key] = params.get(key)?.trim() || null;
  if (!lens.scope) lens.scope = 'human';
  if (!lens.range && !lens.from && !lens.to) lens.range = '7d';
  return lens;
}

export function lensQuery(lens) {
  const params = new URLSearchParams();
  for (const key of LENS_KEYS) if (lens[key]) params.set(key, lens[key]);
  return params.toString();
}

export function withPin(lens, key, value) {
  return { ...lens, [key]: lens[key] === value ? null : value };
}

export function withRange(lens, range) {
  return { ...lens, range, from: null, to: null };
}

export function withDays(lens, from, to) {
  return { ...lens, range: null, from, to };
}

// ---------- formatting ----------

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const titleCase = (id) => String(id).split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
export const deckName = (id) => titleCase(id);
export const mapName = (id) => titleCase(id);
export const formatName = (id) => FORMAT_LABELS[id] || id;
const playerName = (id) => (id.length > 10 ? `${id.slice(0, 8)}…` : id);

export function pinLabel(key, value) {
  if (key === 'deck' || key === 'vs') return deckName(value);
  if (key === 'map') return mapName(value);
  if (key === 'format') return formatName(value);
  if (key === 'player') return playerName(value);
  if (key === 'ver') return value.replace(':', ' ');
  return value;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const dayLabel = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function rangeLabel(lens, summary) {
  if (lens.from && lens.to) return lens.from === lens.to ? dayLabel(lens.from) : `${dayLabel(lens.from)} – ${dayLabel(lens.to)}`;
  if (summary?.widened) return 'last 30 days (widened)';
  return { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' }[lens.range] || `range ${lens.range}`;
}

export function storySentence(lens, summary) {
  let s = lens.scope === 'all' ? 'All live games' : 'Games with a human';
  s += `, ${rangeLabel(lens, summary)}`;
  if (lens.deck) s += ` with ${deckName(lens.deck)}`;
  if (lens.vs) s += ` against ${deckName(lens.vs)}`;
  if (lens.bot) s += ` featuring the ${lens.bot} bot`;
  if (lens.ver) s += ` on ${lens.ver.replace(':', ' ')}`;
  if (lens.map) s += ` on ${mapName(lens.map)}`;
  if (lens.format) s += ` in ${formatName(lens.format)}`;
  if (lens.player) s += ` played by ${playerName(lens.player)}`;
  if (!summary) return `${s}.`;
  s += `: ${summary.kpis.games} games, ${summary.kpis.uniqueHumans} humans`;
  return summary.previous.games ? `${s}, previous period ${summary.previous.games} games.` : `${s}.`;
}

/** One way out per active constraint, so an empty lens can always be undone. */
export function emptyOuts(lens) {
  const outs = PIN_KEYS.filter((key) => lens[key]).map((key) => ({
    label: `Unpin ${PIN_KINDS[key]} ${pinLabel(key, lens[key])}`, action: 'unpin', key,
  }));
  if (lens.scope !== 'all') outs.push({ label: 'Include bot-only games', action: 'scope', value: 'all' });
  if (lens.from || lens.to) outs.push({ label: 'Clear date selection', action: 'range', value: '7d' });
  // 7d already auto-widened on the server; only 24h has a wider default to try.
  else if (lens.range === '24h') outs.push({ label: 'Widen to 30 days', action: 'range', value: '30d' });
  return outs;
}

// ---------- "When people play": UTC buckets -> the viewer's local time ----------

/** The zone's UTC offset in minutes at `date` (e.g. +120 for CEST, -240 for EDT). */
export function utcOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Whole hours to rotate the UTC grid by. The server buckets whole UTC hours,
 * so a zone with a 30 or 45 minute offset (India +5:30, Nepal +5:45,
 * Newfoundland −3:30) is rounded to the nearest hour: its view is approximate,
 * off by up to half an hour. The current offset is used for all 28 days, so a
 * window that spans a DST change is off by an hour on one side of it.
 */
export function hourShift(offsetMinutes) {
  return Math.round(offsetMinutes / 60);
}

/** grid[dow][hour] in UTC -> the same counts at local (dow, hour). */
export function rotateGrid(grid, shift) {
  const out = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const slot = rotateSlot({ dow, hour, n: grid[dow]?.[hour] ?? 0 }, shift);
      out[slot.dow][slot.hour] += slot.n;
    }
  }
  return out;
}

export function rotateSlot(slot, shift) {
  const index = (((slot.dow * 24 + slot.hour + shift) % 168) + 168) % 168;
  return { dow: Math.floor(index / 24), hour: index % 24, n: slot.n };
}

/** Short zone name, e.g. "CEST" or "EDT"; falls back to "GMT+5:30" where no abbreviation exists. */
export function zoneLabel(timeZone, date) {
  let fallback = 'UTC';
  for (const locale of ['en-US', 'en-GB']) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
        .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value;
      if (!name) continue;
      if (!/^(GMT|UTC)/.test(name)) return name;
      fallback = name;
    } catch {
      // An unknown zone keeps the fallback.
    }
  }
  return fallback;
}

export function formatHour(hour, clock) {
  const h = ((hour % 24) + 24) % 24;
  if (clock === '12') return `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
  return `${String(h).padStart(2, '0')}:00`;
}

function joinList(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "Busiest: weekdays 16:00 to 18:00 your time." from the server's top UTC slots. */
export function peakSentence(peak, shift, clock) {
  if (!peak || peak.length === 0) return 'No games in the last 28 days yet.';
  const slots = peak.map((slot) => rotateSlot(slot, shift));
  const days = [...new Set(slots.map((s) => s.dow))].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
  let when;
  if (days.length === 1) when = DAY_PLURALS[days[0]];
  else if (days.every((d) => d >= 1 && d <= 5)) when = 'weekdays';
  else if (days.every((d) => d === 0 || d === 6)) when = 'weekends';
  else when = joinList(days.map((d) => DAY_PLURALS[d]));
  const hours = [...new Set(slots.map((s) => s.hour))].sort((a, b) => a - b);
  const first = hours[0];
  const last = hours.at(-1);
  const contiguous = last - first + 1 === hours.length;
  const span = contiguous
    ? `${formatHour(first, clock)} to ${formatHour(last + 1, clock)}`
    : `around ${joinList(hours.map((h) => formatHour(h, clock)))}`;
  return `Busiest: ${when} ${span} your time.`;
}

const HEAT_STOPS = [[0xf4, 0xec, 0xdc], [0xe0, 0xa6, 0x40], [0x6e, 0x35, 0x10]];

/** Light (no games) to dark (busiest): one warm hue, so the darkest cell is the busiest hour. */
export function heatColor(n, max) {
  if (!max || n <= 0) return 'rgb(244, 236, 220)';
  const t = Math.min(1, n / max);
  const [a, b, u] = t < 0.5 ? [HEAT_STOPS[0], HEAT_STOPS[1], t * 2] : [HEAT_STOPS[1], HEAT_STOPS[2], (t - 0.5) * 2];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * u)).join(', ')})`;
}

// ---------- render: pure (state) -> HTML ----------

export function renderHeader(state) {
  const { lens } = state;
  const scopeBtn = (value, label) => `<button type="button" class="${lens.scope === value ? 'on' : ''}" data-action="scope" data-value="${value}" aria-pressed="${lens.scope === value}">${label}</button>`;
  const rangeBtn = ([value, label]) => {
    const on = !lens.from && lens.range === value;
    return `<button type="button" class="chip${on ? ' on' : ''}" data-action="range" data-value="${value}" aria-pressed="${on}">${label}</button>`;
  };
  return `
    <div class="title">
      <h1>Unbrewed Telemetry</h1>
      <p class="sub">Live games only. Defaults: last 7 days, games with a human.</p>
    </div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Scope">${scopeBtn('human', 'Humans')}${scopeBtn('all', 'Everything')}</div>
      <div class="ranges" role="group" aria-label="Time range">${RANGES.map(rangeBtn).join('')}</div>
    </div>`;
}

export function renderPins(state) {
  const { lens, summary } = state;
  const pins = PIN_KEYS.filter((key) => lens[key]).map((key) => `
    <span class="pin"><span class="lab"><span>${PIN_KINDS[key]}</span>${esc(pinLabel(key, lens[key]))}</span><button type="button" class="x" data-action="unpin" data-key="${key}" aria-label="Unpin ${esc(PIN_KINDS[key])} ${esc(pinLabel(key, lens[key]))}">×</button></span>`).join('');
  return `
    <span class="h lenskey">Looking at</span>
    <span class="chip on static">${lens.scope === 'all' ? 'Everything' : 'Humans'}</span>
    <span class="chip on static">${esc(rangeLabel(lens, summary))}</span>
    ${pins}
    ${pins ? '<button type="button" class="link" data-action="clear">Clear all</button>' : '<span class="sub">Nothing pinned. Click any deck, bot or map to narrow the page.</span>'}`;
}

/** Whether UTC day `day` (YYYY-MM-DD) overlaps the served window. */
function dayInWindow(day, window) {
  if (!window) return false;
  const start = Date.parse(`${day}T00:00:00Z`);
  return start < Date.parse(window.to) && start + DAY_MS > Date.parse(window.from);
}

export function renderTimeline(state) {
  const days = state.summary?.timeline || [];
  const max = Math.max(1, ...days.map((d) => d.games));
  return days.map((d, i) => {
    const on = dayInWindow(d.day, state.summary.window);
    const height = 3 + (d.games / max) * 42;
    return `<button type="button" class="tl${on ? ' on' : ''}" data-index="${i}" data-day="${d.day}" aria-label="${esc(dayLabel(d.day))}: ${d.games} games"><i style="height:${height.toFixed(1)}px"></i></button>`;
  }).join('');
}

export function brushHint(state) {
  if (state.drag) return 'Release to show those days.';
  const days = state.summary?.timeline || [];
  const ends = days.length ? `${dayLabel(days[0].day)} – ${dayLabel(days.at(-1).day)} (UTC days). ` : '';
  if (state.lens.from) return `${ends}Showing ${rangeLabel(state.lens)}. Pick a range above to clear the selection.`;
  return `${ends}Drag across the bars to pick days, or click one day. Gold bars are inside the current range.`;
}

function delta(cur, prev, unit, hasPrev) {
  if (!hasPrev) return { text: 'no prior period', cls: 'flat' };
  if (cur === null || prev === null || cur === undefined || prev === undefined) return { text: '', cls: 'flat' };
  const d = cur - prev;
  const cls = Math.abs(d) < 1e-9 ? 'flat' : d > 0 ? 'up' : 'down';
  const sign = d >= 0 ? '+' : '−';
  if (unit === '%') return { text: prev ? `${sign}${Math.abs(Math.round((d / prev) * 100))}%` : `${sign}${Math.abs(d)}`, cls };
  if (unit === 'pts') return { text: `${sign}${Math.abs(d * 100).toFixed(1)} pts`, cls };
  return { text: `${sign}${Math.abs(Math.round(d))}`, cls };
}

function periodLabel(window) {
  const days = Math.round((Date.parse(window.to) - Date.parse(window.from)) / DAY_MS);
  if (days <= 1) return 'previous 24 hours';
  return `previous ${days} days`;
}

export function renderKpis(state) {
  const { summary: s, lens } = state;
  const k = s.kpis;
  const p = s.previous;
  const hasPrev = p.games > 0;
  const card = (label, value, d, note) => `
    <div class="kpi"><span class="klabel">${esc(label)}</span>
      <span class="kvalue"><span class="big">${esc(value)}</span><span class="mono delta ${d.cls}">${esc(d.text)}</span></span>
      <span class="sub">${esc(note)}</span></div>`;
  const cards = [
    card(lens.scope === 'all' ? 'Games' : 'Games with a human', String(k.games), delta(k.games, p.games, '%', hasPrev), `vs ${periodLabel(s.window)}`),
    card('Unique humans', String(k.uniqueHumans), delta(k.uniqueHumans, p.uniqueHumans, 'n', hasPrev), `${k.newHumans} not seen in the previous period`),
    card('Human win rate vs bots', pct(k.humanWinRateVsBots), delta(k.humanWinRateVsBots, p.humanWinRateVsBots, 'pts', hasPrev), 'human seats in games with a bot'),
    card('Median game', k.medianTurns === null ? '—' : `${k.medianTurns} turns`,
      { text: k.medianDurationSeconds === null ? '' : `${Math.round(k.medianDurationSeconds / 60)} min`, cls: 'flat' }, 'turns · minutes'),
    lens.scope === 'all'
      ? card('Bot-only games', String(k.botOnlyGames), delta(k.botOnlyGames, p.botOnlyGames, '%', hasPrev), 'no human seat')
      : card('Completion rate', k.games ? pct((k.games - k.endedEarly) / k.games) : '—',
        { text: `${k.endedEarly} left early`, cls: k.endedEarly ? 'down' : 'flat' }, 'forfeit, timeout or disconnect'),
  ];
  return cards.join('');
}

/** Win-rate scale for bars: 20%–80% across the track, 50% in the middle. */
const sc = (v) => Math.max(0, Math.min(100, ((v * 100 - 20) / 60) * 100));
const rateColor = (v) => (v === null ? 'var(--muted)' : v >= 0.55 ? 'var(--good)' : v <= 0.45 ? 'var(--bad)' : 'var(--ink)');

function bandBar(row, color) {
  if (row.winRate === null) return '<span class="bar"><u></u></span>';
  return `<span class="bar"><i style="left:${sc(row.lo).toFixed(1)}%;width:${(sc(row.hi) - sc(row.lo)).toFixed(1)}%;background:${color}"></i><b style="left:${sc(row.winRate).toFixed(1)}%;background:${color}"></b><u></u></span>`;
}

export function renderBots(state) {
  const { summary: s, lens, showRetired } = state;
  const current = s.bots.current.map((b) => `
    <button type="button" class="row${lens.bot === b.botId ? ' me' : ''}" data-action="pin" data-key="bot" data-value="${esc(b.botId)}" aria-label="Pin bot ${esc(b.botId)}">
      <span class="name">${esc(b.botId)} <span class="mono muted">${esc(b.botVersion ?? '')}</span></span>
      ${bandBar(b, 'var(--amber)')}
      <span class="mono num">${pct(b.winRate)} <span class="muted">· ${b.games} g</span></span>
    </button>`).join('');
  const retired = s.bots.retired;
  const retiredRows = showRetired ? `
    <div class="retired">${retired.rows.length ? retired.rows.map((b) => b.botVersion === null
      ? `<div class="row small"><span class="mono">${esc(b.botId)} (no version)</span><span class="mono">${b.games} g in range · ${pct(b.winRate)}</span></div>`
      : `<button type="button" class="row small" data-action="pin" data-key="ver" data-value="${esc(`${b.botId}:${b.botVersion}`)}" aria-label="Pin ${esc(b.botId)} ${esc(b.botVersion)}">
          <span class="mono">${esc(b.botId)} ${esc(b.botVersion)}</span><span class="mono">${b.games} g in range · ${pct(b.winRate)}</span></button>`).join('')
      : '<p class="sub">No retired version played in this range.</p>'}</div>` : '';
  return `
    <div class="phead"><p class="h">Humans vs bot tiers</p><span class="sub">human win rate · marker 50% · band 95%</span></div>
    ${current || '<p class="sub">No bot has played in the last 14 days.</p>'}
    ${retiredRows}
    <button type="button" class="link start" data-action="retired">${showRetired ? 'Hide retired versions' : `Retired versions (${retired.versions}) · ${retired.games} games in range`}</button>`;
}

export function renderMaps(state) {
  const { summary: s, lens } = state;
  const rows = s.maps.map((m) => {
    const v = m.firstPlayerEdge;
    const w = v === null ? 0 : Math.min(50, Math.abs(v - 0.5) * 400);
    const left = v === null || v >= 0.5 ? 50 : 50 - w;
    const color = v === null ? 'var(--muted)' : v >= 0.5 ? 'var(--amber)' : 'var(--blue)';
    return `
    <button type="button" class="row${lens.map === m.map ? ' me' : ''}" data-action="pin" data-key="map" data-value="${esc(m.map)}" aria-label="Pin map ${esc(mapName(m.map))}">
      <span class="name">${esc(mapName(m.map))}</span>
      <span class="bar tall"><i style="left:${left.toFixed(1)}%;width:${w.toFixed(1)}%;background:${color}"></i><u></u></span>
      <span class="mono num">${pct(v)} <span class="muted">· ${m.firstPlayerGames} g</span></span>
    </button>`;
  }).join('');
  return `
    <p class="h">First-player edge by map</p>
    <p class="sub">Win rate of whoever went first, over games that reported a first player. Click a map to pin it.</p>
    ${rows || '<p class="sub">No maps in this lens.</p>'}`;
}

export function renderDecks(state) {
  const { summary: s, lens } = state;
  const vsMode = s.decks.mode === 'vs';
  const key = vsMode ? 'vs' : 'deck';
  const rows = s.decks.rows.map((d) => {
    const color = rateColor(d.winRate);
    return `
    <button type="button" class="row${lens[key] === d.deck ? ' me' : ''}" data-action="pin" data-key="${key}" data-value="${esc(d.deck)}" aria-label="${vsMode ? 'Pin opponent' : 'Pin deck'} ${esc(deckName(d.deck))}">
      <span class="name strong">${esc(deckName(d.deck))}</span>
      ${bandBar(d, color)}
      <span class="mono num wide">${pct(d.winRate)} <span class="muted">· n ${d.games}</span>${d.flag ? ` <span class="flag ${d.flag === 'OVER' ? 'over' : 'under'}">${d.flag}</span>` : ''}</span>
    </button>`;
  }).join('');
  const title = vsMode ? `${deckName(s.decks.deck)} vs each opponent` : lens.player ? `${playerName(lens.player)}'s win rate per deck` : 'Deck win rate';
  const foot = vsMode
    ? `Only games where ${deckName(s.decks.deck)} faced that deck on the other team. Click an opponent to pin the pairing.`
    : lens.player ? `Only seats piloted by ${playerName(lens.player)}.` : 'Counts every seat in the lens, human- and bot-piloted. Click a deck to pin it.';
  return `
    <div class="phead"><p class="h">${esc(title)}</p><span class="sub">band 95% · flag when the band clears 45–55 and n ≥ 30</span></div>
    ${rows || '<p class="sub">No decks in this lens.</p>'}
    <p class="sub">${esc(foot)}</p>`;
}

function matrixCellColor(v) {
  if (v >= 0.5) return `rgba(126, 203, 143, ${Math.min(0.9, (v - 0.5) / 0.28 + 0.15).toFixed(2)})`;
  return `rgba(224, 121, 106, ${Math.min(0.9, (0.5 - v) / 0.28 + 0.15).toFixed(2)})`;
}

export function renderMatrix(state) {
  const { summary: s, lens } = state;
  const decks = s.matrix.decks;
  if (decks.length < 2) {
    return `<p class="h">Matchups</p><p class="sub">Needs at least two decks in the lens.</p>`;
  }
  const cells = new Map(s.matrix.cells.map((c) => [`${c.deck}\u0000${c.vs}`, c]));
  const short = (id) => deckName(id).slice(0, 7);
  let html = '<span class="cell head"></span>';
  for (const col of decks) html += `<button type="button" class="cell head" data-action="pin" data-key="deck" data-value="${esc(col)}" title="${esc(deckName(col))}" aria-label="Pin deck ${esc(deckName(col))}">${esc(short(col))}</button>`;
  for (const row of decks) {
    html += `<button type="button" class="cell head rowhead" data-action="pin" data-key="deck" data-value="${esc(row)}" title="${esc(deckName(row))}" aria-label="Pin deck ${esc(deckName(row))}">${esc(short(row))}</button>`;
    for (const col of decks) {
      if (row === col) { html += '<span class="cell same"></span>'; continue; }
      const c = cells.get(`${row}\u0000${col}`);
      const me = lens.deck === row && lens.vs === col ? ' me' : '';
      if (!c) {
        html += `<button type="button" class="cell thin${me}" data-action="pair" data-deck="${esc(row)}" data-vs="${esc(col)}" aria-label="${esc(deckName(row))} vs ${esc(deckName(col))}: under ${s.matrix.minGames} games">·</button>`;
        continue;
      }
      html += `<button type="button" class="cell${me}" style="background:${matrixCellColor(c.winRate)}" data-action="pair" data-deck="${esc(row)}" data-vs="${esc(col)}" title="${esc(deckName(row))} vs ${esc(deckName(col))}: ${Math.round(c.winRate * 100)}% over ${c.games} games" aria-label="${esc(deckName(row))} vs ${esc(deckName(col))}: ${Math.round(c.winRate * 100)}% over ${c.games} games">${Math.round(c.winRate * 100)}</button>`;
    }
  }
  return `
    <div class="phead"><p class="h">Matchups · row deck's win rate vs column deck</p><span class="sub">click a cell to pin both decks · “·” under ${s.matrix.minGames} games</span></div>
    <div class="mscroll"><div class="mgrid" style="grid-template-columns:minmax(64px,auto) repeat(${decks.length}, minmax(34px, 1fr))">${html}</div></div>`;
}

/** The viewer's zone; `state.timeZone` lets tests pin one. */
export function renderActivity(state) {
  const { activity, clock } = state;
  const now = state.now || new Date();
  const zone = zoneLabel(state.timeZone, now);
  const shift = hourShift(utcOffsetMinutes(state.timeZone, now));
  const clockBtn = (value) => `<button type="button" class="${clock === value ? 'on' : ''}" data-action="clock" data-value="${value}" aria-pressed="${clock === value}">${value}h</button>`;
  const head = `
    <div class="phead"><p class="h">When people play</p>
      <div class="seg small" role="group" aria-label="Clock">${clockBtn('24')}${clockBtn('12')}</div></div>`;
  if (state.activityError) return `${head}<p class="sub">Could not load activity: ${esc(state.activityError)}</p>`;
  if (!activity) return `${head}<p class="sub">Loading…</p>`;
  const grid = rotateGrid(activity.grid, shift);
  const max = Math.max(0, ...grid.flat());
  let cells = '<span></span>';
  for (let h = 0; h < 24; h++) cells += `<span class="hlab">${h % 6 === 0 ? esc(formatHour(h, clock)) : ''}</span>`;
  for (const dow of WEEK_ORDER) {
    cells += `<span class="dlab">${DAY_NAMES[dow]}</span>`;
    for (let h = 0; h < 24; h++) {
      const n = grid[dow][h];
      const label = `${DAY_NAMES[dow]} ${formatHour(h, clock)}–${formatHour(h + 1, clock)} your time: ${n} game${n === 1 ? '' : 's'}`;
      cells += `<span class="hcell" role="img" style="background:${heatColor(n, max)}" title="${esc(label)}" aria-label="${esc(label)}"></span>`;
    }
  }
  return `${head}
    <p class="peak">${esc(peakSentence(activity.peak, shift, clock))}</p>
    <div class="heat" aria-label="Games per hour of the week, your time (${esc(zone)})">${cells}</div>
    <div class="heatfoot sub">
      <span>Hours in your time (${esc(zone)})</span>
      <span class="legend">fewer <i></i> more</span>
    </div>
    <p class="sub note">All games with a human, last 28 days (${activity.total} games). The lens above does not change this panel.</p>`;
}

export function renderNotice(state) {
  const { summary, lens, error } = state;
  if (error) {
    if (error.code === 'BAD_LENS' && error.key) {
      return `<div class="panel notice"><p class="big2">This link has an invalid “${esc(error.key)}”.</p><p class="sub">${esc(error.message || '')}</p>
        <div class="outs"><button type="button" class="btn ghost" data-action="drop" data-key="${esc(error.key)}">Remove ${esc(error.key)}</button></div></div>`;
    }
    return `<div class="panel notice"><p class="big2">Could not load the dashboard.</p><p class="sub">${esc(error.message || '')}</p>
      <div class="outs"><button type="button" class="btn ghost" data-action="retry">Try again</button></div></div>`;
  }
  if (!summary) return '';
  if (summary.kpis.games === 0) {
    const outs = emptyOuts(lens);
    return `<div class="panel notice"><p class="big2">No games match this lens${lens.range === '7d' ? ', even over 30 days' : ''}.</p>
      ${outs.length
        ? `<p class="sub">Ways out, each removes one constraint:</p><div class="outs">${outs.map((o) => `<button type="button" class="btn ghost" data-action="${o.action}"${o.key ? ` data-key="${o.key}"` : ''}${o.value ? ` data-value="${o.value}"` : ''}>${esc(o.label)}</button>`).join('')}</div>`
        : '<p class="sub">No live games were recorded in this range.</p>'}</div>`;
  }
  if (summary.widened) return '<div class="widen sub">Last 7 days had no games for this lens, so the range was widened to 30 days automatically.</div>';
  return '';
}

export function legacyHref(lens, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  // The params the old page understands: deck opens its deck detail, format its format; map is carried along.
  for (const key of ['deck', 'map', 'format']) if (lens[key]) params.set(key, lens[key]);
  const query = params.toString();
  return `/legacy${query ? `?${query}` : ''}`;
}

export function renderLegacy(state) {
  const { lens } = state;
  const link = (href, label, main) => `<a href="${esc(href)}"${main ? ' class="main"' : ''}>${label}</a>`;
  return `
    <div class="strip"><span>Legacy views, unchanged:</span>
      ${link(legacyHref(lens), 'Balance dashboard', true)}
      ${link(legacyHref({ ...lens, deck: null }, { tab: 'matchups' }), 'Matchup matrix')}
      ${link(legacyHref({ ...lens, deck: null }, { tab: 'submissions' }), 'Submissions')}
      ${link('/fleet', 'Fleet')}${link('/road-to-expert', 'Road to Expert+')}${link('/admin', 'Admin')}
    </div>
    <p class="sub center">A game counts as “human” when any seat is human: one human against three bots is a human game. Every number counts live games only. The balance dashboard link carries the pinned deck, map and format.</p>`;
}

// ---------- browser: state, fetch, DOM ----------

function defaultClock() {
  try {
    const stored = localStorage.getItem(CLOCK_KEY);
    if (stored === '12' || stored === '24') return stored;
  } catch {
    // Storage can be unavailable; fall back to the locale.
  }
  const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h12' || cycle === 'h11' ? '12' : '24';
}

function boot() {
  const $ = (id) => document.getElementById(id);
  const state = {
    lens: parseLens(location.search),
    summary: null,
    error: null,
    loading: false,
    activity: null,
    activityError: null,
    clock: defaultClock(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    showRetired: false,
    drag: null,
  };
  let requestId = 0;

  function shareUrl() {
    return `${location.origin}/?${lensQuery(state.lens)}`;
  }

  function render() {
    $('header').innerHTML = renderHeader(state);
    $('pins').innerHTML = renderPins(state);
    $('story').textContent = storySentence(state.lens, state.summary);
    $('share').value = shareUrl();
    $('legacy').innerHTML = renderLegacy(state);
    $('notice').innerHTML = renderNotice(state);
    if (!state.drag) $('timeline').innerHTML = state.summary ? renderTimeline(state) : '';
    $('brush-hint').textContent = brushHint(state);
    const empty = !state.summary || state.summary.kpis.games === 0;
    document.body.classList.toggle('loading', state.loading);
    $('kpis').hidden = empty;
    for (const id of ['bots', 'maps', 'decks', 'matrix']) $(id).hidden = empty;
    if (!empty) {
      $('kpis').innerHTML = renderKpis(state);
      $('bots').innerHTML = renderBots(state);
      $('maps').innerHTML = renderMaps(state);
      $('decks').innerHTML = renderDecks(state);
      $('matrix').innerHTML = renderMatrix(state);
    }
    renderActivityPanel();
  }

  function renderActivityPanel() {
    $('activity').innerHTML = renderActivity(state);
  }

  async function load() {
    const id = ++requestId;
    state.loading = true;
    render();
    try {
      const response = await fetch(`/api/home/summary?${lensQuery(state.lens)}`, { headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (id !== requestId) return;
      if (!response.ok) {
        state.summary = null;
        state.error = { code: body.code, key: body.key, message: body.message || `HTTP ${response.status}` };
      } else {
        state.summary = body;
        state.error = null;
      }
    } catch (error) {
      if (id !== requestId) return;
      state.summary = null;
      state.error = { message: error instanceof Error ? error.message : String(error) };
    }
    state.loading = false;
    render();
  }

  async function loadActivity() {
    try {
      const response = await fetch('/api/home/activity?scope=human', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.activity = await response.json();
    } catch (error) {
      state.activityError = error instanceof Error ? error.message : String(error);
    }
    renderActivityPanel();
  }

  function setLens(next) {
    state.lens = next;
    history.replaceState(null, '', `${location.pathname}?${lensQuery(next)}`);
    load();
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const { action, key, value } = target.dataset;
    const lens = state.lens;
    if (action === 'scope') setLens({ ...lens, scope: value });
    else if (action === 'range') setLens(withRange(lens, value));
    else if (action === 'pin') setLens(withPin(lens, key, value));
    else if (action === 'pair') setLens({ ...lens, deck: target.dataset.deck, vs: target.dataset.vs });
    else if (action === 'unpin') setLens({ ...lens, [key]: null });
    else if (action === 'clear') setLens({ ...lens, ...Object.fromEntries(PIN_KEYS.map((k) => [k, null])) });
    else if (action === 'drop') setLens(key === 'from' || key === 'to' || key === 'range' ? withRange(lens, '7d') : { ...lens, [key]: key === 'scope' ? 'human' : null });
    else if (action === 'retry') load();
    else if (action === 'retired') { state.showRetired = !state.showRetired; render(); }
    else if (action === 'clock') {
      state.clock = value;
      try { localStorage.setItem(CLOCK_KEY, value); } catch { /* per-viewer convenience only */ }
      renderActivityPanel();
    } else if (action === 'copy') copyLink(target);
  });

  async function copyLink(button) {
    try {
      await navigator.clipboard.writeText(shareUrl());
      button.textContent = 'Copied';
    } catch {
      $('share').select();
      button.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { button.textContent = 'Copy link'; }, 1500);
  }

  // Date brush: pointer-drag across the timeline bars; a click (or Enter) picks one day.
  const timeline = $('timeline');
  const barIndex = (event) => {
    const bars = timeline.querySelectorAll('.tl');
    if (!bars.length) return null;
    const rect = timeline.getBoundingClientRect();
    const i = Math.floor(((event.clientX - rect.left) / rect.width) * bars.length);
    return Math.max(0, Math.min(bars.length - 1, i));
  };
  const paintDrag = () => {
    const lo = Math.min(state.drag.anchor, state.drag.current);
    const hi = Math.max(state.drag.anchor, state.drag.current);
    timeline.querySelectorAll('.tl').forEach((bar, i) => bar.classList.toggle('sel', i >= lo && i <= hi));
  };
  timeline.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state.summary) return;
    const i = barIndex(event);
    if (i === null) return;
    event.preventDefault();
    timeline.setPointerCapture(event.pointerId);
    state.drag = { anchor: i, current: i };
    timeline.classList.add('dragging');
    paintDrag();
    $('brush-hint').textContent = brushHint(state);
  });
  timeline.addEventListener('pointermove', (event) => {
    if (!state.drag) return;
    const i = barIndex(event);
    if (i !== null && i !== state.drag.current) { state.drag.current = i; paintDrag(); }
  });
  const endDrag = (commit) => {
    if (!state.drag) return;
    const lo = Math.min(state.drag.anchor, state.drag.current);
    const hi = Math.max(state.drag.anchor, state.drag.current);
    state.drag = null;
    timeline.classList.remove('dragging');
    const days = state.summary?.timeline || [];
    if (commit && days[lo] && days[hi]) setLens(withDays(state.lens, days[lo].day, days[hi].day));
    else render();
  };
  timeline.addEventListener('pointerup', () => endDrag(true));
  timeline.addEventListener('pointercancel', () => endDrag(false));
  timeline.addEventListener('click', (event) => {
    // Pointer clicks were handled by the drag; keyboard activation arrives with detail 0.
    const bar = event.target instanceof Element ? event.target.closest('.tl') : null;
    if (!bar || event.detail !== 0) return;
    setLens(withDays(state.lens, bar.dataset.day, bar.dataset.day));
  });

  history.replaceState(null, '', `${location.pathname}?${lensQuery(state.lens)}`);
  load();
  loadActivity();
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();

// Unbrewed Balance Dashboard.
// Plain ES module, no build step. Renders the balance views defined in
// MockDashboard/Balance Dashboard.dc.html against the live /v1/stats API.

const COLORS = {
  text: '#f2ead9',
  muted: '#b9a5c0',
  green: '#7ecb8f',
  red: '#e0796a',
  blue: '#7aa3d4',
  violet: '#a78bc9',
  gold: '#d4ab4f',
  overCi: 'rgba(224, 121, 106, 0.55)',
  underCi: 'rgba(122, 157, 208, 0.55)',
  neutralCi: 'rgba(255, 255, 255, 0.3)',
};

// Balance-flag rules mirror the design mock's defaults.
const FLAG_THRESHOLD = 0.55;
const FLAG_MIN_GAMES = 30;
const MATRIX_MIN_GAMES = 3;
const MATRIX_MAX_DECKS = 30;
const DEFAULT_EXCLUDED_PILOTS = new Set(['bot:easy']);

const TABS = [
  ['overview', 'Overview'],
  ['heroes', 'Heroes'],
  ['matchups', 'Matchups'],
  ['scatter', 'Pick vs Win'],
  ['formats', 'Formats'],
  ['synergy', '2v2 Synergy'],
  ['scenario', 'Scenario'],
  ['recent', 'Recents'],
];

// Card-context bucket presentation for the influence table.
const BUCKET_META = {
  attack: { tag: 'ATK', color: '#d9705c' },
  defense: { tag: 'DEF', color: '#7aa3d4' },
  scheme: { tag: 'SCH', color: '#a78bc9' },
  boost: { tag: 'BST', color: '#d4ab4f' },
  discard: { tag: 'DSC', color: '#9d87a6' },
  other: { tag: '—', color: '#9d87a6' },
};

const TWO_V_TWO_MODE_KEY = 'unbrewed.twoVTwoPartnerMode';
const CARD_INFLUENCE_MODE_KEY = 'unbrewed.cardInfluenceMode';
const state = readStateFromUrl();
const sort = { key: 'wr', dir: -1 };

const els = {
  heroTotal: document.querySelector('#hero-total'),
  heroSubtitle: document.querySelector('#hero-subtitle'),
  formatChips: document.querySelector('#format-chips'),
  pilotChips: document.querySelector('#pilot-chips'),
  tabs: document.querySelector('#tabs'),
  status: document.querySelector('#status'),
  view: document.querySelector('#view'),
  modalRoot: document.querySelector('#modal-root'),
};

let cardInfluenceMode = readStoredCardInfluenceMode();
let twoVTwoMode = readStoredTwoVTwoMode();
let current = null;
let allPilots = [];
let matrixFocus = null; // full deck id of the focused row on the Matchups tab, or null for the grid
let matrixMetric = 'wr'; // 'wr' | 'games' — what the matrix cells display
let matrixSampleTarget = 50; // games needed for full-confidence color in 'games' mode
// Very short client cache so toggling filters back and forth is instant without
// hammering the (multi-query) dashboard endpoint. Data still refreshes within TTL.
const dashCache = new Map();
const DASH_TTL_MS = 15000;

renderTabs();
loadDashboard().catch(showError);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

// ---------- state / url ----------
function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const hasExplicitExclusions = params.has('exclude');
  const exclude = params.get('exclude');
  return {
    tab: params.get('tab') || 'overview',
    format: normalizedParam(params.get('format')),
    excluded: new Set(exclude ? exclude.split(',').map((v) => v.trim()).filter(Boolean) : []),
    hasExplicitExclusions,
    deck: params.get('deck') || null,
    pair: params.get('pair') || null,
    scenario: {
      format: normalizedParam(params.get('scFormat')),
      map: normalizedParam(params.get('scMap')),
      deck: params.get('scDeck') || null,
      partner: params.get('scPartner') || null,
      enemyA: params.get('scEnemyA') || null,
      enemyB: params.get('scEnemyB') || null,
    },
  };
}

function writeStateToUrl() {
  const params = new URLSearchParams();
  if (state.tab !== 'overview') params.set('tab', state.tab);
  if (state.format) params.set('format', state.format);
  if (state.excluded.size) params.set('exclude', [...state.excluded].join(','));
  if (state.deck) params.set('deck', state.deck);
  if (state.pair) params.set('pair', state.pair);
  if (state.scenario?.format) params.set('scFormat', state.scenario.format);
  if (state.scenario?.map) params.set('scMap', state.scenario.map);
  if (state.scenario?.deck) params.set('scDeck', state.scenario.deck);
  if (state.scenario?.partner) params.set('scPartner', state.scenario.partner);
  if (state.scenario?.enemyA) params.set('scEnemyA', state.scenario.enemyA);
  if (state.scenario?.enemyB) params.set('scEnemyB', state.scenario.enemyB);
  const next = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
  history.replaceState(null, '', next);
}

function normalizedParam(value) {
  if (!value || value === 'all') return null;
  return value;
}

function readStoredCardInfluenceMode() {
  try {
    return localStorage.getItem(CARD_INFLUENCE_MODE_KEY) === 'starting' ? 'starting' : 'played';
  } catch {
    return 'played';
  }
}

function setCardInfluenceMode(mode) {
  cardInfluenceMode = mode === 'starting' ? 'starting' : 'played';
  try { localStorage.setItem(CARD_INFLUENCE_MODE_KEY, cardInfluenceMode); } catch {}
  renderDeckPage().catch(showError);
}

function readStoredTwoVTwoMode() {
  try {
    return localStorage.getItem(TWO_V_TWO_MODE_KEY) === 'adjusted' ? 'adjusted' : 'raw';
  } catch {
    return 'raw';
  }
}

function setTwoVTwoMode(mode, summary) {
  twoVTwoMode = mode === 'adjusted' ? 'adjusted' : 'raw';
  try { localStorage.setItem(TWO_V_TWO_MODE_KEY, twoVTwoMode); } catch {}
  const section = els.view.querySelector('[data-two-v-two-section]');
  if (section) {
    section.outerHTML = twoVTwoSection(summary);
    bindHandlers(els.view);
  }
}

// Pilots to send to the API: the set that is *not* excluded. Empty = no filter.
function includedPilots() {
  if (!state.excluded.size) return [];
  return allPilots.filter((pilot) => !state.excluded.has(pilot));
}

function applyDefaultPilotExclusions() {
  if (state.hasExplicitExclusions) return false;
  state.hasExplicitExclusions = true;
  let changed = false;
  for (const pilot of DEFAULT_EXCLUDED_PILOTS) {
    if (allPilots.includes(pilot) && !state.excluded.has(pilot)) {
      state.excluded.add(pilot);
      changed = true;
    }
  }
  return changed;
}

function statsQuery() {
  const params = new URLSearchParams();
  if (state.format) params.set('format', state.format);
  const pilots = includedPilots();
  if (pilots.length) params.set('pilots', pilots.join(','));
  return params;
}

// ---------- data loading ----------
async function loadDashboard() {
  setStatus('Loading telemetry…');
  const params = statsQuery();
  const key = params.toString();
  const cached = dashCache.get(key);
  let json;
  if (cached && Date.now() - cached.at < DASH_TTL_MS) {
    json = cached.json;
  } else {
    json = await fetchJson(`/v1/stats/dashboard${key ? `?${key}` : ''}`);
    dashCache.set(key, { at: Date.now(), json });
  }
  if (allPilots.length === 0) {
    allPilots = (json.pilots || []).map((row) => row.pilot);
    if (applyDefaultPilotExclusions()) {
      writeStateToUrl();
      await loadDashboard();
      return;
    }
  }
  current = json;
  els.heroTotal.textContent = number(json.totalGames);
  const fp = json.firstPlayer && json.firstPlayer.winRate != null ? ` · first player ${pct(json.firstPlayer.winRate, 0)}` : '';
  els.heroSubtitle.innerHTML = `<span class="sub"> · ${number(json.totalSubmissions)} submissions, ${number(json.invalidSubmissions)} invalid${esc(fp)}</span>`;
  renderControls(json);
  renderTabs();
  renderView(json); // routes to the deck page when state.deck is set
  clearStatus();
  if (state.pair && !els.modalRoot.hasChildNodes()) {
    const [a, b] = state.pair.split('|');
    if (a && b) openPair(a, b);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.message || json.code || 'Request failed');
  return json;
}

// ---------- controls ----------
function renderControls(data) {
  const formats = data.formats || [];
  els.formatChips.innerHTML = [chip('All formats', !state.format, () => setFormat(null))]
    .concat(formats.map((f) => chip(f.label, state.format === f.format, () => setFormat(f.format))))
    .join('');
  bindHandlers(els.formatChips);

  const pilots = pilotOptions(data.pilots || []);
  els.pilotChips.innerHTML = pilots.map((pilot) => {
    const off = state.excluded.has(pilot.value);
    const id = registerHandler(() => togglePilot(pilot.value));
    const title = off
      ? 'Excluded — games with this pilot type are hidden. Click to include.'
      : 'Included. Click to exclude games with this pilot type.';
    return `<button class="pilot-chip${off ? ' off' : ''}" data-handler="${id}" type="button" title="${esc(title)}">${esc(pilot.label)}</button>`;
  }).join('');
  bindHandlers(els.pilotChips);
}

function pilotOptions(rows) {
  return rows.map((row) => ({ value: row.pilot, label: pilotLabel(row.pilot), seats: row.seats }));
}

function pilotLabel(pilot) {
  if (pilot === 'human') return 'Human';
  if (pilot.startsWith('bot:')) return `Bot: ${titleCase(pilot.slice(4))}`;
  return pilot;
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function setFormat(format) {
  state.format = format;
  writeStateToUrl();
  loadDashboard().catch(showError);
}

function togglePilot(pilot) {
  if (state.excluded.has(pilot)) state.excluded.delete(pilot);
  else state.excluded.add(pilot);
  writeStateToUrl();
  loadDashboard().catch(showError);
}

function renderTabs() {
  els.tabs.innerHTML = TABS.map(([key, label]) =>
    `<button class="tab${state.tab === key ? ' active' : ''}" data-tab="${key}" type="button">${esc(label)}</button>`,
  ).join('');
  els.tabs.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      state.deck = null; // leaving the full-page deck view
      state.pair = null;
      writeStateToUrl();
      renderTabs();
      if (current) renderView(current);
    });
  });
}

// ---------- view routing ----------
function renderView(data) {
  if (state.deck) { renderDeckPage(); return; }
  if (data.totalGames === 0) {
    els.view.innerHTML = card(empty('No completed games match these filters yet. Submit sample data or run local simulations to populate the dashboard.'));
    return;
  }
  if (state.tab !== 'matchups') matrixFocus = null;
  if (state.tab === 'recent') { renderRecent(); return; }
  const decks = decorateDecks(data.decks);
  if (state.tab === 'heroes') renderHeroes(data, decks);
  else if (state.tab === 'matchups') renderMatchups(data, decks);
  else if (state.tab === 'scatter') renderScatter(data, decks);
  else if (state.tab === 'formats') renderFormats(data);
  else if (state.tab === 'synergy') renderSynergy(data);
  else if (state.tab === 'scenario') { renderScenario(data); return; }
  else renderOverview(data, decks);
  bindHandlers(els.view);
}

// Attach balance-flag classification to each deck once, shared across views.
function decorateDecks(decks) {
  return decks.map((deck) => {
    let flag = null;
    if (deck.games >= FLAG_MIN_GAMES) {
      if (deck.ciLow > FLAG_THRESHOLD) flag = 'over';
      else if (deck.ciHigh < 1 - FLAG_THRESHOLD) flag = 'under';
    }
    return { ...deck, flag };
  });
}

// ---------- overview ----------
function renderOverview(data, decks) {
  const flags = decks
    .filter((deck) => deck.flag)
    .sort((a, b) => Math.abs(b.winRate - 0.5) - Math.abs(a.winRate - 0.5));
  const eligible = decks.filter((deck) => deck.games >= 15).sort((a, b) => b.winRate - a.winRate);
  const extremes = eligible.length > 6
    ? [...eligible.slice(0, 3), ...eligible.slice(-3)]
    : eligible;

  const fp = data.firstPlayer || {};
  const fpWr = fp.winRate;
  const fpColor = fpWr == null ? COLORS.text : Math.abs(fpWr - 0.5) > 0.05 ? '#e89286' : COLORS.green;
  const fpSub = fpWr == null ? 'no first-player data yet' : `${signedPct(fpWr - 0.5)} edge · ${number(fp.games || 0)} games`;

  els.view.innerHTML = `
    <div class="stat-cards">
      ${statCard('Games (' + esc(selectedFormatLabel(data)) + ')', number(data.totalGames), pilotSummary(), COLORS.text)}
      ${statCard('Decks tracked', number(decks.length), 'active in this pool', COLORS.text)}
      ${statCard('Avg game length', data.avgTurns == null ? 'n/a' : data.avgTurns.toFixed(1), 'turns per game', COLORS.text)}
      ${statCard('First player', fpWr == null ? 'n/a' : pct(fpWr), fpSub, fpColor)}
      ${statCard('Balance flags', String(flags.length), 'outside CI threshold', flags.length ? '#e89286' : COLORS.green)}
    </div>
    <div class="two-col">
      <div class="card panel">
        <div class="section-head">
          <div class="section-title">Balance flags</div>
          <div class="kicker">95% CI beyond ${Math.round(FLAG_THRESHOLD * 100)}% / ${Math.round((1 - FLAG_THRESHOLD) * 100)}% · min ${FLAG_MIN_GAMES} games</div>
        </div>
        ${flags.length
          ? `<div class="list">${flags.map(flagRow).join('')}</div>`
          : `<div class="empty" style="margin-top:12px">No decks outside the flag threshold in this view. Looking healthy.</div>`}
      </div>
      <div class="card panel">
        <div class="section-title">Win-rate extremes</div>
        <div class="list tight">${extremes.length ? extremes.map(extremeRow).join('') : empty('No deck stats available yet.')}</div>
      </div>
    </div>`;
}

function flagRow(deck) {
  return `<div class="flag" ${deckClick(deck)}>
    <span class="badge ${deck.flag}">${deck.flag === 'over' ? 'OVER' : 'UNDER'}</span>
    <span class="flag-name">${labelHtml(deck.label, deck.deckId)}</span>
    <span class="flag-games">${number(deck.games)} games</span>
    <span class="mono" style="color:${wrColor(deck.winRate)}">${pct(deck.winRate)}</span>
    <span class="flag-ci">CI ${pct(deck.ciLow, 0)}–${pct(deck.ciHigh, 0)}</span>
  </div>`;
}

function extremeRow(deck) {
  const w = Math.round(deck.winRate * 100);
  return `<div class="extreme" ${deckClick(deck)}>
    <span class="name">${labelHtml(deck.label, deck.deckId)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${deck.winRate >= 0.5 ? COLORS.green : COLORS.red}"></span></span>
    <span class="wr" style="color:${wrColor(deck.winRate)}">${pct(deck.winRate)}</span>
  </div>`;
}

// ---------- heroes table ----------
function renderHeroes(data, decks) {
  const rows = sortDecks(decks);
  const header = `<div class="deck-grid deck-head">
    ${sortHeader('name', 'Hero')}
    ${sortHeader('games', 'Games', true)}
    ${sortHeader('pick', 'Pick rate', true)}
    ${sortHeader('wr', 'Win rate · 95% CI (25–75% scale)')}
    <span class="th-btn" style="cursor:default">Deck profile</span>
  </div>`;
  els.view.innerHTML = `<div class="card">
    ${header}
    ${rows.map(deckRow).join('')}
    <div class="legend">
      ${legendSwatch('#d9705c', 'Attack')}
      ${legendSwatch('#7aa3d4', 'Defense')}
      ${legendSwatch('#d4ab4f', 'Boost / other')}
      ${legendSwatch('#a78bc9', 'Scheme')}
      <span class="legend-spacer">Profile = how the deck spends its cards · click a deck for full detail</span>
    </div>
  </div>`;
}

function sortHeader(key, label, right = false) {
  const arrow = sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '';
  const id = registerHandler(() => setSort(key));
  return `<button class="th-btn${right ? ' right' : ''}" data-handler="${id}" type="button">${esc(label)}${arrow}</button>`;
}

function setSort(key) {
  if (sort.key === key) sort.dir = -sort.dir;
  else { sort.key = key; sort.dir = key === 'name' ? 1 : -1; }
  if (current) { renderView(current); }
}

function sortDecks(decks) {
  const { key, dir } = sort;
  return [...decks].sort((a, b) => {
    const v = key === 'name' ? a.label.localeCompare(b.label)
      : key === 'games' ? a.games - b.games
      : key === 'pick' ? a.pickRate - b.pickRate
      : a.winRate - b.winRate;
    return v * dir;
  });
}

function deckRow(deck) {
  return `<div class="deck-grid deck-row" ${deckClick(deck)}>
    <div><div class="deck-name">${labelHtml(deck.label, deck.deckId)}</div><div class="deck-tag">${esc(deckTag(deck))}</div></div>
    <div class="num">${number(deck.games)}</div>
    <div class="num">${pct(deck.pickRate)}</div>
    ${ciCell(deck)}
    ${profileBar(deck)}
  </div>`;
}

function deckTag(deck) {
  const lean = (deck.composition && deck.composition.lean) || (deck.profile && deck.profile.lean);
  return lean ? `${deck.deckId} · ${lean}` : deck.deckId;
}

function ciCell(deck) {
  const left = scaleCi(deck.ciLow);
  const width = Math.max(1.5, scaleCi(deck.ciHigh) - left);
  const dot = scaleCi(deck.winRate);
  const band = deck.flag === 'over' ? COLORS.overCi : deck.flag === 'under' ? COLORS.underCi : COLORS.neutralCi;
  const color = wrColor(deck.winRate);
  const title = `Win rate ${pct(deck.winRate)} · 95% CI ${pct(deck.ciLow, 0)}–${pct(deck.ciHigh, 0)} · ${number(deck.games)} games`;
  return `<div class="ci-cell" title="${esc(title)}">
    <div class="ci-bar">
      <div class="ci-track"></div>
      <div class="ci-mid"></div>
      <div class="ci-band" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;background:${band}"></div>
      <div class="ci-dot" style="left:${dot.toFixed(1)}%;background:${color}"></div>
    </div>
    <div class="ci-num" style="color:${color}">${pct(deck.winRate)}</div>
  </div>`;
}

// Prefer the authoritative registry composition (real card counts); fall back
// to the play-derived profile. Returns attack/defense/versatile/scheme shares.
function profileSegments(deck) {
  const c = deck.composition;
  if (c && c.cardCount > 0) {
    const total = c.cardCount;
    return {
      attack: c.attack / total, defense: c.defense / total, versatile: c.versatile / total, scheme: c.scheme / total,
      title: `Attack ${c.attack} · Defense ${c.defense} · Versatile ${c.versatile} · Scheme ${c.scheme} (${total} cards)`,
    };
  }
  const p = deck.profile;
  if (p) {
    return {
      attack: p.attack, defense: p.defense, versatile: p.boost + p.other, scheme: p.scheme,
      title: `Play mix — Attack ${pct(p.attack, 0)} · Defense ${pct(p.defense, 0)} · Boost/other ${pct(p.boost + p.other, 0)} · Scheme ${pct(p.scheme, 0)}`,
    };
  }
  return null;
}

function profileBar(deck) {
  const s = profileSegments(deck);
  if (!s) return `<div class="profile-none">no card data</div>`;
  const seg = (share, color) => `<span style="width:${(share * 100).toFixed(1)}%;background:${color}"></span>`;
  return `<div class="profile-bar" title="${esc(s.title)}">
    ${seg(s.attack, '#d9705c')}${seg(s.defense, '#7aa3d4')}${seg(s.versatile, '#d4ab4f')}${seg(s.scheme, '#a78bc9')}
  </div>`;
}

// ---------- matchups ----------
function renderMatchups(data, decks) {
  const withGames = decks.filter((deck) => deck.games > 0);
  if (withGames.length < 2) {
    els.view.innerHTML = card(empty('Need at least two decks with duel games for a matchup matrix.'), 'panel');
    return;
  }
  if (matrixFocus && withGames.some((deck) => deck.deck === matrixFocus)) {
    renderMatchupFocus(data, decks);
    return;
  }
  matrixFocus = null;

  const top = withGames.slice(0, MATRIX_MAX_DECKS);
  const lookup = new Map((data.matchups || []).map((row) => [`${row.rowDeck}|${row.colDeck}`, row]));
  const cols = `<div class="matrix-line"><div class="matrix-corner"></div>${top.map((d) => `<div class="matrix-colhead" title="${esc(d.label)}${isSpice(d.deckId) ? ' (spice)' : ''}">${esc(code(d.deckId))}</div>`).join('')}</div>`;
  const rows = top.map((rowDeck) => {
    const cells = top.map((colDeck) => matrixCell(rowDeck, colDeck, lookup)).join('');
    const id = registerHandler(() => focusMatchup(rowDeck.deck));
    return `<div class="matrix-line"><div class="matrix-rowlabel" data-handler="${id}" title="Focus ${esc(rowDeck.label)}${isSpice(rowDeck.deckId) ? ' (spice)' : ''}">${labelHtml(rowDeck.label, rowDeck.deckId)}</div>${cells}</div>`;
  }).join('');

  const wrId = registerHandler(() => { matrixMetric = 'wr'; if (current) renderView(current); });
  const gamesId = registerHandler(() => { matrixMetric = 'games'; if (current) renderView(current); });
  const kicker = matrixMetric === 'games'
    ? `Games played per matchup · red → green by sample size (target ${matrixSampleTarget})`
    : `Row deck win rate vs column deck · green favors row · min ${MATRIX_MIN_GAMES} games (· = not enough data)`;
  const legend = matrixMetric === 'games'
    ? `${legendSwatch(sampleColor(0.1), 'Few games')}${legendSwatch(sampleColor(0.5), 'Partial')}${legendSwatch(sampleColor(1), '≥ target')}`
    : `${legendSwatch('rgba(224,121,106,0.65)', 'Row loses')}${legendSwatch('rgba(255,255,255,0.1)', 'Even')}${legendSwatch('rgba(126,203,143,0.65)', 'Row wins')}`;
  const legendEnd = top.length < withGames.length
    ? `Showing top ${top.length} of ${withGames.length} decks by games · click a row to focus`
    : `Click a row to focus that deck's matchups`;

  els.view.innerHTML = `<div class="card panel">
    <div class="section-head">
      <div class="section-title">1v1 Matchup Matrix</div>
      <div class="kicker">${kicker}</div>
    </div>
    <div class="mx-controls">
      <span class="mx-ctrl-label">Cells</span>
      <button class="syn-tab${matrixMetric === 'wr' ? ' active' : ''}" data-handler="${wrId}" type="button">Win rate</button>
      <button class="syn-tab${matrixMetric === 'games' ? ' active' : ''}" data-handler="${gamesId}" type="button">Games played</button>
      ${matrixMetric === 'games' ? `
      <span class="mx-ctrl-label" style="margin-left:14px">Sample target</span>
      <input class="mx-sample" type="number" min="1" step="5" value="${matrixSampleTarget}" title="Games needed for full-confidence color" aria-label="Sample target in games">
      <span class="mx-ctrl-hint">games</span>` : ''}
    </div>
    <div class="matrix-scroll"><div class="matrix-inner">${cols}${rows}</div></div>
    <div class="legend">
      ${legend}
      <span class="legend-spacer">${legendEnd}</span>
    </div>
  </div>`;

  const input = els.view.querySelector('.mx-sample');
  if (input) {
    input.addEventListener('change', () => {
      matrixSampleTarget = Math.max(1, Math.floor(Number(input.value) || matrixSampleTarget));
      if (current) renderView(current);
    });
  }
}

function focusMatchup(deckFull) {
  matrixFocus = deckFull;
  if (current) renderView(current);
}

// Focused, transposed view: one deck vs each opponent, full names down a single
// column with win rate, favorability bar, record, and average game length.
function renderMatchupFocus(data, decks) {
  const deck = decks.find((d) => d.deck === matrixFocus);
  const deckName = deck ? labelHtml(deck.label, deck.deckId) : esc(matrixFocus);
  const deckPlain = deck ? deck.label : matrixFocus;
  const opponents = (data.matchups || [])
    .filter((m) => m.rowDeck === matrixFocus)
    .map((m) => ({ deck: m.colDeck, deckId: m.colDeckId, games: m.games, wins: m.wins, winRate: m.winRate, avgTurns: m.avgTurns, avgFinalHealth: m.avgFinalHealth, avgCardsLeft: m.avgCardsLeft }))
    .sort((a, b) => b.winRate - a.winRate || b.games - a.games);

  const backId = registerHandler(() => { matrixFocus = null; if (current) renderView(current); });

  const oppRow = (o) => {
    const losses = o.games - o.wins;
    const good = o.winRate >= 0.5;
    const fill = good
      ? `<span class="mx-fill" style="left:50%;width:${((o.winRate - 0.5) * 100).toFixed(1)}%;background:${COLORS.green}"></span>`
      : `<span class="mx-fill" style="left:${(o.winRate * 100).toFixed(1)}%;width:${((0.5 - o.winRate) * 100).toFixed(1)}%;background:${COLORS.red}"></span>`;
    const id = registerHandler(() => focusMatchup(o.deck));
    const low = o.games < MATRIX_MIN_GAMES ? ' mx-low' : '';
    return `<div class="mx-row${low}" data-handler="${id}" title="${esc(deckPlain)} vs ${esc(labelForDeckId(o.deckId))}: ${o.wins}-${losses} over ${number(o.games)} games">
      <span class="mx-name">${labelHtml(labelForDeckId(o.deckId), o.deckId)}</span>
      <span class="mx-bar"><span class="mx-mid"></span>${fill}</span>
      <span class="mx-wr" style="color:${wrColor(o.winRate)}">${pct(o.winRate, 0)}</span>
      <span class="mx-rec">${o.wins}-${losses}</span>
      <span class="mx-turns">${o.avgTurns == null ? '—' : o.avgTurns.toFixed(1)}</span>
      <span class="mx-hp">${o.avgFinalHealth == null ? '—' : o.avgFinalHealth.toFixed(1)}</span>
      <span class="mx-cards">${o.avgCardsLeft == null ? '—' : o.avgCardsLeft.toFixed(1)}</span>
    </div>`;
  };

  els.view.innerHTML = `<div class="card panel">
    <div class="section-head">
      <div>
        <button class="mx-back" data-handler="${backId}" type="button">◀ All matchups</button>
        <div class="section-title" style="margin-top:10px">${deckName}<span class="kicker" style="text-transform:none;letter-spacing:0;margin-left:8px">1v1 vs each opponent</span></div>
        ${deck ? `<div class="mx-focus-summary">
          <span class="mx-focus-wr" style="color:${wrColor(deck.winRate)}">${pct(deck.winRate)}</span>
          <span class="mx-focus-meta">${number(deck.wins)}–${number(deck.games - deck.wins)} · ${number(deck.games)} games · 95% CI ${pct(deck.ciLow, 0)}–${pct(deck.ciHigh, 0)}</span>
        </div>` : ''}
      </div>
      <div class="kicker">Bar diverges from 50% · green favors ${esc(deckPlain)} · faded rows are under ${MATRIX_MIN_GAMES} games</div>
    </div>
    <div class="mx-list">
      <div class="mx-row mx-headrow">
        <span class="mx-name">Opponent</span>
        <span class="mx-legend">← opponent favored · ${esc(deckPlain)} favored →</span>
        <span class="mx-wr">Win</span>
        <span class="mx-rec">W–L</span>
        <span class="mx-turns">Turns</span>
        <span class="mx-hp">HP left</span>
        <span class="mx-cards">Cards</span>
      </div>
      ${opponents.length ? opponents.map(oppRow).join('') : empty('No 1v1 opponents with data for this deck under the current filters.')}
    </div>
  </div>`;
}

function matrixCell(rowDeck, colDeck, lookup) {
  if (rowDeck.deck === colDeck.deck) {
    return `<div class="matrix-cell" style="background:transparent"></div>`;
  }
  const row = lookup.get(`${rowDeck.deck}|${colDeck.deck}`);
  const games = row ? row.games : 0;
  const title = `${esc(rowDeck.label)} vs ${esc(colDeck.label)}`;

  if (matrixMetric === 'games') {
    if (games === 0) {
      return `<div class="matrix-cell" style="background:rgba(255,255,255,0.03);color:#6d5a76" title="${title}: 0 games">·</div>`;
    }
    const ratio = clamp(games / matrixSampleTarget, 0, 1);
    return `<div class="matrix-cell" style="background:${sampleColor(ratio)}" title="${title}: ${number(games)} of ${matrixSampleTarget} target games (${pct(ratio, 0)})">${number(games)}</div>`;
  }

  if (!row || games < MATRIX_MIN_GAMES) {
    return `<div class="matrix-cell" style="background:rgba(255,255,255,0.03);color:#6d5a76" title="${title}: ${games} games (min ${MATRIX_MIN_GAMES})">·</div>`;
  }
  const alpha = clamp(Math.abs(row.winRate - 0.5) * 2.2, 0.1, 0.75).toFixed(2);
  const bg = row.winRate >= 0.5 ? `rgba(126,203,143,${alpha})` : `rgba(224,121,106,${alpha})`;
  return `<div class="matrix-cell" style="background:${bg}" title="${title}: ${pct(row.winRate, 0)} over ${number(games)} games">${Math.round(row.winRate * 100)}</div>`;
}

// Red (few samples) → amber → green (>= target) for the games-played heatmap.
function sampleColor(ratio) {
  const hue = Math.round(clamp(ratio, 0, 1) * 120); // 0=red, 120=green
  return `hsl(${hue}, 45%, 38%)`;
}

// ---------- scatter ----------
function renderScatter(data, decks) {
  const dots = decks.filter((deck) => deck.games > 0);
  const maxPick = Math.max(...dots.map((d) => d.pickRate), 0.02) * 1.15;
  const avgPick = dots.reduce((sum, d) => sum + d.pickRate, 0) / (dots.length || 1);
  const avgLeft = (avgPick / maxPick * 100).toFixed(1);

  const gridlines = [0, 25, 50, 75].map((top) =>
    `<div class="grid-line${top === 50 ? ' strong' : ''}" style="top:${top}%"></div>`,
  ).join('');

  const points = dots.map((deck) => {
    const left = (deck.pickRate / maxPick * 100).toFixed(1);
    const top = ((0.7 - clamp(deck.winRate, 0.3, 0.7)) / 0.4 * 100).toFixed(1);
    const size = Math.round(10 + Math.min(1, deck.games / 250) * 14);
    const color = deck.flag === 'over' ? COLORS.red : deck.flag === 'under' ? COLORS.blue : COLORS.violet;
    return `<div class="dot-wrap" style="left:${left}%;top:${top}%" ${deckClick(deck)}>
      <div class="dot" style="width:${size}px;height:${size}px;background:${color}"></div>
      <div class="dot-label">${labelHtml(deck.label, deck.deckId)}</div>
    </div>`;
  }).join('');

  els.view.innerHTML = `<div class="card panel">
    <div class="section-head">
      <div class="section-title">Pick rate vs win rate</div>
      <div class="kicker">Top-right = popular &amp; strong (nerf watch) · Top-left = sleeper</div>
    </div>
    <div class="scatter-plot">
      ${gridlines}
      <div class="avg-line" style="left:${avgLeft}%"></div>
      <div class="axis-y" style="top:-7px">70%</div>
      <div class="axis-y" style="top:calc(50% - 7px)">50%</div>
      <div class="axis-y" style="bottom:-7px">30%</div>
      <div class="avg-note" style="left:calc(${avgLeft}% + 6px)">avg pick rate</div>
      ${points}
    </div>
    <div class="scatter-x"><span>pick rate →</span><span>${pct(maxPick, 0)}</span></div>
    <div class="legend">
      ${legendSwatch(COLORS.red, 'Flagged overperforming', true)}
      ${legendSwatch(COLORS.blue, 'Flagged underperforming', true)}
      ${legendSwatch(COLORS.violet, 'Within threshold', true)}
      <span class="legend-spacer">Dot size = games played</span>
    </div>
  </div>`;
}

// ---------- formats ----------
function renderFormats(data) {
  const formats = data.formats || [];
  if (!formats.length) {
    els.view.innerHTML = card(empty('No formats have been logged yet.'), 'panel');
    return;
  }
  els.view.innerHTML = `<div class="format-grid">${formats.map(formatCard).join('')}</div>`;
}

function formatCard(row) {
  const shareW = (row.share * 100).toFixed(1);
  const accent = row.format.includes('2v2') || row.format.includes('team') ? COLORS.gold
    : row.format.includes('boss') || row.format.includes('2v1') ? COLORS.violet
    : 'var(--accent)';
  const boss = row.bossGames > 0 ? `
    <div class="stat-inline" style="margin-top:0">
      <div>
        <div class="label">Boss-side win rate</div>
        <div class="big" style="color:${bossColor(row.bossWinRate)}">${pct(row.bossWinRate)}</div>
      </div>
    </div>
    <div class="sub-title">By boss</div>
    ${row.bosses.map((b) => `<div class="mini-row">
      <span class="name">${esc(b.boss)}</span>
      <span class="g">${number(b.games)}g</span>
      <span class="mono" style="color:${wrColor(b.winRate)}">${pct(b.winRate)}</span>
    </div>`).join('')}` : '';

  return `<article class="card format-card">
    <div class="section-head">
      <div class="format-title">${esc(row.label)}</div>
      <div class="mono kicker">${number(row.games)} games · ${pct(row.share, 0)}</div>
    </div>
    <div class="share-track"><div class="share-fill" style="width:${clamp(shareW, 0, 100)}%;background:${accent}"></div></div>
    <div class="stat-inline">
      <div>
        <div class="label">Avg length</div>
        <div class="big">${row.avgTurns == null ? 'n/a' : row.avgTurns.toFixed(1)} turns</div>
      </div>
    </div>
    ${boss}
  </article>`;
}

// ---------- scenario explorer ----------
const scenarioCache = new Map();

async function renderScenario(data) {
  const decks = [...(data.decks || [])].sort((a, b) => a.label.localeCompare(b.label));
  const maps = [...(data.maps || [])].sort((a, b) => a.map.localeCompare(b.map));
  const formats = (data.formats || []).filter((f) => f.format === 'team-2v2' || f.format === '2v2' || f.label.includes('2v2'));
  const scenario = state.scenario || (state.scenario = {});
  els.view.innerHTML = `<div class="card panel scenario-panel">
    <div class="section-head">
      <div>
        <div class="section-title">Scenario Explorer</div>
        <div class="kicker" style="margin-top:3px">Pick a 2v2 format, map, your deck, and optional known seats. Suggestions use opponent-adjusted partner performance.</div>
      </div>
      <div class="kicker">Pilot filter: ${esc(pilotSummary())}</div>
    </div>
    <div class="scenario-controls">
      ${scenarioSelect('Format', 'format', scenario.format || '', [['', 'All 2v2 formats'], ...formats.map((f) => [f.format, f.label])])}
      ${scenarioSelect('Map', 'map', scenario.map || '', [['', 'Any map'], ...maps.map((m) => [m.map, m.map])])}
      ${scenarioSelect('Your deck', 'deck', scenario.deck || '', [['', 'Choose deck…'], ...decks.map((d) => [d.deck, d.label])])}
      ${scenarioSelect('Partner', 'partner', scenario.partner || '', [['', 'Suggest partner'], ...decks.map((d) => [d.deck, d.label])])}
      ${scenarioSelect('Enemy 1', 'enemyA', scenario.enemyA || '', [['', 'Any enemy'], ...decks.map((d) => [d.deck, d.label])])}
      ${scenarioSelect('Enemy 2', 'enemyB', scenario.enemyB || '', [['', 'Any enemy'], ...decks.map((d) => [d.deck, d.label])])}
    </div>
    <div class="scenario-body">${scenario.deck ? empty('Loading scenario…') : empty('Choose your deck to start seeing partner suggestions.')}</div>
  </div>`;
  bindScenarioControls();
  if (!scenario.deck) return;

  const body = els.view.querySelector('.scenario-body');
  try {
    const detail = await fetchScenario(scenario);
    const rows = scenario.partner ? (detail.matchups || []) : (detail.partners || []);
    body.innerHTML = rows.length ? scenarioTable(detail, scenario) : empty('No 2v2 games match this scenario yet. Try removing map, partner, or enemy filters.');
  } catch (error) {
    body.innerHTML = empty('Failed to load scenario: ' + (error.message || ''));
  }
}

function scenarioSelect(label, field, value, options) {
  const opts = options.map(([v, text]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(text)}</option>`).join('');
  return `<label class="scenario-field"><span>${esc(label)}</span><select data-scenario-field="${esc(field)}">${opts}</select></label>`;
}

function bindScenarioControls() {
  els.view.querySelectorAll('[data-scenario-field]').forEach((select) => {
    select.addEventListener('change', () => {
      state.scenario[select.dataset.scenarioField] = select.value || null;
      writeStateToUrl();
      if (current) renderScenario(current);
    });
  });
}

async function fetchScenario(scenario) {
  const params = new URLSearchParams();
  if (scenario.format) params.set('format', scenario.format);
  if (scenario.map) params.set('map', scenario.map);
  if (scenario.deck) params.set('deck', scenario.deck);
  if (scenario.partner) params.set('partner', scenario.partner);
  if (scenario.enemyA) params.set('enemyA', scenario.enemyA);
  if (scenario.enemyB) params.set('enemyB', scenario.enemyB);
  const pilots = includedPilots();
  if (pilots.length) params.set('pilots', pilots.join(','));
  const key = params.toString();
  const cached = scenarioCache.get(key);
  if (cached && Date.now() - cached.at < DASH_TTL_MS) return cached.json;
  const json = await fetchJson(`/v1/stats/scenario?${key}`);
  scenarioCache.set(key, { at: Date.now(), json });
  return json;
}

function scenarioTable(detail, scenario) {
  const summary = [scenario.format || 'all 2v2 formats', scenario.map || 'any map', scenario.partner ? `partner ${labelForDeckId(deckIdOf(scenario.partner))}` : null, scenario.enemyA ? `enemy ${labelForDeckId(deckIdOf(scenario.enemyA))}` : null, scenario.enemyB ? `enemy ${labelForDeckId(deckIdOf(scenario.enemyB))}` : null]
    .filter(Boolean).join(' · ');
  return scenario.partner ? scenarioMatchupTable(detail, summary) : scenarioPartnerTable(detail, summary);
}

function scenarioPartnerTable(detail, summary) {
  const rows = [...(detail.partners || [])].sort((a, b) => b.adjustedDelta - a.adjustedDelta || b.games - a.games);
  return `<div>
    <div class="scenario-summary">${number(detail.totalGames)} matching team games · ${esc(summary)}</div>
    <div class="scenario-grid scenario-head"><span>Suggested partner</span><span class="right">Games</span><span class="right">WR</span><span class="right">Expected</span><span class="right">Adj Δ</span></div>
    ${rows.map(scenarioPartnerRow).join('')}
  </div>`;
}

function scenarioMatchupTable(detail, summary) {
  const rows = [...(detail.matchups || [])].sort((a, b) => b.games - a.games || b.adjustedDelta - a.adjustedDelta);
  return `<div>
    <div class="scenario-summary">${number(detail.totalGames)} matching team games · enumerating opponent pairs · ${esc(summary)}</div>
    <div class="scenario-grid scenario-head"><span>Opponent pair</span><span class="right">Games</span><span class="right">WR</span><span class="right">Expected</span><span class="right">Adj Δ</span></div>
    ${rows.map(scenarioMatchupRow).join('')}
  </div>`;
}

function scenarioPartnerRow(row) {
  const cls = row.adjustedDelta > 0.03 ? 'delta-up' : row.adjustedDelta < -0.03 ? 'delta-down' : 'delta-flat';
  return `<div class="scenario-grid scenario-row">
    <span class="name">${labelHtml(row.label, row.deckId)}</span>
    <span class="num">${number(row.games)}</span>
    <span class="mono" style="text-align:right;color:${wrColor(row.winRate)}">${pct(row.winRate)}</span>
    <span class="num">${pct(row.expectedWinRate)}</span>
    <span style="text-align:right"><span class="delta-badge ${cls}">${signedPct(row.adjustedDelta)}</span></span>
  </div>`;
}

function scenarioMatchupRow(row) {
  const cls = row.adjustedDelta > 0.03 ? 'delta-up' : row.adjustedDelta < -0.03 ? 'delta-down' : 'delta-flat';
  return `<div class="scenario-grid scenario-row">
    <span class="name">${labelHtml(row.opponentALabel, row.opponentAId)} + ${labelHtml(row.opponentBLabel, row.opponentBId)}</span>
    <span class="num">${number(row.games)}</span>
    <span class="mono" style="text-align:right;color:${wrColor(row.winRate)}">${pct(row.winRate)}</span>
    <span class="num">${pct(row.expectedWinRate)}</span>
    <span style="text-align:right"><span class="delta-badge ${cls}">${signedPct(row.adjustedDelta)}</span></span>
  </div>`;
}

// ---------- synergy ----------
function renderSynergy(data) {
  const rows = [...(data.synergy || [])].sort((a, b) => b.delta - a.delta);
  els.view.innerHTML = `<div class="card">
    <div class="panel" style="padding-bottom:4px">
      <div class="section-title">2v2 synergy pairs</div>
      <div class="kicker" style="margin-top:3px">Δ = pair win rate minus expected (average of each deck's solo 2v2 win rate). Big positive Δ = more than the sum of its parts. Click a pair to see who it beats and loses to.</div>
    </div>
    <div class="syn-grid syn-head">
      <span>Pair</span><span class="right">Games</span><span class="right">Win rate</span><span class="right">Expected</span><span class="right">Δ</span>
    </div>
    ${rows.length ? rows.map(synergyRow).join('') : `<div class="panel">${empty('No pairs with enough games under the current filters. Include more pilot types or log more 2v2 games.')}</div>`}
  </div>`;
  els.view.querySelectorAll('.syn-row[data-deck-a]').forEach((rowEl) => {
    rowEl.addEventListener('click', () => openPair(rowEl.dataset.deckA, rowEl.dataset.deckB));
  });
}

function synergyRow(row) {
  const cls = row.delta > 0.03 ? 'delta-up' : row.delta < -0.03 ? 'delta-down' : 'delta-flat';
  return `<div class="syn-grid syn-row" data-deck-a="${esc(row.deckA)}" data-deck-b="${esc(row.deckB)}">
    <span style="font-weight:600;font-size:13px">${heroLabelHtml(row.deckAId)} + ${heroLabelHtml(row.deckBId)}</span>
    <span class="num">${number(row.games)}</span>
    <span class="mono" style="text-align:right">${pct(row.winRate)}</span>
    <span class="num">${pct(row.expectedWinRate)}</span>
    <span style="text-align:right"><span class="delta-badge ${cls}">${signedPct(row.delta)}</span></span>
  </div>`;
}

// Opponent rows carry full deck ids (`id@version`); labelForDeckId keys on the id.
function deckIdOf(deck) {
  return String(deck || '').split('@')[0];
}

// ---------- recents ----------
async function renderRecent() {
  els.view.innerHTML = card(empty('Loading recent games…'), 'panel');
  let data;
  try {
    const params = statsQuery();
    params.set('limit', '50');
    data = await fetchJson(`/v1/stats/recent?${params}`);
  } catch (error) {
    els.view.innerHTML = card(empty('Failed to load recent games: ' + (error.message || '')), 'panel');
    return;
  }
  const games = data.games || [];
  const scoped = state.format || state.excluded.size ? 'matching this view' : 'uploaded';
  els.view.innerHTML = `<div class="card panel">
    <div class="section-head">
      <div class="section-title">Recent games</div>
      <div class="kicker">Last ${games.length} games ${scoped} · newest first · click a deck for its page</div>
    </div>
    <div class="recent-list">${games.length ? games.map(recentRow).join('') : empty('No games uploaded under the current filters.')}</div>
  </div>`;
  bindHandlers(els.view);
}

function recentRow(g) {
  const teamHtml = (team) => {
    const cls = g.draw ? 'recent-draw' : team.won ? 'recent-win' : 'recent-lose';
    const names = team.seats.map((s) => {
      const id = registerHandler(() => openDeck(s.deck));
      return `<span class="recent-hero" data-handler="${id}">${labelHtml(s.heroName || deckIdOf(s.deck), s.deckId)}</span>`;
    }).join(' + ');
    return `<span class="${cls}">${names}</span>`;
  };
  const sep = g.draw ? '<span class="recent-vs">drew</span>' : '<span class="recent-vs">vs</span>';
  const match = g.teams.map(teamHtml).join(sep);
  const pilots = [...new Set(g.teams.flatMap((t) => t.seats.map((s) => s.pilot)))].map(pilotLabel).join(', ');
  const meta = [g.map, pilots, g.turns == null ? null : `${g.turns} turns`, g.source].filter(Boolean).join(' · ');
  return `<div class="recent-row">
    <span class="recent-time" title="${esc(g.receivedAt)}">${timeAgo(g.receivedAt)}</span>
    <span class="recent-fmt">${esc(g.formatLabel)}</span>
    <span class="recent-match">${match}</span>
    <span class="recent-meta">${esc(meta)}</span>
  </div>`;
}

function timeAgo(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

// ---------- synergy pair modal (deep-linkable via ?pair=deckA|deckB) ----------
const synCache = new Map();

async function openPair(deckA, deckB) {
  setStatus('Loading pair detail…');
  try {
    const key = `${deckA}|${deckB}`;
    let detail = synCache.get(key);
    if (!detail) {
      const params = statsQuery();
      params.set('deckA', deckA);
      params.set('deckB', deckB);
      detail = await fetchJson(`/v1/stats/synergy?${params}`);
      synCache.set(key, detail);
    }
    clearStatus();
    state.pair = key;
    state.deck = null;
    writeStateToUrl();
    renderPairModal(detail);
  } catch (error) {
    showError(error);
  }
}

function renderPairModal(detail) {
  const nameA = heroLabelHtml(deckIdOf(detail.deckA));
  const nameB = heroLabelHtml(deckIdOf(detail.deckB));
  const totalWins = (detail.pairs || []).reduce((sum, p) => sum + p.wins, 0);
  const winRate = detail.totalGames > 0 ? totalWins / detail.totalGames : 0;
  // Expected/Δ only exist in the dashboard's synergy list (needs solo win rates).
  const rowMatch = (current?.synergy || []).find((s) =>
    (s.deckA === detail.deckA && s.deckB === detail.deckB) || (s.deckA === detail.deckB && s.deckB === detail.deckA));
  const extra = rowMatch
    ? ` · expected ${pct(rowMatch.expectedWinRate)} · Δ ${signedPct(rowMatch.delta)}`
    : '';

  els.modalRoot.innerHTML = `
    <div class="modal-overlay" data-overlay>
      <div class="modal" data-screen-label="Synergy pair" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div style="flex:1">
            <div class="modal-title">${nameA} + ${nameB}</div>
            <div class="modal-sub">2v2 pair · ${number(detail.totalGames)} games together${extra}</div>
          </div>
          <div class="modal-wr" style="color:${wrColor(winRate)}">${pct(winRate)}</div>
          <button class="modal-close" data-close type="button" aria-label="Close">✕</button>
        </div>
        <div class="modal-section" style="padding-bottom:22px" data-pair-body></div>
      </div>
    </div>`;
  renderPairBody(els.modalRoot.querySelector('[data-pair-body]'), detail, 'pairs');

  els.modalRoot.querySelector('[data-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
  els.modalRoot.querySelector('[data-close]')?.addEventListener('click', closeModal);
}

function renderPairBody(body, detail, mode) {
  if (!body) return;
  const list = mode === 'decks' ? (detail.decks || []) : (detail.pairs || []);
  const label = (x) => mode === 'decks'
    ? heroLabelHtml(deckIdOf(x.deck))
    : `${heroLabelHtml(deckIdOf(x.deckA))} + ${heroLabelHtml(deckIdOf(x.deckB))}`;
  const beating = list.filter((x) => x.winRate >= 0.5).sort((a, b) => b.winRate - a.winRate || b.games - a.games);
  const losing = list.filter((x) => x.winRate < 0.5).sort((a, b) => a.winRate - b.winRate || b.games - a.games);
  const oppRow = (x) => `<div class="syn-opp">
    <span class="name">${label(x)}</span>
    <span class="g">${number(x.games)}g</span>
    <span class="mono" style="color:${wrColor(x.winRate)}">${pct(x.winRate)}</span>
  </div>`;
  const section = (title, arr, kind) => `<div class="syn-opp-col">
    <div class="syn-opp-title ${kind}">${title} <span class="kicker">(${arr.length})</span></div>
    ${arr.length ? arr.map(oppRow).join('') : `<div class="empty">none</div>`}
  </div>`;

  body.innerHTML = `
    <div class="syn-toggle">
      <button class="syn-tab${mode === 'pairs' ? ' active' : ''}" data-mode="pairs" type="button">Vs pairs</button>
      <button class="syn-tab${mode === 'decks' ? ' active' : ''}" data-mode="decks" type="button">Vs individual decks</button>
    </div>
    ${detail.totalGames > 0
      ? `<div class="syn-cols">${section('Beating', beating, 'good')}${section('Losing', losing, 'bad')}</div>`
      : empty('No games for this pair under the current filters.')}`;
  body.querySelectorAll('.syn-tab').forEach((btn) => {
    btn.addEventListener('click', () => renderPairBody(body, detail, btn.dataset.mode));
  });
}

function labelForDeckId(deckId) {
  const match = (current?.decks || []).find((deck) => deck.deckId === deckId);
  return match ? match.label : deckId;
}

// `-spice` decks share their base hero's display name, so tag them with a chili
// flair to disambiguate at a glance. deckId ends with '-spice'.
function isSpice(deckId) {
  return String(deckId || '').endsWith('-spice');
}
function spiceFlair(deckId) {
  return isSpice(deckId) ? ' <span class="spice" title="Spice remix">🌶️</span>' : '';
}
// Escaped display name plus the spice flair when applicable (returns HTML).
function labelHtml(label, deckId) {
  return esc(label) + spiceFlair(deckId);
}
// deckId → escaped label + flair, for deckId-keyed contexts.
function heroLabelHtml(deckId) {
  return labelHtml(labelForDeckId(deckId), deckId);
}

// ---------- deck detail modal ----------
// Deck detail is a full page (not a modal), deep-linkable via ?deck=. Opening
// just sets state + URL; renderView routes to renderDeckPage which fetches.
function openDeck(deck) {
  state.deck = deck;
  state.pair = null;
  writeStateToUrl();
  renderDeckPage();
}

function exitDeckPage() {
  state.deck = null;
  writeStateToUrl();
  if (current) renderView(current);
}

async function renderDeckPage() {
  els.view.innerHTML = card(empty('Loading deck…'));
  let d;
  try {
    const params = statsQuery();
    params.set('deck', state.deck);
    d = await fetchJson(`/v1/stats/deck?${params}`);
  } catch (error) {
    els.view.innerHTML = card(empty('Failed to load deck: ' + (error.message || '')));
    return;
  }

  const comp = d.composition && d.composition.cardCount > 0
    ? compositionSection(d.composition)
    : d.profile ? playMixSection(d.profile) : `<div class="modal-section"><div class="empty">No card data for this deck yet.</div></div>`;
  const matchups = matchupHighlights(d.matchups || []);
  const fp = d.firstPlayer || { first: {}, second: {} };
  const splitStat = (label, s) => {
    const wr = s && s.winRate != null ? s.winRate : null;
    return `<div class="deck-stat">
      <div class="subtle">${label}</div>
      <div class="val mono" style="color:${wr == null ? 'var(--text)' : wrColor(wr)}">${wr == null ? '—' : pct(wr, 0)}</div>
      <div class="subtle" style="font-weight:400">${number((s && s.games) || 0)} games</div>
    </div>`;
  };
  const backId = registerHandler(exitDeckPage);
  const influenceMode = cardInfluenceMode === 'starting' ? 'starting' : 'played';
  const playedInfluenceId = registerHandler(() => setCardInfluenceMode('played'));
  const startingInfluenceId = registerHandler(() => setCardInfluenceMode('starting'));
  const influenceRows = influenceMode === 'starting' ? (d.startingCards || []) : (d.cards || []);
  const influenceKicker = influenceMode === 'starting'
    ? "Δ win rate when the card starts in hand vs the deck's baseline"
    : "Δ win rate when the card is played vs the deck's baseline";
  const influenceEmpty = influenceMode === 'starting'
    ? 'No starting-hand telemetry for this deck.'
    : 'No played-card telemetry for this deck.';
  const influenceLabel = influenceMode === 'starting' ? 'starts' : 'plays';

  els.view.innerHTML = `<div class="deck-page">
    <button class="mx-back" data-handler="${backId}" type="button">◀ Back</button>
    <div class="card panel" style="margin-top:12px">
      <div class="deck-head">
        <div style="flex:1">
          <div class="modal-title">${labelHtml(d.label, d.deckId)}</div>
          <div class="modal-sub">${esc(d.deck)} · ${number(d.games)} games · pick rate ${pct(d.pickRate)}</div>
        </div>
        <div class="modal-wr" style="color:${wrColor(d.winRate)}">${pct(d.winRate)}</div>
      </div>
      <div class="deck-stats">
        <div class="deck-stat">
          <div class="subtle">Overall</div>
          <div class="val mono" style="color:${wrColor(d.winRate)}">${pct(d.winRate)}</div>
          <div class="deck-stat-ci">95% CI ${pct(d.ciLow, 0)}–${pct(d.ciHigh, 0)}</div>
        </div>
        <div class="deck-stat"><div class="subtle">Avg HP left</div><div class="val mono">${d.avgFinalHealth == null ? '—' : d.avgFinalHealth.toFixed(1)}</div></div>
        ${splitStat('Going first', fp.first)}
        ${splitStat('Going second', fp.second)}
      </div>
      ${twoVTwoSection(d.twoVTwo)}
      ${comp}
      <div class="modal-cols">
        <div>
          <div class="sub-title" style="margin-top:0">Win rate by format</div>
          <div class="list tight">${(d.formats || []).map(formatBarRow).join('') || empty('No format data.')}</div>
        </div>
        <div>
          <div class="sub-title" style="margin-top:0">1v1 matchups (min 5 games)</div>
          <div class="list tight">${matchups.length ? matchups.map(matchupRow).join('') : empty('Not enough duel data.')}</div>
        </div>
      </div>
      <div class="modal-section">
        <div class="sub-title" style="margin-top:0">Win rate by map</div>
        <div class="map-grid">${(d.maps || []).map(mapLine).join('') || empty('No map data.')}</div>
      </div>
      <div class="modal-section" style="padding-bottom:6px">
        <div class="section-head">
          <div>
            <div class="sub-title" style="margin-top:0">Card influence</div>
            <div class="kicker">${esc(influenceKicker)}</div>
          </div>
          <div class="syn-tabs">
            <button class="syn-tab${influenceMode === 'played' ? ' active' : ''}" data-handler="${playedInfluenceId}" type="button">Played</button>
            <button class="syn-tab${influenceMode === 'starting' ? ' active' : ''}" data-handler="${startingInfluenceId}" type="button">Starting hand</button>
          </div>
        </div>
        <div class="list tight" style="margin-top:9px;gap:0">${influenceRows.map((row) => cardInflRow(row, influenceLabel)).join('') || empty(influenceEmpty)}</div>
      </div>
    </div>
  </div>`;
  bindHandlers(els.view);
}

function closeModal() {
  els.modalRoot.innerHTML = '';
  const wasDeckPage = !!state.deck;
  if (state.deck || state.pair) { state.deck = null; state.pair = null; writeStateToUrl(); }
  if (wasDeckPage && current) renderView(current); // exit the full-page deck view
}

function twoVTwoSection(two) {
  const summary = two || { games: 0, wins: 0, winRate: null, partners: [] };
  const mode = twoVTwoMode === 'adjusted' ? 'adjusted' : 'raw';
  const partners = summary.partners || [];
  const metric = (p) => mode === 'adjusted' ? (p.adjustedDelta ?? 0) : (p.rawDelta ?? p.delta ?? 0);
  const ranked = [...partners].sort((a, b) => metric(b) - metric(a) || b.games - a.games);
  const best = ranked.filter((p) => metric(p) >= 0).slice(0, 5);
  const worst = ranked.filter((p) => metric(p) < 0).sort((a, b) => metric(a) - metric(b) || b.games - a.games).slice(0, 5);
  const metricLabel = mode === 'adjusted' ? 'Adj Δ' : 'Raw Δ';
  const kicker = mode === 'adjusted'
    ? 'Opponent-adjusted Δ compares each game to the opposing pair’s smoothed strength estimate.'
    : 'Raw partner stats are not opponent-adjusted; Δ is compared to this deck’s overall 2v2 win rate.';
  const bestTitle = mode === 'adjusted' ? 'Best adjusted partner results' : 'Best raw partner results';
  const worstTitle = mode === 'adjusted' ? 'Worst adjusted partner results' : 'Worst raw partner results';
  const rawId = registerHandler(() => setTwoVTwoMode('raw', summary));
  const adjustedId = registerHandler(() => setTwoVTwoMode('adjusted', summary));
  const row = (p) => {
    const value = metric(p);
    const cls = value > 0.03 ? 'delta-up' : value < -0.03 ? 'delta-down' : 'delta-flat';
    const note = mode === 'adjusted' ? ` · expected ${pct(p.expectedWinRate ?? 0.5)}` : '';
    return `<div class="partner-row">
      <span class="name">${labelHtml(p.label, p.deckId)}<span class="partner-note">${esc(note)}</span></span>
      <span class="g">${number(p.games)}g</span>
      <span class="mono" style="color:${wrColor(p.winRate)}">${pct(p.winRate)}</span>
      <span style="text-align:right"><span class="delta-badge ${cls}" title="${esc(metricLabel)}">${signedPct(value)}</span></span>
    </div>`;
  };
  const col = (title, arr, kind) => `<div>
    <div class="syn-opp-title ${kind}">${title} <span class="kicker">(${arr.length})</span></div>
    ${arr.length ? arr.map(row).join('') : `<div class="empty">none yet</div>`}
  </div>`;
  return `<div class="modal-section two-v-two-detail" data-two-v-two-section>
    <div class="section-head">
      <div>
        <div class="sub-title" style="margin-top:0">2v2 performance</div>
        <div class="kicker" style="margin-top:3px">${esc(kicker)}</div>
      </div>
      <div class="syn-toggle" style="padding:0">
        <button class="syn-tab${mode === 'raw' ? ' active' : ''}" data-handler="${rawId}" type="button">Raw</button>
        <button class="syn-tab${mode === 'adjusted' ? ' active' : ''}" data-handler="${adjustedId}" type="button">Opponent-adjusted</button>
      </div>
    </div>
    <div class="deck-stats compact">
      <div class="deck-stat">
        <div class="subtle">2v2 overall</div>
        <div class="val mono" style="color:${summary.winRate == null ? 'var(--text)' : wrColor(summary.winRate)}">${summary.winRate == null ? '—' : pct(summary.winRate)}</div>
        <div class="subtle" style="font-weight:400">${number(summary.games)} games</div>
      </div>
      <div class="deck-stat">
        <div class="subtle">Record</div>
        <div class="val mono">${number(summary.wins)}–${number(Math.max(0, summary.games - summary.wins))}</div>
        <div class="subtle" style="font-weight:400">team games</div>
      </div>
      <div class="deck-stat">
        <div class="subtle">Partners seen</div>
        <div class="val mono">${number(partners.length)}</div>
        <div class="subtle" style="font-weight:400">unique decks</div>
      </div>
    </div>
    ${summary.games > 0
      ? `<div class="partner-cols">${col(bestTitle, best, 'good')}${col(worstTitle, worst, 'bad')}</div>`
      : empty('No 2v2 games for this deck yet.')}
  </div>`;
}

// Real deck make-up from the pushed registry: the mock's "30 cards" panel.
function compositionSection(c) {
  const seg = (n, color) => `<span style="width:${c.cardCount ? (n / c.cardCount * 100).toFixed(1) : 0}%;background:${color}"></span>`;
  return `<div class="modal-section">
    <div class="sub-title" style="margin-top:0">Deck composition — ${number(c.cardCount)} cards</div>
    <div class="deck-comp-bar">
      ${seg(c.attack, '#d9705c')}${seg(c.defense, '#7aa3d4')}${seg(c.versatile, '#d4ab4f')}${seg(c.scheme, '#a78bc9')}
    </div>
    <div class="deck-cells">
      ${countCell('Attack', c.attack, `Σ value ${c.attackValue}`, '#d9705c')}
      ${countCell('Defense', c.defense, `Σ value ${c.defenseValue}`, '#7aa3d4')}
      ${countCell('Versatile', c.versatile, 'atk or def', '#d4ab4f')}
      ${countCell('Scheme', c.scheme, 'effects', '#a78bc9')}
    </div>
    <div class="lean-line">
      <span>Total offense value: <b class="mono">${c.attackValue}</b></span>
      <span>Total defense value: <b class="mono">${c.defenseValue}</b></span>
      <span>Lean: <b>${esc(c.lean || '—')}</b></span>
    </div>
  </div>`;
}

// Fallback when no registry composition: the play-derived mix from card telemetry.
function playMixSection(p) {
  const other = p.boost + p.other;
  const seg = (share, color) => `<span style="width:${(share * 100).toFixed(1)}%;background:${color}"></span>`;
  return `<div class="modal-section">
    <div class="sub-title" style="margin-top:0">Play mix — ${number(p.plays)} card plays <span class="kicker">(no registry composition)</span></div>
    <div class="deck-comp-bar">
      ${seg(p.attack, '#d9705c')}${seg(p.defense, '#7aa3d4')}${seg(other, '#d4ab4f')}${seg(p.scheme, '#a78bc9')}
    </div>
    <div class="deck-cells">
      ${shareCell('Attack', p.attack, '#d9705c')}
      ${shareCell('Defense', p.defense, '#7aa3d4')}
      ${shareCell('Boost / other', other, '#d4ab4f')}
      ${shareCell('Scheme', p.scheme, '#a78bc9')}
    </div>
    <div class="lean-line"><span>Lean: <b>${esc(p.lean || '—')}</b></span></div>
  </div>`;
}

function countCell(label, count, sub, color) {
  return `<div class="deck-cell">
    <div class="cell-head"><span class="dot-swatch" style="background:${color}"></span><span class="cell-label">${esc(label)}</span></div>
    <div class="cell-count">${number(count)}</div>
    <div class="cell-sub">${esc(sub)}</div>
  </div>`;
}

function shareCell(label, share, color) {
  return `<div class="deck-cell">
    <div class="cell-head"><span class="dot-swatch" style="background:${color}"></span><span class="cell-label">${esc(label)}</span></div>
    <div class="cell-count">${pct(share, 0)}</div>
    <div class="cell-sub">of card plays</div>
  </div>`;
}

function formatBarRow(row) {
  const color = row.winRate >= 0.5 ? COLORS.green : COLORS.red;
  return `<div class="bar-row">
    <span class="lbl">${esc(row.label)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${Math.round(row.winRate * 100)}%;background:${color}"></span></span>
    <span class="val">${pct(row.winRate)} <span class="g">${number(row.games)}g</span></span>
  </div>`;
}

function matchupHighlights(matchups) {
  const eligible = matchups.filter((m) => m.games >= 5).sort((a, b) => b.winRate - a.winRate);
  if (eligible.length <= 6) return eligible.map((m) => ({ ...m, tag: m.winRate >= 0.5 ? 'BEST' : 'WORST' }));
  const best = eligible.slice(0, 3).map((m) => ({ ...m, tag: 'BEST' }));
  const worst = eligible.slice(-3).map((m) => ({ ...m, tag: 'WORST' }));
  return [...best, ...worst];
}

function matchupRow(m) {
  return `<div class="matchup-row">
    <span class="tag" style="color:${m.tag === 'BEST' ? COLORS.green : '#e89286'}">${m.tag}</span>
    <span class="name">${labelHtml(m.label, m.deckId)}</span>
    <span class="g">${number(m.games)}g</span>
    <span class="mono" style="color:${wrColor(m.winRate)}">${pct(m.winRate)}</span>
  </div>`;
}

function mapLine(row) {
  const color = row.winRate >= 0.5 ? COLORS.green : COLORS.red;
  return `<div class="map-line">
    <span class="name">${esc(row.map)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${Math.round(row.winRate * 100)}%;background:${color}"></span></span>
    <span class="val">${pct(row.winRate)} <span class="g">${number(row.games)}g</span></span>
  </div>`;
}

function cardInflRow(card, countLabel = 'plays') {
  const meta = BUCKET_META[card.contextBucket] || BUCKET_META.other;
  const isStarting = countLabel === 'starts';
  const typeTag = isStarting ? 'HAND' : meta.tag;
  const contextLabel = isStarting ? 'opening hand' : card.contextBucket;
  const infl = card.influence;
  const inflColor = infl > 0.02 ? COLORS.green : infl < -0.02 ? '#e89286' : COLORS.muted;
  const inflBg = infl > 0.02 ? 'rgba(126,203,143,0.2)' : infl < -0.02 ? 'rgba(224,121,106,0.2)' : 'rgba(255,255,255,0.08)';
  const barW = Math.min(100, Math.abs(infl) / 0.1 * 100).toFixed(1);
  return `<div class="card-infl-row">
    <span class="type" style="color:${meta.color}">${typeTag}</span>
    <span class="cname">${esc(card.card)}</span>
    <span class="meta">${esc(contextLabel)} · ${number(card.gamesWith)}g</span>
    <span class="plays">${number(card.plays)} ${esc(countLabel)}</span>
    <span class="bar-track" style="height:6px"><span class="bar-fill" style="width:${barW}%;background:${inflColor};opacity:0.7"></span></span>
    <span style="text-align:right"><span class="infl-badge" style="background:${inflBg};color:${inflColor}">${signedPct(infl)}</span></span>
  </div>`;
}

// ---------- shared bits ----------
function statCard(label, value, hint, color) {
  return `<div class="card stat">
    <div class="subtle">${esc(label)}</div>
    <div class="value" style="color:${color}">${esc(value)}</div>
    <div class="hint">${esc(hint)}</div>
  </div>`;
}

function chip(label, active, onClick) {
  const id = registerHandler(onClick);
  return `<button class="chip${active ? ' active' : ''}" data-handler="${id}" type="button">${esc(label)}</button>`;
}

function legendSwatch(color, label, round = false) {
  return `<span class="legend-item"><span class="swatch${round ? ' round' : ''}" style="background:${color}"></span>${esc(label)}</span>`;
}

function card(inner, extra = 'panel') {
  return `<div class="card ${extra}">${inner}</div>`;
}

function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

function deckClick(deck) {
  const id = registerHandler(() => openDeck(deck.deck));
  return `data-handler="${id}"`;
}

function selectedFormatLabel(data) {
  if (!state.format) return 'All formats';
  return (data.formats || []).find((f) => f.format === state.format)?.label || state.format;
}

function pilotSummary() {
  if (!state.excluded.size) return 'all pilots';
  const included = includedPilots();
  return included.length ? `${included.length} pilot type${included.length === 1 ? '' : 's'}` : 'none';
}

// ---------- handler registry ----------
const handlers = new Map();
let handlerId = 0;
function registerHandler(fn) {
  const id = String(++handlerId);
  handlers.set(id, fn);
  return id;
}
function bindHandlers(root) {
  root.querySelectorAll('[data-handler]').forEach((node) => {
    if (node.dataset.bound) return;
    node.dataset.bound = '1';
    node.addEventListener('click', () => handlers.get(node.dataset.handler)?.());
  });
}

// ---------- status ----------
function setStatus(message) {
  els.status.hidden = false;
  els.status.textContent = message;
}
function clearStatus() {
  els.status.hidden = true;
  els.status.textContent = '';
}
function showError(error) {
  console.error(error);
  setStatus(error.message || 'Dashboard failed to load');
}

// ---------- formatting ----------
function pct(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(digits)}%`;
}
function signedPct(value) {
  const points = value * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}pp`;
}
function number(value) {
  return Number(value || 0).toLocaleString();
}
function wrColor(value) {
  if (value >= 0.55) return COLORS.green;
  if (value <= 0.45) return COLORS.red;
  return COLORS.text;
}
function bossColor(value) {
  if (value == null) return COLORS.text;
  return Math.abs(value - 0.5) > 0.05 ? (value > 0.5 ? '#e89286' : '#a8c8ee') : COLORS.green;
}
function scaleCi(value) {
  return clamp(((value - 0.25) / 0.5) * 100, 0, 100);
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}
function code(value) {
  return String(value || '?').split(/[-_]/).map((part) => part[0] || '').join('').slice(0, 4).toUpperCase();
}
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

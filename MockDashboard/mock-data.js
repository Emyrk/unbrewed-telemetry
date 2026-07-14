// Mock data for Unmatched-style balance dashboard.
// 20 original heroes + seeded game generator.
// Game shape: { format, map, boss|null, teams: [[{h, p}], ...], winner: teamIndex, turns }
// Pilot types: 'human' | 'easy' | 'medium' | 'hard' | 'gruncle' | 'weaver' (named bots)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PILOTS = [
  { id: 'human',   label: 'Human',         bot: false },
  { id: 'easy',    label: 'Easy bot',      bot: true },
  { id: 'medium',  label: 'Medium bot',    bot: true },
  { id: 'hard',    label: 'Hard bot',      bot: true },
  { id: 'gruncle', label: 'Gruncle (bot)', bot: true },
  { id: 'weaver',  label: 'Weaver (bot)',  bot: true },
];

// pilot skill modifier added to team strength
const PILOT_MOD = { human: 0, easy: -0.14, medium: -0.07, hard: 0.02, gruncle: 0.05, weaver: -0.02 };
const PILOT_FREQ = [['human', 0.62], ['easy', 0.07], ['medium', 0.11], ['hard', 0.12], ['gruncle', 0.05], ['weaver', 0.03]];

export const MAPS = ['Saltmarsh Crossing', 'The Ember Court', 'Clocktower Rooftops', 'The Sunken Library', 'Gallows Green', 'The Drowned Bazaar'];

// deck: card counts (30 total) and summed printed values
// str: latent strength (0.5 = balanced), pop: pick popularity weight
export const HEROES = [
  { id: 'vex',      name: 'Vex the Cartographer', tag: 'Control',  boss: false, str: 0.52, pop: 1.3, deck: { atk: 9,  def: 10, vers: 7,  scheme: 4, atkVal: 34, defVal: 38 } },
  { id: 'matron',   name: 'Iron Matron',          tag: 'Bruiser',  boss: true,  str: 0.55, pop: 1.1, deck: { atk: 14, def: 8,  vers: 4,  scheme: 4, atkVal: 52, defVal: 26 } },
  { id: 'whisper',  name: 'Whisperfang',          tag: 'Aggro',    boss: false, str: 0.57, pop: 1.6, deck: { atk: 15, def: 5,  vers: 6,  scheme: 4, atkVal: 58, defVal: 20 } },
  { id: 'tide',     name: 'The Tidecaller',       tag: 'Control',  boss: false, str: 0.48, pop: 0.9, deck: { atk: 8,  def: 12, vers: 6,  scheme: 4, atkVal: 30, defVal: 44 } },
  { id: 'grim',     name: 'Grim Halloway',        tag: 'Midrange', boss: false, str: 0.51, pop: 1.0, deck: { atk: 11, def: 9,  vers: 7,  scheme: 3, atkVal: 42, defVal: 33 } },
  { id: 'cinder',   name: 'Sister Cinder',        tag: 'Aggro',    boss: false, str: 0.53, pop: 1.2, deck: { atk: 13, def: 6,  vers: 7,  scheme: 4, atkVal: 50, defVal: 24 } },
  { id: 'clock',    name: 'The Clockwork Duelist',tag: 'Tempo',    boss: false, str: 0.50, pop: 1.1, deck: { atk: 12, def: 8,  vers: 8,  scheme: 2, atkVal: 44, defVal: 30 } },
  { id: 'marrow',   name: 'Marrow King',          tag: 'Bruiser',  boss: true,  str: 0.63, pop: 1.8, deck: { atk: 13, def: 9,  vers: 6,  scheme: 2, atkVal: 55, defVal: 34 } },
  { id: 'petal',    name: 'Petal & Thorn',        tag: 'Duo',      boss: false, str: 0.49, pop: 1.0, deck: { atk: 10, def: 9,  vers: 8,  scheme: 3, atkVal: 36, defVal: 32 } },
  { id: 'lamp',     name: 'The Lamplighter',      tag: 'Support',  boss: false, str: 0.47, pop: 0.7, deck: { atk: 7,  def: 11, vers: 8,  scheme: 4, atkVal: 26, defVal: 40 } },
  { id: 'sallow',   name: 'Old Sallow',           tag: 'Control',  boss: true,  str: 0.50, pop: 0.8, deck: { atk: 9,  def: 11, vers: 6,  scheme: 4, atkVal: 33, defVal: 41 } },
  { id: 'meridian', name: 'Captain Meridian',     tag: 'Midrange', boss: false, str: 0.54, pop: 1.4, deck: { atk: 12, def: 9,  vers: 6,  scheme: 3, atkVal: 45, defVal: 32 } },
  { id: 'chandler', name: 'The Bone Chandler',    tag: 'Control',  boss: false, str: 0.44, pop: 0.6, deck: { atk: 8,  def: 12, vers: 5,  scheme: 5, atkVal: 28, defVal: 45 } },
  { id: 'yara',     name: 'Yara Nightloom',       tag: 'Tempo',    boss: false, str: 0.56, pop: 1.3, deck: { atk: 12, def: 7,  vers: 8,  scheme: 3, atkVal: 47, defVal: 27 } },
  { id: 'choir',    name: 'The Hollow Choir',     tag: 'Swarm',    boss: true,  str: 0.52, pop: 0.9, deck: { atk: 11, def: 8,  vers: 7,  scheme: 4, atkVal: 38, defVal: 29 } },
  { id: 'brindle',  name: 'Brindle',              tag: 'Aggro',    boss: false, str: 0.49, pop: 1.0, deck: { atk: 14, def: 6,  vers: 6,  scheme: 4, atkVal: 53, defVal: 21 } },
  { id: 'vesper',   name: 'Saint Vesper',         tag: 'Support',  boss: false, str: 0.51, pop: 0.8, deck: { atk: 8,  def: 10, vers: 9,  scheme: 3, atkVal: 31, defVal: 39 } },
  { id: 'auditor',  name: 'The Red Auditor',      tag: 'Control',  boss: false, str: 0.58, pop: 1.1, deck: { atk: 10, def: 10, vers: 8,  scheme: 2, atkVal: 40, defVal: 40 } },
  { id: 'rooke',    name: 'Mother Rooke',         tag: 'Midrange', boss: false, str: 0.50, pop: 0.9, deck: { atk: 11, def: 10, vers: 5,  scheme: 4, atkVal: 41, defVal: 36 } },
  { id: 'fenwick',  name: 'Fenwick the Unlucky',  tag: 'Trickster',boss: false, str: 0.41, pop: 0.7, deck: { atk: 9,  def: 8,  vers: 9,  scheme: 4, atkVal: 32, defVal: 28 } },
];

// 2v2 pairs with real synergy (added to team strength)
const SYNERGY = { 'petal|whisper': 0.09, 'brindle|lamp': 0.07, 'cinder|vesper': 0.06, 'fenwick|tide': -0.04 };

function pairKey(a, b) { return [a, b].sort().join('|'); }

export function generateGames(count = 1240, seed = 1337) {
  const rnd = mulberry32(seed);
  const popTotal = HEROES.reduce((s, h) => s + h.pop, 0);
  const bosses = HEROES.filter(h => h.boss);

  function pickHero(exclude) {
    while (true) {
      let r = rnd() * popTotal, h = null;
      for (const x of HEROES) { r -= x.pop; if (r <= 0) { h = x; break; } }
      h = h || HEROES[HEROES.length - 1];
      if (!exclude.includes(h.id)) return h;
    }
  }
  function pickPilot() {
    let r = rnd();
    for (const [id, f] of PILOT_FREQ) { r -= f; if (r <= 0) return id; }
    return 'human';
  }
  function slot(h) { return { h: h.id, p: pickPilot() }; }

  function teamStrength(team) {
    const heroes = team.map(s => HEROES.find(h => h.id === s.h));
    let s = heroes.reduce((x, h) => x + h.str, 0) / heroes.length;
    s += team.reduce((x, sl) => x + PILOT_MOD[sl.p], 0) / team.length;
    if (heroes.length === 2) s += SYNERGY[pairKey(heroes[0].id, heroes[1].id)] || 0;
    return s;
  }

  const games = [];
  for (let i = 0; i < count; i++) {
    const fr = rnd();
    const format = fr < 0.54 ? '1v1' : fr < 0.78 ? '2v2' : fr < 0.92 ? '2v1' : '3FFA';
    const map = MAPS[Math.floor(rnd() * MAPS.length)];
    let teams = [], boss = null;
    if (format === '1v1') {
      const h1 = pickHero([]); const h2 = pickHero([h1.id]);
      teams = [[slot(h1)], [slot(h2)]];
    } else if (format === '2v2') {
      const h1 = pickHero([]); const h2 = pickHero([h1.id]);
      const h3 = pickHero([h1.id, h2.id]); const h4 = pickHero([h1.id, h2.id, h3.id]);
      teams = [[slot(h1), slot(h2)], [slot(h3), slot(h4)]];
    } else if (format === '2v1') {
      const b = bosses[Math.floor(rnd() * bosses.length)];
      boss = b.name;
      const h2 = pickHero([b.id]); const h3 = pickHero([b.id, h2.id]);
      teams = [[slot(b)], [slot(h2), slot(h3)]];
    } else { // 3FFA
      const h1 = pickHero([]); const h2 = pickHero([h1.id]); const h3 = pickHero([h1.id, h2.id]);
      teams = [[slot(h1)], [slot(h2)], [slot(h3)]];
    }

    let winner;
    if (teams.length === 2) {
      let pA = 0.5 + (teamStrength(teams[0]) - teamStrength(teams[1])) * 1.6;
      if (format === '2v1') pA += 0.03; // boss handicap slightly favors boss
      pA = Math.max(0.08, Math.min(0.92, pA));
      winner = rnd() < pA ? 0 : 1;
    } else {
      // FFA: weighted by strength
      const w = teams.map(t => Math.exp(teamStrength(t) * 6));
      const tot = w.reduce((a, b) => a + b, 0);
      let r = rnd() * tot; winner = 0;
      for (let j = 0; j < w.length; j++) { r -= w[j]; if (r <= 0) { winner = j; break; } }
    }
    const turns = 7 + Math.floor(rnd() * 18);
    games.push({ format, map, boss, teams, winner, turns });
  }
  return games;
}

// Short codes for matrix axes
export const CODES = { vex: 'VEX', matron: 'IRN', whisper: 'WSP', tide: 'TID', grim: 'GRM', cinder: 'CIN', clock: 'CLK', marrow: 'MAR', petal: 'P&T', lamp: 'LMP', sallow: 'SAL', meridian: 'MER', chandler: 'BON', yara: 'YAR', choir: 'CHR', brindle: 'BRN', vesper: 'VES', auditor: 'AUD', rooke: 'ROO', fenwick: 'FEN' };

// Card-level influence stats, as emitted by instrumented AI-vs-AI games.
// Deterministic per hero. influence = win-rate delta (pp, as fraction) in games where the card was played.
const CARD_NAMES = {
  atk: ['Crushing Blow', 'Overreach', 'Twist the Knife', 'Sudden Lunge', 'Redoubled Assault', 'Opening Gambit'],
  def: ['Sidestep', 'Iron Guard', 'Read the Room', 'Hold the Line', 'Measured Retreat'],
  vers: ['Momentum', 'Improvise', 'Change of Plans', 'Press the Advantage'],
  scheme: ['Cruel Bargain', 'Vanishing Act', 'Turn the Tables', 'Whispered Threat'],
};

export function heroCards(heroId) {
  let seed = 0;
  for (let i = 0; i < heroId.length; i++) seed = (seed * 31 + heroId.charCodeAt(i)) | 0;
  const rnd = mulberry32(seed ^ 0xBEEF);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const used = new Set();
  const mk = (type) => {
    let name; let guard = 0;
    do { name = pick(CARD_NAMES[type]); } while (used.has(name) && ++guard < 10);
    used.add(name);
    return {
      name, type,
      value: type === 'scheme' ? null : 2 + Math.floor(rnd() * 5),
      copies: 1 + Math.floor(rnd() * 3),
      plays: 40 + Math.floor(rnd() * 180),
      influence: (rnd() - 0.42) * 0.16, // skew slightly positive
    };
  };
  const cards = [mk('atk'), mk('atk'), mk('atk'), mk('def'), mk('def'), mk('vers'), mk('vers'), mk('scheme')];
  return cards.sort((a, b) => b.influence - a.influence);
}

// Wilson score interval (95%)
export function wilson(wins, n) {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const z = 1.96, p = wins / n;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - m), hi: Math.min(1, c + m) };
}

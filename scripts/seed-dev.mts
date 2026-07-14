// Seed the local database with synthetic games so the balance dashboard has
// something to show in development. Deterministic (seeded RNG) and idempotent
// per seed. Writes directly through the repository, so the server need not run.
//
//   npm run db:seed            # ~800 games
//   SEED_GAMES=2000 npm run db:seed
//
// Not for production. It fabricates telemetry, including card-play events.
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import type { GameSubmission, TelemetrySubmission } from '../src/types.js';

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL;
const count = Number(process.env.SEED_GAMES ?? 800);
const seed = Number(process.env.SEED ?? 1337);
// Deck ids/version match the engine's shipped HEROES registry so games join the
// pushed deck_definitions and the dashboard shows real composition. Keep in sync
// with CONTENT_VERSION used by scripts/push-decks.mts in unbrewed-engine.
const DECK_VERSION = process.env.DECK_VERSION ?? '0.10.0';

interface Hero {
  id: string;
  name: string;
  str: number;
  pop: number;
  boss: boolean;
  deck: { attack: number; defense: number; scheme: number; boost: number };
}

const HEROES: Hero[] = [
  { id: 'king-kong', name: 'King Kong', str: 0.63, pop: 1.8, boss: true, deck: { attack: 15, defense: 5, scheme: 3, boost: 7 } },
  { id: 'the-mandalorian', name: 'The Mandalorian', str: 0.54, pop: 1.4, boss: false, deck: { attack: 12, defense: 6, scheme: 3, boost: 9 } },
  { id: 'thrall', name: 'Thrall', str: 0.5, pop: 1.0, boss: false, deck: { attack: 9, defense: 6, scheme: 5, boost: 10 } },
  { id: 'r2-d2', name: 'R2-D2', str: 0.47, pop: 0.9, boss: false, deck: { attack: 10, defense: 6, scheme: 4, boost: 10 } },
  { id: 'king-taranis', name: 'King Taranis', str: 0.51, pop: 1.0, boss: true, deck: { attack: 8, defense: 3, scheme: 5, boost: 14 } },
  { id: 'thetis', name: 'Thetis', str: 0.49, pop: 0.9, boss: false, deck: { attack: 7, defense: 4, scheme: 6, boost: 13 } },
  { id: 'gingerbread-man', name: 'Gingerbread Man', str: 0.57, pop: 1.5, boss: false, deck: { attack: 12, defense: 2, scheme: 3, boost: 13 } },
  { id: 'piper-of-the-underroads', name: 'The Piper of the Underroads', str: 0.52, pop: 1.0, boss: false, deck: { attack: 11, defense: 6, scheme: 4, boost: 9 } },
  { id: 'hollow-oak', name: 'The Hollow Oak', str: 0.55, pop: 1.1, boss: false, deck: { attack: 8, defense: 2, scheme: 5, boost: 15 } },
  { id: 'triceratops', name: 'Triceratops', str: 0.53, pop: 1.2, boss: true, deck: { attack: 9, defense: 12, scheme: 3, boost: 6 } },
  { id: 'baba-yaga', name: 'Baba Yaga', str: 0.48, pop: 0.8, boss: false, deck: { attack: 6, defense: 6, scheme: 4, boost: 14 } },
  { id: 'buster-keaton', name: 'Buster Keaton', str: 0.44, pop: 0.7, boss: false, deck: { attack: 4, defense: 8, scheme: 6, boost: 12 } },
  { id: 'general-grievous', name: 'General Grievous', str: 0.58, pop: 1.3, boss: false, deck: { attack: 13, defense: 4, scheme: 3, boost: 10 } },
];

const CARD_NAMES: Record<string, string[]> = {
  attack: ['crushing-blow', 'overreach', 'twist-the-knife', 'sudden-lunge', 'redoubled-assault'],
  defense: ['sidestep', 'iron-guard', 'read-the-room', 'hold-the-line'],
  scheme: ['cruel-bargain', 'vanishing-act', 'turn-the-tables'],
  boost: ['momentum', 'improvise', 'press-the-advantage'],
};

const MAPS = ['saltmarsh-crossing', 'the-ember-court', 'clocktower-rooftops', 'the-sunken-library', 'gallows-green'];
const PILOTS: [string, number, number][] = [
  ['human', 0.6, 0],
  ['bot:easy', 0.08, -0.14],
  ['bot:medium', 0.12, -0.07],
  ['bot:hard', 0.12, 0.02],
  ['bot:gruncle', 0.05, 0.05],
  ['bot:weaver', 0.03, -0.02],
];
const FORMATS: [string, string, number][] = [
  ['duel', '1v1', 0.54],
  ['team-2v2', '2v2', 0.24],
  ['two-v-one-boss', '2v1 Boss', 0.14],
  ['ffa-3', '3FFA', 0.08],
];

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(seed);
const popTotal = HEROES.reduce((sum, hero) => sum + hero.pop, 0);
const bosses = HEROES.filter((hero) => hero.boss);

function pickHero(exclude: string[]): Hero {
  for (let guard = 0; guard < 50; guard++) {
    let r = rnd() * popTotal;
    for (const hero of HEROES) {
      r -= hero.pop;
      if (r <= 0) {
        if (!exclude.includes(hero.id)) return hero;
        break;
      }
    }
  }
  return HEROES.find((hero) => !exclude.includes(hero.id)) ?? HEROES[0]!;
}

function pickPilot(): string {
  let r = rnd();
  for (const [id, freq] of PILOTS) {
    r -= freq;
    if (r <= 0) return id;
  }
  return 'human';
}

function pickFormat(): [string, string] {
  let r = rnd();
  for (const [id, label, freq] of FORMATS) {
    r -= freq;
    if (r <= 0) return [id, label];
  }
  return ['duel', '1v1'];
}

function pilotMod(pilot: string): number {
  return PILOTS.find(([id]) => id === pilot)?.[2] ?? 0;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

type Slot = { hero: Hero; pilot: string };

function slot(hero: Hero): Slot {
  return { hero, pilot: pickPilot() };
}

function teamStrength(team: Slot[]): number {
  const heroStr = team.reduce((sum, s) => sum + s.hero.str, 0) / team.length;
  const pilots = team.reduce((sum, s) => sum + pilotMod(s.pilot), 0) / team.length;
  return heroStr + pilots;
}

function cardsForTeams(teams: Slot[][]): TelemetrySubmission {
  const cardsPlayed: NonNullable<TelemetrySubmission['cardsPlayed']> = [];
  teams.forEach((team, teamIndex) => {
    team.forEach((s, seatIndex) => {
      const deck = s.hero.deck;
      const buckets: [keyof typeof deck, number][] = [
        ['attack', deck.attack],
        ['defense', deck.defense],
        ['scheme', deck.scheme],
        ['boost', deck.boost],
      ];
      const plays = 6 + Math.floor(rnd() * 8);
      const total = buckets.reduce((sum, [, weight]) => sum + weight, 0);
      for (let i = 0; i < plays; i++) {
        let r = rnd() * total;
        let bucket: keyof typeof deck = 'attack';
        for (const [name, weight] of buckets) {
          r -= weight;
          if (r <= 0) { bucket = name; break; }
        }
        cardsPlayed!.push({
          seat: [teamIndex, seatIndex],
          card: pick(CARD_NAMES[bucket]!),
          turn: 1 + Math.floor(rnd() * 12),
          context: bucket,
        });
      }
    });
  });
  return { cardsPlayed };
}

function buildGame(index: number): GameSubmission {
  const [format, formatLabel] = pickFormat();
  const map = pick(MAPS);
  let teams: Slot[][];
  let boss: string | null = null;

  if (format === 'team-2v2') {
    const h1 = pickHero([]);
    const h2 = pickHero([h1.id]);
    const h3 = pickHero([h1.id, h2.id]);
    const h4 = pickHero([h1.id, h2.id, h3.id]);
    teams = [[slot(h1), slot(h2)], [slot(h3), slot(h4)]];
  } else if (format === 'two-v-one-boss') {
    const b = bosses[Math.floor(rnd() * bosses.length)]!;
    boss = b.id;
    const h2 = pickHero([b.id]);
    const h3 = pickHero([b.id, h2.id]);
    teams = [[slot(b)], [slot(h2), slot(h3)]];
  } else if (format === 'ffa-3') {
    const h1 = pickHero([]);
    const h2 = pickHero([h1.id]);
    const h3 = pickHero([h1.id, h2.id]);
    teams = [[slot(h1)], [slot(h2)], [slot(h3)]];
  } else {
    const h1 = pickHero([]);
    const h2 = pickHero([h1.id]);
    teams = [[slot(h1)], [slot(h2)]];
  }

  let winner: number;
  if (teams.length === 2) {
    let pA = 0.5 + (teamStrength(teams[0]!) - teamStrength(teams[1]!)) * 1.6;
    if (format === 'two-v-one-boss') pA += 0.03;
    pA = Math.max(0.08, Math.min(0.92, pA));
    winner = rnd() < pA ? 0 : 1;
  } else {
    const weights = teams.map((team) => Math.exp(teamStrength(team) * 6));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let r = rnd() * totalWeight;
    winner = 0;
    for (let j = 0; j < weights.length; j++) {
      r -= weights[j]!;
      if (r <= 0) { winner = j; break; }
    }
  }

  return {
    schemaVersion: 1,
    gameId: `seed-${seed}-${index}`,
    source: 'ai-lab',
    endedAt: new Date(Date.UTC(2026, 6, 1, 0, index % 3600)).toISOString(),
    format,
    formatLabel,
    boss,
    map,
    mapVersion: '1.0.0',
    teams: teams.map((team, teamIndex) => ({
      ...(format === 'two-v-one-boss' ? { role: teamIndex === 0 ? 'boss' : 'challengers' } : {}),
      seats: team.map((s, seatIndex) => ({
        deck: `${s.hero.id}@${DECK_VERSION}`,
        pilot: s.pilot,
        runtimePlayerId: `p${seatIndex + 1}`,
        heroId: s.hero.id,
        heroName: s.hero.name,
      })),
    })),
    winner,
    endCondition: 'hero_defeated',
    turns: 7 + Math.floor(rnd() * 18),
    firstPlayerTeam: rnd() < 0.5 ? 0 : 1,
    stateHash: `seed-state-${seed}-${index}`,
    telemetry: cardsForTeams(teams),
  };
}

const pool = new Pool({ connectionString: databaseUrl });
const repo = new PgTelemetryRepository(pool);
let created = 0;
let duplicate = 0;
try {
  for (let i = 0; i < count; i++) {
    const game = buildGame(i);
    const result = await repo.ingestValid({
      payload: game,
      idempotencyKey: game.gameId!,
      receivedAt: new Date(),
      authKeyId: 'seed',
    });
    if (result.kind === 'created') created++;
    else duplicate++;
  }
  console.log(JSON.stringify({ ok: true, requested: count, created, duplicate }, null, 2));
} finally {
  await pool.end();
}

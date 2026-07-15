export interface GameSubmission {
  schemaVersion: 1;
  gameId?: string;
  idempotencyKey?: string;
  submittedAt?: string;
  endedAt?: string;
  source?: string;
  format: string;
  formatLabel?: string;
  boss?: string | null;
  map: string;
  mapVersion?: string;
  teams: TeamSubmission[];
  winner: number;
  draw?: boolean;
  endCondition?: string;
  turns?: number;
  durationSeconds?: number;
  firstPlayerTeam?: number;
  engine?: EngineSubmission;
  replayHash?: string;
  stateHash?: string;
  telemetry?: TelemetrySubmission;
  notes?: string | null;
}

export interface EngineSubmission {
  schemaVersion?: number;
  dslVersion?: string;
  protocolVersion?: number;
  contentVersion?: string;
}

export interface TeamSubmission {
  role?: string;
  seats: SeatSubmission[];
}

export interface SeatSubmission {
  deck: string;
  pilot: string;
  runtimePlayerId?: string;
  playerId?: string;
  heroId?: string;
  heroName?: string;
  botDifficulty?: string;
  botVersion?: string;
  finalHealth?: number;
  finalDeckCount?: number;
  finalHandCount?: number;
  finalDiscardCount?: number;
}

export interface TelemetrySubmission {
  cardsPlayed?: { seat: [number, number]; card: string; turn?: number; context?: string }[];
  startingHands?: { seat: [number, number]; cards: string[] }[];
  damageDealt?: { seat: [number, number]; total: number }[];
  finalHealth?: number[][];
}

export interface NormalizedGame {
  id: string;
  schemaVersion: number;
  submittedAt: string | null;
  endedAt: string | null;
  source: string;
  format: string;
  formatLabel: string | null;
  boss: string | null;
  map: string;
  mapVersion: string | null;
  winnerTeam: number | null;
  draw: boolean;
  endCondition: string | null;
  turns: number | null;
  durationSeconds: number | null;
  firstPlayerTeam: number | null;
  engineSchemaVersion: number | null;
  engineDslVersion: string | null;
  protocolVersion: number | null;
  contentVersion: string | null;
  replayHash: string | null;
  stateHash: string | null;
  teams: NormalizedTeam[];
  seats: NormalizedSeat[];
  cards: NormalizedCard[];
  startingCards: NormalizedStartingCard[];
}

export interface NormalizedTeam {
  gameId: string;
  teamIndex: number;
  role: string | null;
  won: boolean;
}

export type CardContextBucket = 'attack' | 'defense' | 'scheme' | 'boost' | 'discard' | 'other';

export interface NormalizedStartingCard {
  gameId: string;
  teamIndex: number;
  seatIndex: number;
  cardIndex: number;
  deck: string;
  deckId: string;
  card: string;
  seatWon: boolean;
}

export interface NormalizedCard {
  gameId: string;
  eventIndex: number;
  teamIndex: number;
  seatIndex: number;
  deck: string;
  deckId: string;
  card: string;
  turn: number | null;
  context: string | null;
  contextBucket: CardContextBucket;
  seatWon: boolean;
}

export interface NormalizedSeat {
  gameId: string;
  teamIndex: number;
  seatIndex: number;
  runtimePlayerId: string | null;
  deck: string;
  deckId: string;
  deckVersion: string;
  heroId: string | null;
  heroName: string | null;
  pilot: string;
  pilotKind: 'human' | 'bot' | 'unknown';
  botId: string | null;
  botDifficulty: string | null;
  botVersion: string | null;
  playerId: string | null;
  firstPlayer: boolean;
  won: boolean;
  finalHealth: number | null;
  finalDeckCount: number | null;
  finalHandCount: number | null;
  finalDiscardCount: number | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface IngestCreated {
  kind: 'created';
  submissionId: string;
  gameId: string;
}

export interface IngestDuplicate {
  kind: 'duplicate';
  submissionId: string;
  gameId: string | null;
}

export interface IngestInvalid {
  kind: 'invalid';
  submissionId: string;
  errors: string[];
}

export type IngestResult = IngestCreated | IngestDuplicate | IngestInvalid;

export interface DeckDefinitionCard {
  id?: string;
  title?: string;
  type: 'attack' | 'defense' | 'versatile' | 'scheme';
  value?: number | null;
  boost?: number | null;
  quantity: number;
}

export interface DeckDefinitionSubmission {
  schemaVersion: 1;
  source?: string;
  contentVersion?: string;
  decks: {
    deckId: string;
    version: string;
    name?: string;
    tier?: string;
    cards: DeckDefinitionCard[];
  }[];
}

/**
 * Authoritative deck make-up from the pushed deck registry (`deck_definitions`),
 * i.e. the real printed card list — distinct from the play-derived DeckProfile.
 * The dashboard prefers this when present and falls back to the profile.
 */
export interface DeckComposition {
  version: string;
  name: string | null;
  tier: string | null;
  cardCount: number;
  attack: number;
  defense: number;
  versatile: number;
  scheme: number;
  attackValue: number;
  defenseValue: number;
  lean: 'Offensive' | 'Defensive' | 'Balanced' | null;
}

/**
 * How a deck actually spends its cards, derived from telemetry.cardsPlayed.
 * Shares sum to ~1 across the buckets. Replaces the static deck composition
 * shown in the design mock with a real, play-derived profile.
 */
export interface DeckProfile {
  plays: number;
  attack: number;
  defense: number;
  scheme: number;
  boost: number;
  other: number;
  lean: 'Offensive' | 'Defensive' | 'Balanced' | null;
}

export interface DeckStat {
  deck: string;
  deckId: string;
  deckVersion: string;
  label: string;
  heroId: string | null;
  heroName: string | null;
  games: number;
  wins: number;
  pickRate: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
  profile: DeckProfile | null;
  composition: DeckComposition | null;
}

export interface DashboardBossStat {
  boss: string;
  games: number;
  wins: number;
  winRate: number;
}

export interface DashboardFormatStat {
  format: string;
  label: string;
  games: number;
  share: number;
  avgTurns: number | null;
  bossGames: number;
  bossWins: number;
  bossWinRate: number | null;
  bosses: DashboardBossStat[];
}

export interface DashboardMapStat {
  map: string;
  mapVersion: string | null;
  games: number;
  share: number;
}

export interface DashboardPilotStat {
  pilot: string;
  pilotKind: 'human' | 'bot' | 'unknown';
  seats: number;
}

export interface DashboardMatchupStat {
  rowDeck: string;
  rowDeckId: string;
  colDeck: string;
  colDeckId: string;
  games: number;
  wins: number;
  winRate: number;
  avgTurns: number | null;
  avgFinalHealth: number | null;
  avgCardsLeft: number | null;
}

export interface DashboardSynergyStat {
  deckA: string;
  deckAId: string;
  deckB: string;
  deckBId: string;
  games: number;
  wins: number;
  winRate: number;
  expectedWinRate: number;
  delta: number;
}

export interface SynergyOpponentPair {
  deckA: string;
  deckB: string;
  games: number;
  wins: number;
  winRate: number;
}

export interface SynergyOpponentDeck {
  deck: string;
  games: number;
  wins: number;
  winRate: number;
}

export interface SynergyPairMatchupsResponse {
  found: boolean;
  deckA: string;
  deckB: string;
  totalGames: number;
  pairs: SynergyOpponentPair[];
  decks: SynergyOpponentDeck[];
}

export interface DashboardFirstPlayerStat {
  games: number;
  wins: number;
  winRate: number | null;
}

export interface DashboardStatsResponse {
  generatedAt: string;
  selectedFormat: string | null;
  selectedPilots: string[];
  totalGames: number;
  totalSubmissions: number;
  invalidSubmissions: number;
  avgTurns: number | null;
  firstPlayer: DashboardFirstPlayerStat;
  formats: DashboardFormatStat[];
  maps: DashboardMapStat[];
  pilots: DashboardPilotStat[];
  decks: DeckStat[];
  matchups: DashboardMatchupStat[];
  synergy: DashboardSynergyStat[];
}

export interface DeckStatsResponse {
  totalGames: number;
  avgTurns: number | null;
  decks: DeckStat[];
}

export interface ScenarioExplorerPartner {
  deck: string;
  deckId: string;
  label: string;
  games: number;
  wins: number;
  winRate: number;
  expectedWinRate: number;
  adjustedDelta: number;
}

export interface ScenarioExplorerMatchup {
  opponentA: string;
  opponentAId: string;
  opponentALabel: string;
  opponentB: string;
  opponentBId: string;
  opponentBLabel: string;
  games: number;
  wins: number;
  winRate: number;
  expectedWinRate: number;
  adjustedDelta: number;
}

export interface ScenarioExplorerResponse {
  totalGames: number;
  partners: ScenarioExplorerPartner[];
  matchups: ScenarioExplorerMatchup[];
}

export interface RecentGameSeat {
  teamIndex: number;
  seatIndex: number;
  deck: string;
  deckId: string;
  heroName: string | null;
  pilot: string;
  pilotKind: 'human' | 'bot' | 'unknown';
  won: boolean;
}

export interface RecentGameTeam {
  teamIndex: number;
  role: string | null;
  won: boolean;
  seats: RecentGameSeat[];
}

export interface RecentGame {
  gameId: string;
  receivedAt: string;
  endedAt: string | null;
  source: string;
  format: string;
  formatLabel: string;
  map: string;
  winnerTeam: number | null;
  draw: boolean;
  turns: number | null;
  teams: RecentGameTeam[];
}

export interface RecentGamesResponse {
  games: RecentGame[];
}

export interface SplitStat {
  games: number;
  wins: number;
  winRate: number | null;
}

/** A deck's win rate when it took the first turn vs when it went second. */
export interface DeckFirstPlayerSplit {
  first: SplitStat;
  second: SplitStat;
}

export interface DeckFormatWinRate {
  format: string;
  label: string;
  games: number;
  wins: number;
  winRate: number;
  avgFinalHealth: number | null;
  avgWinFinalHealth: number | null;
  avgCardsLeft: number | null;
  avgWinCardsLeft: number | null;
  avgLossCardsLeft: number | null;
  avgWinTurns: number | null;
  avgLossTurns: number | null;
  firstPlayer: DeckFirstPlayerSplit;
}

export interface DeckMapWinRate {
  map: string;
  mapVersion: string | null;
  games: number;
  wins: number;
  winRate: number;
}

export interface DeckMatchupWinRate {
  deck: string;
  deckId: string;
  label: string;
  games: number;
  wins: number;
  winRate: number;
}

export interface DeckCardInfluence {
  card: string;
  contextBucket: CardContextBucket;
  plays: number;
  gamesWith: number;
  winsWith: number;
  winRateWith: number;
  baselineWinRate: number;
  influence: number;
}

export interface DeckTwoVTwoPartner {
  deck: string;
  deckId: string;
  label: string;
  games: number;
  wins: number;
  winRate: number;
  expectedWinRate: number;
  /** Backward-compatible raw delta: partner win rate minus this deck's overall 2v2 win rate. */
  delta: number;
  rawDelta: number;
  /** Average actual result minus expected result against the opposing pair's smoothed strength. */
  adjustedDelta: number;
}

export interface DeckTwoVTwoSummary {
  games: number;
  wins: number;
  winRate: number | null;
  partners: DeckTwoVTwoPartner[];
}

export interface DeckDetailResponse {
  found: boolean;
  deck: string;
  deckId: string;
  deckVersion: string | null;
  label: string;
  heroId: string | null;
  heroName: string | null;
  games: number;
  wins: number;
  pickRate: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
  profile: DeckProfile | null;
  composition: DeckComposition | null;
  avgFinalHealth: number | null;
  avgWinFinalHealth: number | null;
  avgCardsLeft: number | null;
  avgWinCardsLeft: number | null;
  avgLossCardsLeft: number | null;
  avgWinTurns: number | null;
  avgLossTurns: number | null;
  firstPlayer: DeckFirstPlayerSplit;
  formats: DeckFormatWinRate[];
  maps: DeckMapWinRate[];
  matchups: DeckMatchupWinRate[];
  twoVTwo: DeckTwoVTwoSummary;
  startingCards: DeckCardInfluence[];
  cards: DeckCardInfluence[];
}

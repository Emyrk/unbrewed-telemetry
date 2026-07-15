import type {
  CardContextBucket,
  GameSubmission,
  NormalizedCard,
  NormalizedGame,
  NormalizedSeat,
  NormalizedStartingCard,
  NormalizedTeam,
} from '../types.js';

export function cardContextBucket(context: string | null | undefined): CardContextBucket {
  switch (context) {
    case 'attack':
      return 'attack';
    case 'defense':
      return 'defense';
    case 'scheme':
      return 'scheme';
    case 'boost':
      return 'boost';
    case 'discard':
      return 'discard';
    default:
      return 'other';
  }
}

function nullableString(value: string | null | undefined): string | null {
  return value === undefined ? null : value;
}

function nullableNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function splitDeck(deck: string): { deckId: string; deckVersion: string } {
  const at = deck.indexOf('@');
  return { deckId: deck.slice(0, at), deckVersion: deck.slice(at + 1) };
}

function pilotParts(pilot: string): { pilotKind: 'human' | 'bot' | 'unknown'; botId: string | null } {
  if (pilot === 'human') return { pilotKind: 'human', botId: null };
  if (pilot.startsWith('bot:')) return { pilotKind: 'bot', botId: pilot.slice('bot:'.length) };
  return { pilotKind: 'unknown', botId: null };
}

function finalHealthFromTelemetry(submission: GameSubmission, teamIndex: number, seatIndex: number): number | null {
  return submission.telemetry?.finalHealth?.[teamIndex]?.[seatIndex] ?? null;
}

export function normalizeSubmission(
  submission: GameSubmission,
  idempotencyKey: string,
): NormalizedGame {
  const gameId = submission.gameId ?? submission.idempotencyKey ?? idempotencyKey;
  const draw = submission.draw ?? false;
  const winnerTeam = draw ? null : submission.winner;
  const source = submission.source ?? 'unknown';

  const teams: NormalizedTeam[] = submission.teams.map((team, teamIndex) => ({
    gameId,
    teamIndex,
    role: team.role ?? (submission.boss && teamIndex === 0 ? 'boss' : null),
    won: winnerTeam === teamIndex,
  }));

  const seats: NormalizedSeat[] = [];
  submission.teams.forEach((team, teamIndex) => {
    team.seats.forEach((seat, seatIndex) => {
      const { deckId, deckVersion } = splitDeck(seat.deck);
      const { pilotKind, botId } = pilotParts(seat.pilot);
      const explicitFinalHealth = seat.finalHealth ?? finalHealthFromTelemetry(submission, teamIndex, seatIndex);
      seats.push({
        gameId,
        teamIndex,
        seatIndex,
        runtimePlayerId: nullableString(seat.runtimePlayerId),
        deck: seat.deck,
        deckId,
        deckVersion,
        heroId: nullableString(seat.heroId),
        heroName: nullableString(seat.heroName),
        pilot: seat.pilot,
        pilotKind,
        botId,
        botDifficulty: nullableString(seat.botDifficulty),
        botVersion: nullableString(seat.botVersion),
        playerId: nullableString(seat.playerId),
        firstPlayer: submission.firstPlayerTeam === teamIndex,
        won: winnerTeam === teamIndex,
        finalHealth: explicitFinalHealth,
        finalDeckCount: nullableNumber(seat.finalDeckCount),
        finalHandCount: nullableNumber(seat.finalHandCount),
        finalDiscardCount: nullableNumber(seat.finalDiscardCount),
      });
    });
  });

  const seatIndex = new Map<string, NormalizedSeat>();
  for (const seat of seats) seatIndex.set(`${seat.teamIndex}:${seat.seatIndex}`, seat);

  const startingCards: NormalizedStartingCard[] = [];
  const startingHands = submission.telemetry?.startingHands ?? [];
  startingHands.forEach((entry) => {
    const [teamIndex, seatIdx] = entry.seat;
    const seat = seatIndex.get(`${teamIndex}:${seatIdx}`);
    if (!seat) return; // semantic validation rejects unknown seats before ingest
    entry.cards.forEach((card, cardIndex) => {
      startingCards.push({
        gameId,
        teamIndex,
        seatIndex: seatIdx,
        cardIndex,
        deck: seat.deck,
        deckId: seat.deckId,
        card,
        seatWon: winnerTeam === teamIndex,
      });
    });
  });

  const cards: NormalizedCard[] = [];
  const cardsPlayed = submission.telemetry?.cardsPlayed ?? [];
  cardsPlayed.forEach((event, eventIndex) => {
    const [teamIndex, seatIdx] = event.seat;
    const seat = seatIndex.get(`${teamIndex}:${seatIdx}`);
    if (!seat) return; // semantic validation rejects unknown seats before ingest
    cards.push({
      gameId,
      eventIndex,
      teamIndex,
      seatIndex: seatIdx,
      deck: seat.deck,
      deckId: seat.deckId,
      card: event.card,
      turn: nullableNumber(event.turn),
      context: nullableString(event.context),
      contextBucket: cardContextBucket(event.context),
      seatWon: winnerTeam === teamIndex,
    });
  });

  return {
    id: gameId,
    schemaVersion: submission.schemaVersion,
    submittedAt: nullableString(submission.submittedAt),
    endedAt: nullableString(submission.endedAt),
    source,
    format: submission.format,
    formatLabel: nullableString(submission.formatLabel),
    boss: nullableString(submission.boss),
    map: submission.map,
    mapVersion: nullableString(submission.mapVersion),
    winnerTeam,
    draw,
    endCondition: nullableString(submission.endCondition),
    turns: nullableNumber(submission.turns),
    durationSeconds: nullableNumber(submission.durationSeconds),
    firstPlayerTeam: nullableNumber(submission.firstPlayerTeam),
    engineSchemaVersion: nullableNumber(submission.engine?.schemaVersion),
    engineDslVersion: nullableString(submission.engine?.dslVersion),
    protocolVersion: nullableNumber(submission.engine?.protocolVersion),
    contentVersion: nullableString(submission.engine?.contentVersion),
    replayHash: nullableString(submission.replayHash),
    stateHash: nullableString(submission.stateHash),
    teams,
    seats,
    cards,
    startingCards,
  };
}

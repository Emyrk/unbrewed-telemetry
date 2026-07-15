import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { GameSubmission, ValidationResult } from '../types.js';

const schemaUrl = new URL('../../schemas/game-submission.v1.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as object;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validate = ajv.compile(schema);

function formatAjvError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty ?? 'unknown';
    return `${path}: unexpected property ${extra}`;
  }
  return `${path}: ${error.message ?? error.keyword}`;
}

function seatExists(submission: GameSubmission, ref: readonly [number, number]): boolean {
  const [teamIndex, seatIndex] = ref;
  return submission.teams[teamIndex]?.seats[seatIndex] !== undefined;
}

function semanticErrors(submission: GameSubmission): string[] {
  const errors: string[] = [];
  if (submission.winner >= submission.teams.length) {
    errors.push(`/winner: ${submission.winner} is not a valid team index`);
  }
  if (submission.firstPlayerTeam !== undefined && submission.firstPlayerTeam >= submission.teams.length) {
    errors.push(`/firstPlayerTeam: ${submission.firstPlayerTeam} is not a valid team index`);
  }
  const cardsPlayed = submission.telemetry?.cardsPlayed ?? [];
  for (let i = 0; i < cardsPlayed.length; i++) {
    const event = cardsPlayed[i]!;
    if (!seatExists(submission, event.seat)) {
      errors.push(`/telemetry/cardsPlayed/${i}/seat: seat does not exist`);
    }
  }
  const startingHands = submission.telemetry?.startingHands ?? [];
  for (let i = 0; i < startingHands.length; i++) {
    const entry = startingHands[i]!;
    if (!seatExists(submission, entry.seat)) {
      errors.push(`/telemetry/startingHands/${i}/seat: seat does not exist`);
    }
  }
  const damageDealt = submission.telemetry?.damageDealt ?? [];
  for (let i = 0; i < damageDealt.length; i++) {
    const event = damageDealt[i]!;
    if (!seatExists(submission, event.seat)) {
      errors.push(`/telemetry/damageDealt/${i}/seat: seat does not exist`);
    }
  }
  const finalHealth = submission.telemetry?.finalHealth;
  if (finalHealth) {
    if (finalHealth.length !== submission.teams.length) {
      errors.push('/telemetry/finalHealth: team count does not match teams');
    }
    for (let teamIndex = 0; teamIndex < finalHealth.length; teamIndex++) {
      const expectedSeats = submission.teams[teamIndex]?.seats.length;
      if (expectedSeats !== undefined && finalHealth[teamIndex]!.length !== expectedSeats) {
        errors.push(`/telemetry/finalHealth/${teamIndex}: seat count does not match team`);
      }
    }
  }
  return errors;
}

export function validateGameSubmission(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as GameSubmission);
  return { ok: errors.length === 0, errors };
}

export function isGameSubmission(value: unknown): value is GameSubmission {
  return validateGameSubmission(value).ok;
}

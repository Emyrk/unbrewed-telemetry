import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { GameReplaySubmission, ValidationResult } from '../types.js';

const schemaUrl = new URL('../../schemas/game-replay.v1.schema.json', import.meta.url);
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

/** Player-identity keys a replay must never carry, at any depth. */
const FORBIDDEN_ANYWHERE = new Set(['displayName', 'playerName', 'email']);

function collectForbiddenKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, found);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ANYWHERE.has(key)) found.add(key);
    collectForbiddenKeys(child, found);
  }
}

/**
 * Privacy the JSON Schema cannot express without enumerating the engine-owned
 * `config`: the game-submission schema already forbids display names on seats,
 * and a replay must not become the back door. `name` is only forbidden as a
 * direct key of a seat (`config.players.<seat>.name`) — deeper it is rules
 * content (hero names, counters, effect ops) and every real bundle carries it.
 */
function semanticErrors(submission: GameReplaySubmission): string[] {
  const found = new Set<string>();
  collectForbiddenKeys(submission.bundle, found);
  const players = submission.bundle.config.players;
  if (players !== null && typeof players === 'object' && !Array.isArray(players)) {
    for (const seat of Object.values(players)) {
      if (seat !== null && typeof seat === 'object' && Object.hasOwn(seat, 'name')) found.add('name');
    }
  }
  return [...found].map((key) => `/bundle: forbidden key ${key}`);
}

export function validateGameReplay(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as GameReplaySubmission);
  return { ok: errors.length === 0, errors };
}

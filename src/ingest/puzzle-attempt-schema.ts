import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { PuzzleAttemptSubmission, ValidationResult } from '../types.js';

const schemaUrl = new URL('../../schemas/puzzle-attempt.v1.schema.json', import.meta.url);
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

/**
 * Strings Postgres cannot store: `text` and `jsonb` both refuse a NUL, and
 * `jsonb` refuses a lone surrogate. Without this they would pass validation
 * and fail the insert as a 500. Checks character content only, never key
 * names, so it cannot reject a real engine action.
 */
const UNSTORABLE = /\u0000|\p{Surrogate}/u;

function hasUnstorableString(value: unknown): boolean {
  if (typeof value === 'string') return UNSTORABLE.test(value);
  if (Array.isArray(value)) return value.some(hasUnstorableString);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => UNSTORABLE.test(key) || hasUnstorableString(child));
}

/** A timestamp `timestamptz` accepts: parseable (no leap second) and not year 0000. */
function storableTime(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 1) return null;
  return ms;
}

/**
 * What the JSON Schema cannot say: the payload must be storable, and an
 * attempt cannot end before it started. `actions[].action` is otherwise not
 * inspected — it is the engine's action JSON verbatim, and its size is bounded
 * by the route's body limit.
 */
function semanticErrors(attempt: PuzzleAttemptSubmission): string[] {
  const errors: string[] = [];
  if (hasUnstorableString(attempt)) {
    errors.push('/: strings must not contain a NUL character or a lone surrogate');
  }
  const started = storableTime(attempt.started_at);
  const ended = storableTime(attempt.ended_at);
  if (started === null) errors.push('/started_at: not a storable timestamp');
  if (ended === null) errors.push('/ended_at: not a storable timestamp');
  if (started !== null && ended !== null && ended < started) {
    errors.push('/ended_at: must not be before started_at');
  }
  return errors;
}

export function validatePuzzleAttempt(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as PuzzleAttemptSubmission);
  return { ok: errors.length === 0, errors };
}

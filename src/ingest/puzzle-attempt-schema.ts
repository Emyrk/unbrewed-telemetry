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

/**
 * How deep an `action` may nest, counting the action object itself as level 1.
 * Real engine actions are a few levels deep. Without a cap a signed body of
 * tens of thousands of nested arrays overflowed this walker's stack (and
 * Postgres's jsonb parser behind it) and came back as a 500.
 */
export const MAX_ACTION_DEPTH = 32;

/** An action sits three containers down: attempt → `actions` → entry → `action`. */
const MAX_PAYLOAD_DEPTH = MAX_ACTION_DEPTH + 3;

interface PayloadScan {
  unstorable: boolean;
  tooDeep: boolean;
}

/**
 * One bounded walk over the payload: flags an unstorable string (value or key)
 * and a container nested past `depthLeft`, which it does not descend into.
 */
function scanPayload(value: unknown, depthLeft: number, found: PayloadScan): void {
  if (typeof value === 'string') {
    if (UNSTORABLE.test(value)) found.unstorable = true;
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (depthLeft === 0) {
    found.tooDeep = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) scanPayload(child, depthLeft - 1, found);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (UNSTORABLE.test(key)) found.unstorable = true;
    scanPayload(child, depthLeft - 1, found);
  }
}

/** A timestamp `timestamptz` accepts: parseable (no leap second) and not year 0000. */
function storableTime(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 1) return null;
  return ms;
}

/**
 * What the JSON Schema cannot say: the payload must be storable, an attempt
 * cannot end before it started, and one that was shown the solution is not a
 * solve. `actions[].action` is otherwise not inspected — it is the engine's
 * action JSON verbatim; its size is bounded by the route's body limit and its
 * nesting by `MAX_ACTION_DEPTH`.
 */
function semanticErrors(attempt: PuzzleAttemptSubmission): string[] {
  const errors: string[] = [];
  const found: PayloadScan = { unstorable: false, tooDeep: false };
  scanPayload(attempt, MAX_PAYLOAD_DEPTH, found);
  if (found.unstorable) {
    errors.push('/: strings must not contain a NUL character or a lone surrogate');
  }
  if (found.tooDeep) {
    errors.push(`/actions: an action must not nest deeper than ${MAX_ACTION_DEPTH} levels`);
  }
  // The engine rewrites such an attempt to `failed` before posting. Enforced
  // here too, so no `solved` row was shown the solution and the stats can
  // count `result` alone (#116).
  if (attempt.result === 'solved' && attempt.solution_shown) {
    errors.push('/result: must not be solved when solution_shown is true');
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

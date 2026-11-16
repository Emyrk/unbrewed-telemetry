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
 * What the JSON Schema cannot say: an attempt cannot end before it started.
 * `actions[].action` is deliberately not inspected — it is the engine's action
 * JSON verbatim, and its size is bounded by the route's body limit.
 */
function semanticErrors(attempt: PuzzleAttemptSubmission): string[] {
  if (Date.parse(attempt.ended_at) < Date.parse(attempt.started_at)) {
    return ['/ended_at: must not be before started_at'];
  }
  return [];
}

export function validatePuzzleAttempt(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as PuzzleAttemptSubmission);
  return { ok: errors.length === 0, errors };
}

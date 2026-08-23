import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { QueueEventsSubmission, ValidationResult } from '../types.js';

const schemaUrl = new URL('../../schemas/queue-events.v1.schema.json', import.meta.url);
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
 * Field/type agreement the JSON Schema deliberately leaves out: `waitMs` and
 * `reason` are declared once for every event type, and which types may carry
 * them is asserted here so the error message names the offending event rather
 * than an if/then branch.
 */
function semanticErrors(submission: QueueEventsSubmission): string[] {
  const errors: string[] = [];
  submission.events.forEach((event, i) => {
    if (event.waitMs !== undefined && event.type === 'search_started') {
      errors.push(`/events/${i}/waitMs: only matched and abandoned events carry a wait`);
    }
    if (event.reason !== undefined && event.type !== 'abandoned') {
      errors.push(`/events/${i}/reason: only abandoned events carry a reason`);
    }
  });
  return errors;
}

export function validateQueueEvents(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as QueueEventsSubmission);
  return { ok: errors.length === 0, errors };
}

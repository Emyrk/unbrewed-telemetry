import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { SandboxEvent, SandboxEventType, SandboxEventsSubmission, ValidationResult } from '../types.js';

const schemaUrl = new URL('../../schemas/sandbox-events.v1.schema.json', import.meta.url);
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

type OptionalField = Exclude<keyof SandboxEvent, 'eventId' | 'type' | 'roomId' | 'ts'>;

const OPTIONAL_FIELDS: readonly OptionalField[] = [
  'playerHash',
  'connections',
  'heroName',
  'reason',
  'lifetimeMs',
  'distinctPlayers',
  'peakConnections',
  'stateUpdates',
];

/** The per-type fields: each type requires exactly these and carries no others. */
const FIELDS_BY_TYPE: Record<SandboxEventType, readonly OptionalField[]> = {
  room_opened: [],
  player_joined: ['playerHash', 'connections'],
  player_left: ['playerHash', 'connections'],
  hero_seen: ['playerHash', 'heroName'],
  room_closed: ['reason', 'lifetimeMs', 'distinctPlayers', 'peakConnections', 'stateUpdates'],
};

/**
 * Field/type agreement the JSON Schema deliberately leaves out: every optional
 * field is declared once for all event types, and which types require (and
 * may carry) it is asserted here so the error names the offending event rather
 * than an if/then branch. Same split as the queue-events validator.
 */
function semanticErrors(submission: SandboxEventsSubmission): string[] {
  const errors: string[] = [];
  submission.events.forEach((event, i) => {
    const allowed = FIELDS_BY_TYPE[event.type];
    for (const field of OPTIONAL_FIELDS) {
      const present = event[field] !== undefined;
      if (allowed.includes(field) && !present) {
        errors.push(`/events/${i}/${field}: required on ${event.type} events`);
      } else if (!allowed.includes(field) && present) {
        errors.push(`/events/${i}/${field}: not carried by ${event.type} events`);
      }
    }
  });
  return errors;
}

export function validateSandboxEvents(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as SandboxEventsSubmission);
  return { ok: errors.length === 0, errors };
}

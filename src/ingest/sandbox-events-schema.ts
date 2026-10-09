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

function formatAjvError(error: ErrorObject): string | null {
  const path = error.instancePath || '/';
  // The room_opened/lobbyHash if/then: its own "must match then/else" line
  // adds nothing, and the else branch's bare "boolean schema is false" says
  // nothing.
  if (error.keyword === 'if') return null;
  if (error.keyword === 'false schema' && error.schemaPath.endsWith('/else/properties/lobbyHash/false schema')) {
    return `${path}: not carried by events other than room_opened`;
  }
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty ?? 'unknown';
    return `${path}: unexpected property ${extra}`;
  }
  return `${path}: ${error.message ?? error.keyword}`;
}

type OptionalField = Exclude<keyof SandboxEvent, 'eventId' | 'type' | 'roomId' | 'ts'>;

const OPTIONAL_FIELDS: readonly OptionalField[] = [
  'lobbyHash',
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
  room_opened: ['lobbyHash'],
  player_joined: ['playerHash', 'connections'],
  player_left: ['playerHash', 'connections'],
  hero_seen: ['playerHash', 'heroName'],
  room_closed: ['reason', 'lifetimeMs', 'distinctPlayers', 'peakConnections', 'stateUpdates'],
};

/**
 * Field/type agreement: every optional field is declared once for all event
 * types, and which types require (and may carry) it is asserted here so the
 * error names the offending event rather than an if/then branch. Same split as
 * the queue-events validator. `lobbyHash` is also pinned to `room_opened` by
 * an if/then in the schema itself, so a copy of the schema alone (the relay
 * keeps one in its testdata) enforces it too.
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
    return {
      ok: false,
      errors: (validate.errors ?? []).map(formatAjvError).filter((e): e is string => e !== null),
    };
  }
  const errors = semanticErrors(value as SandboxEventsSubmission);
  return { ok: errors.length === 0, errors };
}

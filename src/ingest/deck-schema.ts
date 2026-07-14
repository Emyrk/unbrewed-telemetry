import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import type { DeckDefinitionSubmission, ValidationResult } from '../types.js';

const schemaUrl = new URL('../../schemas/deck-definitions.v1.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as object;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function formatAjvError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty ?? 'unknown';
    return `${path}: unexpected property ${extra}`;
  }
  return `${path}: ${error.message ?? error.keyword}`;
}

function semanticErrors(submission: DeckDefinitionSubmission): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  submission.decks.forEach((deck, i) => {
    const key = `${deck.deckId}@${deck.version}`;
    if (seen.has(key)) errors.push(`/decks/${i}: duplicate deck ${key} in batch`);
    seen.add(key);
  });
  return errors;
}

export function validateDeckDefinitions(value: unknown): ValidationResult {
  const ok = validate(value);
  if (!ok) {
    return { ok: false, errors: (validate.errors ?? []).map(formatAjvError) };
  }
  const errors = semanticErrors(value as DeckDefinitionSubmission);
  return { ok: errors.length === 0, errors };
}

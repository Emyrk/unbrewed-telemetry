import { readFile } from 'node:fs/promises';
import { LOCAL_DEV_TELEMETRY_SECRET, loadEnvFile } from '../src/config.js';
import { signBody } from '../src/http/auth.js';

loadEnvFile();

const telemetryUrl = process.env.TELEMETRY_URL ?? 'http://localhost:8788/v1/games';
const apiKey = process.env.TELEMETRY_API_KEY?.trim();
const secret = process.env.TELEMETRY_SECRET ?? LOCAL_DEV_TELEMETRY_SECRET;
const file = process.env.SAMPLE_GAME_FILE ?? new URL('../examples/sample-game.json', import.meta.url).pathname;
const body = await readFile(file);
const headers: Record<string, string> = {
  'content-type': 'application/json',
  'idempotency-key': `sample:${Date.now()}`,
};
if (apiKey) {
  headers.authorization = `Bearer ${apiKey}`;
} else {
  const { timestamp, signature } = signBody(secret, body);
  headers['x-unbrewed-timestamp'] = timestamp;
  headers['x-unbrewed-signature'] = signature;
}

const response = await fetch(telemetryUrl, {
  method: 'POST',
  headers,
  body,
});

const text = await response.text();
console.log(`${response.status} ${response.statusText}`);
console.log(text);
if (!response.ok) process.exitCode = 1;

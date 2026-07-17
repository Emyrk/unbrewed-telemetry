import { describe, expect, it } from 'vitest';
import { commandLineSourceName } from '../src/source-name.js';

describe('commandLineSourceName', () => {
  it('uses TELEMETRY_SOURCE when set', () => {
    expect(commandLineSourceName({ TELEMETRY_SOURCE: 'sim-laptop' })).toBe('sim-laptop');
  });

  it('trims TELEMETRY_SOURCE and falls back when it is blank', () => {
    expect(commandLineSourceName({ TELEMETRY_SOURCE: '  sim-box  ' })).toBe('sim-box');
    expect(commandLineSourceName({ TELEMETRY_SOURCE: '   ' })).toMatch(/^[^:]+:[^:]+:lab$/);
  });
});

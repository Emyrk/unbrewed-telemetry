import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('submissions source labels UI', () => {
  it('renders nested credential labels beneath each source', async () => {
    const script = await readFile(new URL('../public/assets/dashboard.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/assets/dashboard.css', import.meta.url), 'utf8');

    expect(script).toContain('grouped by source and key label');
    expect(script).toContain('source.credentials || []');
    expect(script).toContain('credential.label');
    expect(script).toContain('credential.submissions, source.submissions');
    expect(script).toContain('source-credential-row');
    expect(css).toContain('.source-credential-row');
    expect(css).toContain('.source-credential-branch');
  });
});

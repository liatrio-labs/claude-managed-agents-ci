import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

describe('static prompt lint', () => {
  it('passes for the example agent', () => {
    expect(existsSync('agents/example-agent/agent.yaml')).toBe(true);
    const out = execSync('pnpm -s agents:lint-prompts', {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(out).toContain('OK');
  });
});

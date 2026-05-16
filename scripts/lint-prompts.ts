#!/usr/bin/env tsx
/**
 * Static linter for system prompts. Runs in CI without calling any model —
 * fast pre-flight that catches obvious problems before the AI reviewer runs.
 *
 * Checks:
 *   - File exists and is non-empty
 *   - No leftover TODO/FIXME/XXX
 *   - No leaked secret-shaped strings (sk-..., AKIA..., ghp_..., etc.)
 *   - Reasonable size (warn > 10k chars; fail > 50k)
 *   - Has a clearly delimited "Role" or opening section
 *   - Mentions a refusal policy when destructive tools are configured
 *   - Mentions tool-result untrusted-data handling when tools are configured
 *
 * "Tool" detection is based on the agent.yaml `agent.tools[].type` field,
 * which mirrors the Managed Agents API shape (e.g. `agent_toolset_20260401`,
 * `bash`, `web_search`, custom tool types).
 */
import { listAgentDirs, loadAgent } from './lib/config.js';

interface Finding {
  agent: string;
  level: 'error' | 'warn';
  message: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, 'Anthropic-style API key'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS access key'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'GitHub PAT'],
  [/-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/g, 'Private key block'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
];

function lintAgent(id: string): Finding[] {
  const findings: Finding[] = [];
  const { config, systemPrompt } = loadAgent(id);

  if (systemPrompt.trim().length === 0) {
    findings.push({ agent: id, level: 'error', message: 'system prompt is empty' });
  }
  if (systemPrompt.length > 50_000) {
    findings.push({
      agent: id,
      level: 'error',
      message: `system prompt is ${systemPrompt.length} chars (>50k) — split or condense`,
    });
  } else if (systemPrompt.length > 10_000) {
    findings.push({
      agent: id,
      level: 'warn',
      message: `system prompt is ${systemPrompt.length} chars (>10k); review for bloat`,
    });
  }

  for (const m of systemPrompt.matchAll(/\b(TODO|FIXME|XXX)\b/g)) {
    findings.push({ agent: id, level: 'warn', message: `Leftover ${m[1]} marker in prompt` });
  }

  for (const [pat, label] of SECRET_PATTERNS) {
    if (pat.test(systemPrompt)) {
      findings.push({ agent: id, level: 'error', message: `Possible leaked credential: ${label}` });
    }
  }

  const toolTypes = (config.agent.tools ?? []).map((t) => t.type);
  const hasTools =
    toolTypes.length > 0 ||
    (config.agent.mcp_servers?.length ?? 0) > 0 ||
    (config.agent.skills?.length ?? 0) > 0;

  if (hasTools) {
    const lower = systemPrompt.toLowerCase();
    if (!lower.includes('tool result') && !lower.includes('tool output')) {
      findings.push({
        agent: id,
        level: 'warn',
        message:
          'Agent has tools/MCP/skills but prompt does not address tool-result handling (untrusted data, prompt injection).',
      });
    }
    const destructive = toolTypes.some((t) =>
      /(bash|shell|delete|destroy|drop|exec|write|edit|file)/i.test(t),
    );
    if (destructive && !lower.includes('confirm')) {
      findings.push({
        agent: id,
        level: 'warn',
        message:
          'Destructive-capable tool present (e.g. bash/file ops) but prompt does not mention confirmation / refusal policy.',
      });
    }
  }

  if (!/\brole\b|\byou are\b/i.test(systemPrompt.slice(0, 500))) {
    findings.push({
      agent: id,
      level: 'warn',
      message: 'Prompt opening has no clear role statement ("You are…" / Role:).',
    });
  }

  return findings;
}

function main(): void {
  const ids = listAgentDirs();
  if (ids.length === 0) {
    console.log('No agents found to lint.');
    return;
  }
  let errors = 0;
  for (const id of ids) {
    const findings = lintAgent(id);
    if (findings.length === 0) {
      console.log(`[${id}] OK`);
      continue;
    }
    for (const f of findings) {
      const tag = f.level === 'error' ? 'ERROR' : 'warn';
      console.log(`[${id}] ${tag}: ${f.message}`);
      if (f.level === 'error') errors++;
    }
  }
  if (errors > 0) {
    console.error(`\nPrompt lint failed with ${errors} error(s).`);
    process.exit(1);
  }
}

main();

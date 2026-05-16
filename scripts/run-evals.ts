#!/usr/bin/env tsx
/**
 * Behavioral eval runner for Claude Managed Agents.
 *
 * Two execution modes:
 *
 *   --mode=messages  (default in CI)
 *     Calls the Messages API directly with the agent's `system` prompt
 *     and `model`. Fast, cheap, no environment, no tools. Good for PR-time
 *     regression checks of pure prompt behavior.
 *
 *   --mode=session   (post-deploy verification)
 *     Creates a real Managed Agents session against `platform.managed_agent_id`
 *     and `platform.managed_environment_id`, sends each case as a `user.message`
 *     event, polls until idle, and reads the assistant's response from the
 *     event log. Exercises the full agent including tools, MCP, and skills.
 *
 * Each case in agents/<id>/evals/golden.jsonl:
 *   { "id": "...", "input": "...", "criteria": "...", "tags": [...] }
 *
 * The judge is always a one-shot Messages API call (claude-opus-4-7) — keeps
 * judging deterministic and avoids spinning up a second session.
 *
 * Fails the job if pass rate < MIN_PASS_RATE or regresses by more than
 * MAX_REGRESSION_PCT vs cached main baseline.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  agentsRoot,
  getPlatformEnv,
  listAgentDirs,
  loadAgent,
  makeAnthropicClient,
  modelId,
} from './lib/config.js';
import type { LoadedAgent } from './lib/config.js';
import { runAgentSession } from './lib/managed-agents-api.js';
import { loadJSONL, pmap } from './lib/utils.js';

const RESULTS_DIR = '.eval-results';
const BASELINE_DIR = '.eval-baselines';
const MIN_PASS_RATE = Number(process.env.MIN_PASS_RATE || '0.9');
const MAX_REGRESSION_PCT = Number(process.env.MAX_REGRESSION_PCT || '0.05');
const PARALLELISM = Number(process.env.PARALLELISM || '4');
const AGENT_FILTER = parseFlag('--agent') || process.env.AGENT || '';
const MODE = (parseFlag('--mode') || process.env.EVAL_MODE || 'messages') as 'messages' | 'session';

const CaseSchema = z.object({
  id: z.string(),
  input: z.string(),
  criteria: z.string(),
  tags: z.array(z.string()).optional(),
});
type Case = z.infer<typeof CaseSchema>;

const JudgeSchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
  severity: z.enum(['none', 'minor', 'major']).optional(),
});

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.split('=')[1] : undefined;
}

function loadCases(agentId: string): Case[] {
  return loadJSONL(join(agentsRoot(), agentId, 'evals', 'golden.jsonl'), CaseSchema);
}

async function runMessages(client: Anthropic, agent: LoadedAgent, c: Case): Promise<string> {
  const res = await client.messages.create({
    model: modelId(agent.config.agent.model),
    max_tokens: 1024,
    system: [{ type: 'text', text: agent.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: c.input }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function runSession(agent: LoadedAgent, c: Case): Promise<string> {
  const env = process.env.DEPLOY_ENV ?? 'staging';
  const platform = getPlatformEnv(agent.config, env);
  if (!platform.managed_agent_id || !platform.managed_environment_id) {
    throw new Error(
      `[${agent.config.id}] session-mode requires platform.${env}.managed_agent_id and managed_environment_id (run deploy first for env=${env})`,
    );
  }
  const pinnedVersion = platform.managed_agent_version ?? undefined;
  const agentRef = pinnedVersion
    ? { type: 'agent' as const, id: platform.managed_agent_id, version: pinnedVersion }
    : platform.managed_agent_id;
  return runAgentSession(agentRef, platform.managed_environment_id, c.input, {
    title: `eval:${agent.config.id}:${c.id}`,
  });
}

async function judge(
  client: Anthropic,
  c: Case,
  output: string,
): Promise<{ pass: boolean; reason: string }> {
  const res = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: `You are a strict eval judge. Decide if the agent's response satisfies the criteria.
Reply ONLY with JSON: {"pass": bool, "reason": "<short>", "severity": "none|minor|major"}.`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Case ID: ${c.id}
Input given to agent:
<input>${c.input}</input>

Pass criteria:
<criteria>${c.criteria}</criteria>

Agent output:
<output>${output}</output>

Return only the JSON verdict.`,
      },
    ],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return { pass: false, reason: `judge returned non-JSON: ${text.slice(0, 80)}` };
  const verdict = JudgeSchema.parse(JSON.parse(text.slice(start, end + 1)));
  return { pass: verdict.pass, reason: verdict.reason };
}

interface CaseResult {
  id: string;
  pass: boolean;
  reason: string;
  output: string;
}

interface AgentResult {
  agent: string;
  mode: 'messages' | 'session';
  total: number;
  passed: number;
  passRate: number;
  cases: CaseResult[];
}

async function evaluateAgent(client: Anthropic, agent: LoadedAgent): Promise<AgentResult> {
  const cases = loadCases(agent.config.id);
  if (cases.length === 0) {
    console.log(`[${agent.config.id}] no eval cases found — skipping`);
    return { agent: agent.config.id, mode: MODE, total: 0, passed: 0, passRate: 1, cases: [] };
  }
  console.log(`[${agent.config.id}] mode=${MODE} cases=${cases.length} parallelism=${PARALLELISM}`);

  const results = await pmap(cases, PARALLELISM, async (c) => {
    try {
      const output =
        MODE === 'session' ? await runSession(agent, c) : await runMessages(client, agent, c);
      const verdict = await judge(client, c, output);
      console.log(`  ${verdict.pass ? 'PASS' : 'FAIL'} ${c.id} — ${verdict.reason}`);
      return { id: c.id, pass: verdict.pass, reason: verdict.reason, output };
    } catch (err) {
      const reason = (err as Error).message;
      console.log(`  ERR  ${c.id} — ${reason}`);
      return { id: c.id, pass: false, reason: `error: ${reason}`, output: '' };
    }
  });

  const passed = results.filter((r) => r.pass).length;
  return {
    agent: agent.config.id,
    mode: MODE,
    total: results.length,
    passed,
    passRate: results.length === 0 ? 1 : passed / results.length,
    cases: results,
  };
}

function loadBaseline(agentId: string): { passRate: number } | null {
  const f = join(BASELINE_DIR, `${agentId}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8')) as { passRate: number };
}

function saveBaseline(agentId: string, passRate: number): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(join(BASELINE_DIR, `${agentId}.json`), JSON.stringify({ passRate }, null, 2));
}

function renderSummary(result: AgentResult, baseline: number | null): string {
  const delta = baseline != null ? result.passRate - baseline : null;
  const deltaStr =
    delta == null
      ? '(no baseline)'
      : delta >= 0
        ? `+${(delta * 100).toFixed(1)}pp`
        : `${(delta * 100).toFixed(1)}pp`;

  const failed = result.cases.filter((c) => !c.pass).slice(0, 10);

  const lines = [
    `### Agent: \`${result.agent}\` · mode=\`${result.mode}\``,
    '',
    `- Pass rate: **${(result.passRate * 100).toFixed(1)}%** (${result.passed}/${result.total}) ${deltaStr}`,
    `- Threshold: ${(MIN_PASS_RATE * 100).toFixed(0)}% | Max regression: ${(MAX_REGRESSION_PCT * 100).toFixed(0)}pp`,
    '',
  ];
  if (failed.length) {
    lines.push('**Failures (sample):**');
    for (const f of failed) {
      lines.push(`- \`${f.id}\` — ${f.reason}`);
    }
  } else {
    lines.push('All cases passed.');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const ids = listAgentDirs(AGENT_FILTER);
  if (ids.length === 0) {
    console.log('No agents discovered.');
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const client = makeAnthropicClient();
  let failed = false;

  for (const id of ids) {
    const agent = loadAgent(id);
    const result = await evaluateAgent(client, agent);
    const baseline = loadBaseline(id);
    const summary = renderSummary(result, baseline?.passRate ?? null);

    const outDir = join(RESULTS_DIR, `evals-${id}-${process.env.GITHUB_SHA ?? 'local'}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'summary.md'), summary);
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(result, null, 2));
    console.log(`\n${summary}\n`);

    if (process.env.GITHUB_REF === 'refs/heads/main') {
      saveBaseline(id, result.passRate);
    }

    if (result.passRate < MIN_PASS_RATE) {
      console.error(`[${id}] FAIL: pass rate ${result.passRate} < ${MIN_PASS_RATE}`);
      failed = true;
    }
    if (baseline && baseline.passRate - result.passRate > MAX_REGRESSION_PCT) {
      console.error(
        `[${id}] FAIL: regressed ${(baseline.passRate - result.passRate).toFixed(3)} > ${MAX_REGRESSION_PCT}`,
      );
      failed = true;
    }
  }

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * Token + cost regression guard.
 *
 * Runs each agent's `evals/cost-probes.jsonl` through the **Messages API** with
 * the agent's `system` prompt and `model`. Records:
 *   - input tokens
 *   - output tokens
 *   - cache write/read tokens
 *   - estimated cost (USD) using the published rates below
 *
 * NOTE: This measures the *prompt + reply* cost only. It does NOT measure the
 * full Sessions runtime cost (environment compute, tool execution, container
 * provisioning). It exists to catch the most common regression — somebody
 * doubling the system prompt size — before it ships.
 *
 * For a true session-cost signal, run cost-probes through `--mode=session`
 * after deploy; the API returns usage metadata you can wire in later.
 *
 * Pricing table is intentionally inline + auditable. Update when rates change.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  agentsRoot,
  listAgentDirs,
  loadAgent,
  makeAnthropicClient,
  modelId,
} from './lib/config.js';
import type { LoadedAgent } from './lib/config.js';
import { loadJSONL } from './lib/utils.js';

const BASELINE_DIR = '.cost-baselines';
const MAX_COST_INC = Number(process.env.MAX_COST_INCREASE_PCT || '0.20');
const MAX_INPUT_INC = Number(process.env.MAX_INPUT_TOKEN_INCREASE_PCT || '0.15');

// USD per million tokens. Update from anthropic.com/pricing.
const PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  'claude-opus-4-7': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4-6': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const ProbeSchema = z.object({
  id: z.string(),
  input: z.string(),
});
type Probe = z.infer<typeof ProbeSchema>;

interface ProbeResult {
  id: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  costUSD: number;
}

interface ProbeError {
  id: string;
  reason: string;
}

interface AgentCostReport {
  agent: string;
  model: string;
  probes: ProbeResult[];
  errors: ProbeError[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
}

function loadProbes(agent: string): Probe[] {
  return loadJSONL(join(agentsRoot(), agent, 'evals', 'cost-probes.jsonl'), ProbeSchema);
}

function pricing(model: string): {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
} {
  return PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
}

async function runProbe(client: Anthropic, agent: LoadedAgent, probe: Probe): Promise<ProbeResult> {
  const model = modelId(agent.config.agent.model);
  const res = await client.messages.create({
    model,
    max_tokens: 512,
    system: [{ type: 'text', text: agent.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: probe.input }],
  });
  const usage = res.usage;
  const p = pricing(model);
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputBilled = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const costUSD =
    (inputBilled * p.input +
      outputTokens * p.output +
      cacheCreate * p.cacheWrite +
      cacheRead * p.cacheRead) /
    1_000_000;
  return {
    id: probe.id,
    inputTokens: inputBilled + cacheCreate + cacheRead,
    outputTokens,
    cacheCreate,
    cacheRead,
    costUSD,
  };
}

interface Baseline {
  totalInputTokens: number;
  totalCostUSD: number;
}

function loadBaseline(agent: string): Baseline | null {
  const f = join(BASELINE_DIR, `${agent}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8')) as Baseline;
}

function saveBaseline(agent: string, b: Baseline): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(join(BASELINE_DIR, `${agent}.json`), JSON.stringify(b, null, 2));
}

function pct(curr: number, base: number): number {
  if (base === 0) return curr === 0 ? 0 : 1;
  return (curr - base) / base;
}

function renderSummary(reports: AgentCostReport[], failures: string[]): string {
  const lines = ['## Cost & token regression', ''];
  lines.push('| Agent | Model | Input tokens | Output tokens | Cost (USD) | Errors |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const r of reports) {
    lines.push(
      `| ${r.agent} | ${r.model} | ${r.totalInputTokens} | ${r.totalOutputTokens} | $${r.totalCostUSD.toFixed(4)} | ${r.errors.length} |`,
    );
  }
  lines.push('');
  if (failures.length) {
    lines.push('### Regressions');
    for (const f of failures) lines.push(`- ${f}`);
  } else {
    lines.push(
      `Within thresholds (max cost +${(MAX_COST_INC * 100).toFixed(0)}%, max input +${(MAX_INPUT_INC * 100).toFixed(0)}%).`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const client = makeAnthropicClient();
  const ids = listAgentDirs();
  const reports: AgentCostReport[] = [];
  const failures: string[] = [];

  for (const id of ids) {
    const agent = loadAgent(id);
    const probes = loadProbes(id);
    if (probes.length === 0) {
      console.log(`[${id}] no probes, skipping`);
      continue;
    }
    const probeResults: ProbeResult[] = [];
    const probeErrors: ProbeError[] = [];
    for (const p of probes) {
      try {
        probeResults.push(await runProbe(client, agent, p));
      } catch (err) {
        const reason = (err as Error).message;
        console.error(`  ERR  ${p.id} — ${reason}`);
        probeErrors.push({ id: p.id, reason });
      }
    }
    const totalInput = probeResults.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutput = probeResults.reduce((s, r) => s + r.outputTokens, 0);
    const totalCost = probeResults.reduce((s, r) => s + r.costUSD, 0);
    reports.push({
      agent: id,
      model: modelId(agent.config.agent.model),
      probes: probeResults,
      errors: probeErrors,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUSD: totalCost,
    });

    const base = loadBaseline(id);
    if (base) {
      const costDelta = pct(totalCost, base.totalCostUSD);
      const inputDelta = pct(totalInput, base.totalInputTokens);
      console.log(
        `[${id}] cost ${(costDelta * 100).toFixed(1)}% input ${(inputDelta * 100).toFixed(1)}%${probeErrors.length ? ` (${probeErrors.length} probe errors)` : ''}`,
      );
      if (costDelta > MAX_COST_INC) {
        failures.push(
          `${id}: cost +${(costDelta * 100).toFixed(1)}% > ${(MAX_COST_INC * 100).toFixed(0)}%`,
        );
      }
      if (inputDelta > MAX_INPUT_INC) {
        failures.push(
          `${id}: input tokens +${(inputDelta * 100).toFixed(1)}% > ${(MAX_INPUT_INC * 100).toFixed(0)}%`,
        );
      }
    } else {
      console.log(
        `[${id}] no baseline (will be saved on main)${probeErrors.length ? ` (${probeErrors.length} probe errors)` : ''}`,
      );
    }

    if (process.env.GITHUB_REF === 'refs/heads/main') {
      saveBaseline(id, { totalInputTokens: totalInput, totalCostUSD: totalCost });
    }
  }

  const summary = renderSummary(reports, failures);
  writeFileSync(join(BASELINE_DIR, 'summary.md'), summary);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

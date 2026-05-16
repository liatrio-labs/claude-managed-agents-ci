#!/usr/bin/env tsx
/**
 * AI-powered system prompt review.
 *
 * For each changed prompt-bearing file in the PR, asks Claude to grade the
 * prompt against a structured rubric (clarity, instruction quality, tool
 * discipline, safety, injection resistance, cost efficiency, testability),
 * compares to the baseline (main) version, and writes a markdown summary
 * that the PR-comment step picks up.
 *
 * Two file types are reviewed:
 *
 *   - `agent.yaml` — the script extracts the agent's actual
 *     system prompt (`agent.system` if inline, or follows `agent.system_path`)
 *     and grades just that, NOT the full YAML config. This is the common case.
 *
 *   - `system-prompt.md` (or any other .md / prompts/** file) — graded as-is.
 *
 * Path semantics:
 *
 *   - CHANGED_FILES is a space-separated list of paths relative to the
 *     repo whose agents we're reviewing (CALLER_REPO_DIR).
 *   - CALLER_REPO_DIR defaults to the cwd. Override only if running this
 *     script against a checkout outside the working directory.
 *
 * Exit code is non-zero if:
 *   - any prompt scores below MIN_QUALITY_SCORE
 *   - any prompt regresses by more than MAX_QUALITY_REGRESSION points
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { makeAnthropicClient } from './lib/config.js';

const OUT_DIR = '.prompt-review';
const MODEL = process.env.PROMPT_REVIEW_MODEL || 'claude-opus-4-7';
const MIN_SCORE = Number(process.env.MIN_QUALITY_SCORE || '75');
const MAX_REGRESSION = Number(process.env.MAX_QUALITY_REGRESSION || '5');
const BASE_REF = process.env.BASE_REF || '';
const CALLER_REPO_DIR = (() => {
  const raw = process.env.CALLER_REPO_DIR?.trim();
  if (!raw) return process.cwd();
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
})();

const RUBRIC = `
You are a senior prompt engineer reviewing a system prompt for a Claude Managed Agent.
Grade the prompt on each dimension from 0-100. Be a strict reviewer; do not inflate scores.

Dimensions:
1. clarity         — Is the role, scope, and expected behavior unambiguous?
2. instruction_quality — Are instructions specific, actionable, and free of contradictions?
3. tool_discipline — Are tools described with when-to-use guidance and selection criteria?
4. safety          — Does it handle refusals, PII, destructive actions, and policy edge cases?
5. injection_resistance — Does it tell the model to treat tool results / user content as untrusted?
6. cost_efficiency — Is it free of redundancy, dead boilerplate, and excessive hedging?
7. testability     — Can a reviewer write evals against the stated behaviors?

Also flag any concrete RISKS (e.g. "tool_use unrestricted", "no PII guardrail", "instructions
contradict each other in §3 vs §5").

Output STRICT JSON, no prose, matching this schema:
{
  "overall": <0-100, weighted average>,
  "scores": { "clarity": n, "instruction_quality": n, "tool_discipline": n,
              "safety": n, "injection_resistance": n, "cost_efficiency": n,
              "testability": n },
  "strengths": ["..."],
  "risks":     [{ "severity": "low|medium|high|critical", "issue": "...", "fix": "..." }],
  "diff_notes": "Brief comparison vs baseline if a baseline was provided, else null"
}
`.trim();

const ReviewSchema = z.object({
  overall: z.number().min(0).max(100),
  scores: z.object({
    clarity: z.number(),
    instruction_quality: z.number(),
    tool_discipline: z.number(),
    safety: z.number(),
    injection_resistance: z.number(),
    cost_efficiency: z.number(),
    testability: z.number(),
  }),
  strengths: z.array(z.string()),
  risks: z.array(
    z.object({
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      issue: z.string(),
      fix: z.string(),
    }),
  ),
  diff_notes: z.string().nullable(),
});

type Review = z.infer<typeof ReviewSchema>;

function changedFiles(): string[] {
  const raw = process.env.CHANGED_FILES ?? '';
  return raw.split(/\s+/).filter(Boolean);
}

function callerPath(file: string): string {
  return isAbsolute(file) ? file : join(CALLER_REPO_DIR, file);
}

function readCurrent(file: string): string | null {
  const p = callerPath(file);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function readAtRef(ref: string, file: string): string | null {
  if (!ref) return null;
  try {
    return execFileSync('git', ['-C', CALLER_REPO_DIR, 'show', `${ref}:${file}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return null;
  }
}

interface PromptSource {
  /** Stable label shown in the report — typically the path the user committed. */
  label: string;
  /** The text that goes to the reviewer. */
  prompt: string;
}

/**
 * Resolve a changed file into the actual prompt text the reviewer should grade.
 *
 * - For agent.yaml: extract `agent.system` inline, OR follow
 *   `agent.system_path` (resolved relative to the agent.yaml's directory).
 * - For anything else (markdown, raw .md): return the file content as-is.
 *
 * Returns null when the file should be skipped (e.g. an agent.yaml that
 * uses system_path but only the YAML, not the prompt file, changed).
 */
function resolvePromptFromContent(
  file: string,
  content: string,
  refForFollow: 'current' | string,
): PromptSource | null {
  const isAgentYaml = file.endsWith('agent.yaml');
  if (!isAgentYaml) {
    return { label: file, prompt: content };
  }
  let parsed: { agent?: { system?: string; system_path?: string } } | undefined;
  try {
    parsed = YAML.parse(content) as { agent?: { system?: string; system_path?: string } };
  } catch (err) {
    console.warn(`Could not parse YAML for ${file}: ${(err as Error).message}`);
    return null;
  }
  const ag = parsed?.agent;
  if (!ag) return null;
  if (ag.system) {
    return { label: `${file} (agent.system)`, prompt: ag.system };
  }
  if (ag.system_path) {
    const promptFile = join(dirname(file), ag.system_path);
    if (refForFollow === 'current') {
      const text = readCurrent(promptFile);
      if (text == null) {
        console.warn(`agent.system_path target missing: ${promptFile}`);
        return null;
      }
      return { label: `${promptFile} (via agent.yaml system_path)`, prompt: text };
    }
    const text = readAtRef(refForFollow, promptFile);
    if (text == null) return null;
    return { label: `${promptFile}@${refForFollow}`, prompt: text };
  }
  return null;
}

async function reviewOne(
  client: Anthropic,
  label: string,
  current: string,
  baseline: string | null,
): Promise<Review> {
  const baselineBlock = baseline
    ? `\n\n<baseline_prompt label="${label}@base">\n${baseline}\n</baseline_prompt>`
    : '';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: RUBRIC,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Review the following system prompt. Compare to baseline if provided.
Source: ${label}

<current_prompt label="${label}">
${current}
</current_prompt>${baselineBlock}

Return ONLY JSON matching the schema. No commentary.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`Reviewer returned non-JSON for ${label}: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as unknown;
  return ReviewSchema.parse(parsed);
}

function severityIcon(s: string): string {
  return { critical: 'X', high: '!', medium: '~', low: '.' }[s] ?? '?';
}

function renderSummary(
  results: Array<{ label: string; review: Review; baselineScore: number | null }>,
): string {
  const lines: string[] = ['## Claude System Prompt Review', ''];
  let failed = false;

  for (const { label, review, baselineScore } of results) {
    const delta = baselineScore != null ? review.overall - baselineScore : null;
    const deltaStr =
      delta == null ? '(new)' : delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    const badge =
      review.overall >= MIN_SCORE && (delta == null || delta >= -MAX_REGRESSION) ? 'PASS' : 'FAIL';
    if (badge === 'FAIL') failed = true;

    lines.push(`### \`${label}\` — **${badge}** · score **${review.overall}** (${deltaStr})`);
    lines.push('');
    lines.push('| Dimension | Score |');
    lines.push('|---|---:|');
    for (const [k, v] of Object.entries(review.scores)) {
      lines.push(`| ${k.replace(/_/g, ' ')} | ${v} |`);
    }
    lines.push('');

    if (review.strengths.length) {
      lines.push('**Strengths**');
      for (const s of review.strengths) lines.push(`- ${s}`);
      lines.push('');
    }

    if (review.risks.length) {
      lines.push('**Risks**');
      for (const r of review.risks) {
        lines.push(`- [${severityIcon(r.severity)} ${r.severity.toUpperCase()}] ${r.issue}`);
        lines.push(`  - **Fix:** ${r.fix}`);
      }
      lines.push('');
    }

    if (review.diff_notes) {
      lines.push('**Compared to baseline**');
      lines.push(review.diff_notes);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  lines.push(
    failed
      ? `> **Status:** Required threshold not met (min ${MIN_SCORE}, max regression ${MAX_REGRESSION}).`
      : `> **Status:** All reviewed prompts passed quality gate (min ${MIN_SCORE}).`,
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const files = changedFiles();
  if (files.length === 0) {
    console.log('No prompt files changed.');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const client = makeAnthropicClient();

  const results: Array<{ label: string; review: Review; baselineScore: number | null }> = [];
  let failed = false;

  for (const file of files) {
    const currentContent = readCurrent(file);
    if (currentContent == null) {
      console.log(`Skipping deleted/missing file: ${file}`);
      continue;
    }
    const current = resolvePromptFromContent(file, currentContent, 'current');
    if (!current) {
      console.log(`Skipping ${file} — no reviewable prompt extracted`);
      continue;
    }

    const baseContent = BASE_REF ? readAtRef(BASE_REF, file) : null;
    const baseline = baseContent ? resolvePromptFromContent(file, baseContent, BASE_REF) : null;

    let baselineScore: number | null = null;
    if (baseline) {
      const baseReview = await reviewOne(client, `${baseline.label}@base`, baseline.prompt, null);
      baselineScore = baseReview.overall;
    }

    const review = await reviewOne(client, current.label, current.prompt, baseline?.prompt ?? null);
    results.push({ label: current.label, review, baselineScore });

    const reportPath = join(OUT_DIR, `${current.label.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify({ label: current.label, review, baselineScore }, null, 2),
    );

    if (review.overall < MIN_SCORE) failed = true;
    if (baselineScore != null && baselineScore - review.overall > MAX_REGRESSION) failed = true;
  }

  if (results.length === 0) {
    console.log('No reviewable prompts found among changed files.');
    return;
  }

  const summary = renderSummary(results);
  writeFileSync(join(OUT_DIR, 'summary.md'), summary);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }

  if (failed) {
    console.error('Prompt review gate FAILED.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

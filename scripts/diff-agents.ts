#!/usr/bin/env tsx
/**
 * Agent diff reporter — explains what will change in each agent when the
 * current PR merges.
 *
 * For every agent.yaml that differs between the base ref and the working tree:
 *
 *   1. Field-level diffs:
 *        - model, name, description (scalar)
 *        - tools[] / mcp_servers[] / skills[] (added vs removed by `type` or `name`)
 *        - environment.config (packages, networking) scalar vs structured
 *        - metadata (added/removed keys)
 *   2. System-prompt diff:
 *        - resolved from inline `agent.system` OR followed `agent.system_path`,
 *          for both base and head versions
 *        - rendered as a unified diff
 *        - if ANTHROPIC_API_KEY is set, also include a 2–3 sentence Claude
 *          summary of the behavioral implications of the prompt change
 *   3. Predicted runtime impact:
 *        - per existing platform.<env> block: "v7 → v8 on next staging deploy"
 *        - whether the environment block changes will force a new environment
 *          (because `environment.name` changed)
 *
 * Output:
 *   .agent-diff/summary.md     — combined PR comment body
 *   .agent-diff/<agent>.json   — machine-readable diff per agent
 *
 * Env vars:
 *   BASE_REF                — base SHA / ref to diff against (required for any output)
 *   CALLER_REPO_DIR         — path to the repo whose agents we're diffing (default: cwd)
 *   AGENTS_ROOT             — agents/ root, relative to CALLER_REPO_DIR or absolute
 *   ANTHROPIC_API_KEY       — optional; enables LLM behavioral summary
 *   PROMPT_DIFF_MODEL       — model id for the LLM summary (default claude-sonnet-4-6)
 *   GITHUB_STEP_SUMMARY     — if set, append summary there too
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { AGENT_FILENAME, AgentConfigSchema, modelId, type AgentConfig } from './lib/config.js';

const OUT_DIR = '.agent-diff';
const BASE_REF = process.env.BASE_REF || '';
const CALLER_REPO_DIR = (() => {
  const raw = process.env.CALLER_REPO_DIR?.trim();
  if (!raw) return process.cwd();
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
})();
const AGENTS_ROOT = (() => {
  const raw = process.env.AGENTS_ROOT?.trim();
  if (!raw) return join(CALLER_REPO_DIR, 'agents');
  return isAbsolute(raw) ? raw : resolve(CALLER_REPO_DIR, raw);
})();
const SUMMARY_MODEL = process.env.PROMPT_DIFF_MODEL || 'claude-sonnet-4-6';

function callerPath(p: string): string {
  return isAbsolute(p) ? p : join(CALLER_REPO_DIR, p);
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

function repoRelative(absPath: string): string {
  if (absPath.startsWith(CALLER_REPO_DIR)) {
    return absPath.slice(CALLER_REPO_DIR.length).replace(/^\//, '');
  }
  return absPath;
}

interface AgentRef {
  id: string;
  /** Repo-relative path to agent.yaml. */
  configFile: string;
}

function discoverAgents(): AgentRef[] {
  if (!existsSync(AGENTS_ROOT)) return [];
  const out: AgentRef[] = [];
  for (const dir of readdirSync(AGENTS_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const abs = join(AGENTS_ROOT, dir.name, AGENT_FILENAME);
    if (existsSync(abs)) {
      out.push({ id: dir.name, configFile: repoRelative(abs) });
    }
  }
  return out;
}

function parseAgent(text: string | null): AgentConfig | null {
  if (text == null) return null;
  try {
    const raw = YAML.parse(text) as unknown;
    return AgentConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

/** Resolve the system prompt text from either inline `system` or system_path. */
function resolveSystem(
  cfg: AgentConfig,
  configFile: string,
  source: 'current' | string,
): { content: string; source: string } | null {
  if (cfg.agent.system) {
    return { content: cfg.agent.system, source: `${configFile} (inline)` };
  }
  if (cfg.agent.system_path) {
    const promptFile = join(dirname(configFile), cfg.agent.system_path);
    const text = source === 'current' ? readCurrent(promptFile) : readAtRef(source, promptFile);
    if (text == null) return null;
    return { content: text, source: promptFile };
  }
  return null;
}

// ── Field diffing ─────────────────────────────────────────────────────────

interface ScalarChange<T> {
  before: T | undefined;
  after: T | undefined;
}

interface ListChange {
  added: string[];
  removed: string[];
}

interface FieldDiff {
  name: ScalarChange<string>;
  description: ScalarChange<string | null>;
  model: ScalarChange<string>;
  tools: ListChange;
  mcp_servers: ListChange;
  skills: ListChange;
  metadata: {
    added: Record<string, string>;
    removed: string[];
    changed: Record<string, [string, string]>;
  };
  environmentName: ScalarChange<string>;
  packages: ListChange;
  networkingType: ScalarChange<string>;
  allowedHosts: ListChange;
}

function listLabels(items: Array<Record<string, unknown>> | undefined): string[] {
  if (!items) return [];
  return items.map((it) => {
    const t = it.type ?? it.name;
    return typeof t === 'string' ? t : JSON.stringify(it).slice(0, 60);
  });
}

function diffLists(before: string[], after: string[]): ListChange {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((x) => !beforeSet.has(x));
  const removed = before.filter((x) => !afterSet.has(x));
  return { added, removed };
}

function flattenPackages(env: AgentConfig['environment']): string[] {
  const pkgs = env.config.packages ?? {};
  const out: string[] = [];
  for (const [mgr, list] of Object.entries(pkgs)) {
    for (const item of list ?? []) out.push(`${mgr}:${item}`);
  }
  return out;
}

function diffMetadata(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): FieldDiff['metadata'] {
  const b = before ?? {};
  const a = after ?? {};
  const added: Record<string, string> = {};
  const removed: string[] = [];
  const changed: Record<string, [string, string]> = {};
  for (const k of Object.keys(a)) if (!(k in b)) added[k] = a[k]!;
  for (const k of Object.keys(b)) if (!(k in a)) removed.push(k);
  for (const k of Object.keys(a)) if (k in b && a[k] !== b[k]) changed[k] = [b[k]!, a[k]!];
  return { added, removed, changed };
}

function fieldDiff(before: AgentConfig, after: AgentConfig): FieldDiff {
  return {
    name: { before: before.agent.name, after: after.agent.name },
    description: {
      before: before.agent.description ?? null,
      after: after.agent.description ?? null,
    },
    model: { before: modelId(before.agent.model), after: modelId(after.agent.model) },
    tools: diffLists(listLabels(before.agent.tools), listLabels(after.agent.tools)),
    mcp_servers: diffLists(
      listLabels(before.agent.mcp_servers),
      listLabels(after.agent.mcp_servers),
    ),
    skills: diffLists(listLabels(before.agent.skills), listLabels(after.agent.skills)),
    metadata: diffMetadata(before.agent.metadata, after.agent.metadata),
    environmentName: { before: before.environment.name, after: after.environment.name },
    packages: diffLists(flattenPackages(before.environment), flattenPackages(after.environment)),
    networkingType: {
      before: before.environment.config.networking?.type,
      after: after.environment.config.networking?.type,
    },
    allowedHosts: diffLists(
      (before.environment.config.networking as { allowed_hosts?: string[] } | undefined)
        ?.allowed_hosts ?? [],
      (after.environment.config.networking as { allowed_hosts?: string[] } | undefined)
        ?.allowed_hosts ?? [],
    ),
  };
}

function isFieldDiffEmpty(d: FieldDiff): boolean {
  const same = (s: ScalarChange<unknown>): boolean => s.before === s.after;
  const empty = (l: ListChange): boolean => l.added.length === 0 && l.removed.length === 0;
  return (
    same(d.name) &&
    same(d.description) &&
    same(d.model) &&
    empty(d.tools) &&
    empty(d.mcp_servers) &&
    empty(d.skills) &&
    Object.keys(d.metadata.added).length === 0 &&
    d.metadata.removed.length === 0 &&
    Object.keys(d.metadata.changed).length === 0 &&
    same(d.environmentName) &&
    empty(d.packages) &&
    same(d.networkingType) &&
    empty(d.allowedHosts)
  );
}

// ── Unified prompt diff ──────────────────────────────────────────────────

function unifiedDiff(before: string, after: string, label: string): string {
  // Tiny, dependency-free LCS-based unified diff. Good enough for a PR comment.
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  // LCS table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [`--- ${label}@base`, `+++ ${label}@head`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(' ' + a[i]);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push('-' + a[i]);
      i++;
    } else {
      lines.push('+' + b[j]);
      j++;
    }
  }
  while (i < n) lines.push('-' + a[i++]);
  while (j < m) lines.push('+' + b[j++]);
  return lines.join('\n');
}

function changeStats(before: string, after: string): { added: number; removed: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const aSet = new Set(a);
  const bSet = new Set(b);
  let added = 0;
  let removed = 0;
  for (const line of b) if (!aSet.has(line)) added++;
  for (const line of a) if (!bSet.has(line)) removed++;
  return { added, removed };
}

// ── LLM behavioral summary (optional) ────────────────────────────────────

async function llmSummary(
  client: Anthropic,
  agentId: string,
  before: string,
  after: string,
  fields: FieldDiff,
): Promise<string | null> {
  const fieldChanges: string[] = [];
  if (fields.model.before !== fields.model.after) {
    fieldChanges.push(`model: ${fields.model.before} → ${fields.model.after}`);
  }
  for (const t of fields.tools.added) fieldChanges.push(`+ tool: ${t}`);
  for (const t of fields.tools.removed) fieldChanges.push(`- tool: ${t}`);
  for (const t of fields.mcp_servers.added) fieldChanges.push(`+ mcp: ${t}`);
  for (const t of fields.mcp_servers.removed) fieldChanges.push(`- mcp: ${t}`);
  if (fields.networkingType.before !== fields.networkingType.after) {
    fieldChanges.push(
      `networking: ${fields.networkingType.before} → ${fields.networkingType.after}`,
    );
  }

  const fieldBlock = fieldChanges.length ? fieldChanges.join('\n') : '(no field-level changes)';
  const promptDiff = unifiedDiff(before, after, 'system');

  try {
    const res = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 350,
      system: [
        {
          type: 'text',
          text: `You summarize changes to a Claude Managed Agent's system prompt and config for a PR review comment. Be concise (3 short bullets max), specific, and behavior-focused. Do NOT restate the diff verbatim. Do NOT add caveats. Lead with the most material change. If a change weakens or strengthens a safety rule, name that explicitly.`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Agent: ${agentId}

Field-level changes:
${fieldBlock}

System prompt diff:
\`\`\`diff
${promptDiff.slice(0, 16_000)}
\`\`\`

Write 1-3 short bullets describing what BEHAVIOR changes when this merges. Lead with the most consequential change.`,
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || null;
  } catch (err) {
    console.warn(`[${agentId}] LLM summary failed: ${(err as Error).message}`);
    return null;
  }
}

// ── Per-agent processing ─────────────────────────────────────────────────

interface AgentDiffResult {
  id: string;
  configFile: string;
  status: 'unchanged' | 'new-agent' | 'config-change' | 'prompt-change' | 'both' | 'deleted';
  fieldDiff?: FieldDiff | undefined;
  promptDiff?:
    | { label: string; diff: string; addedLines: number; removedLines: number }
    | undefined;
  llmSummary?: string | null | undefined;
  versionPrediction: Array<{
    env: string;
    current: number | null;
    predicted: 'new-agent' | 'no-op' | 'bump';
    note?: string | undefined;
  }>;
  envWillChange: boolean;
}

async function processAgent(client: Anthropic | null, ref: AgentRef): Promise<AgentDiffResult> {
  const headText = readCurrent(ref.configFile);
  const baseText = readAtRef(BASE_REF, ref.configFile);
  const head = parseAgent(headText);
  const base = parseAgent(baseText);

  if (head && !base) {
    return makeBrandNewResult(ref, head);
  }
  if (!head && base) {
    return {
      id: ref.id,
      configFile: ref.configFile,
      status: 'deleted',
      versionPrediction: [],
      envWillChange: false,
    };
  }
  if (!head || !base) {
    return {
      id: ref.id,
      configFile: ref.configFile,
      status: 'unchanged',
      versionPrediction: [],
      envWillChange: false,
    };
  }

  const fields = fieldDiff(base, head);
  const fieldsChanged = !isFieldDiffEmpty(fields);

  const baseSystem = resolveSystem(base, ref.configFile, BASE_REF);
  const headSystem = resolveSystem(head, ref.configFile, 'current');
  let promptDiff: AgentDiffResult['promptDiff'];
  if (baseSystem && headSystem && baseSystem.content !== headSystem.content) {
    const stats = changeStats(baseSystem.content, headSystem.content);
    promptDiff = {
      label: headSystem.source,
      diff: unifiedDiff(baseSystem.content, headSystem.content, headSystem.source),
      addedLines: stats.added,
      removedLines: stats.removed,
    };
  }

  const status: AgentDiffResult['status'] =
    fieldsChanged && promptDiff
      ? 'both'
      : promptDiff
        ? 'prompt-change'
        : fieldsChanged
          ? 'config-change'
          : 'unchanged';

  const envWillChange = fields.environmentName.before !== fields.environmentName.after;

  const versionPrediction: AgentDiffResult['versionPrediction'] = [];
  for (const [env, ids] of Object.entries(head.platform ?? {})) {
    const current = ids?.managed_agent_version ?? null;
    if (status === 'unchanged') {
      versionPrediction.push({ env, current, predicted: 'no-op' });
    } else if (current == null) {
      versionPrediction.push({ env, current: null, predicted: 'new-agent' });
    } else {
      versionPrediction.push({
        env,
        current,
        predicted: 'bump',
        note: envWillChange ? 'environment will be re-created (name changed)' : undefined,
      });
    }
  }
  if (versionPrediction.length === 0) {
    versionPrediction.push({ env: '(none configured)', current: null, predicted: 'new-agent' });
  }

  let llmSum: string | null = null;
  if (client && promptDiff && baseSystem && headSystem) {
    llmSum = await llmSummary(client, ref.id, baseSystem.content, headSystem.content, fields);
  }

  return {
    id: ref.id,
    configFile: ref.configFile,
    status,
    fieldDiff: fieldsChanged ? fields : undefined,
    promptDiff,
    llmSummary: llmSum,
    versionPrediction,
    envWillChange,
  };
}

function makeBrandNewResult(ref: AgentRef, head: AgentConfig): AgentDiffResult {
  return {
    id: ref.id,
    configFile: ref.configFile,
    status: 'new-agent',
    versionPrediction: Object.keys(head.platform ?? { staging: {}, production: {} }).map((env) => ({
      env,
      current: null,
      predicted: 'new-agent' as const,
    })),
    envWillChange: true,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderListChange(label: string, lc: ListChange): string {
  if (lc.added.length === 0 && lc.removed.length === 0) return '';
  const parts: string[] = [];
  for (const a of lc.added) parts.push(`\`+ ${a}\``);
  for (const r of lc.removed) parts.push(`\`- ${r}\``);
  return `- **${label}:** ${parts.join(' ')}`;
}

function renderFieldDiff(d: FieldDiff): string {
  const lines: string[] = [];
  if (d.name.before !== d.name.after) {
    lines.push(`- **name:** \`${d.name.before}\` → \`${d.name.after}\``);
  }
  if (d.description.before !== d.description.after) {
    lines.push(`- **description:** changed`);
  }
  if (d.model.before !== d.model.after) {
    lines.push(`- **model:** \`${d.model.before}\` → \`${d.model.after}\``);
  }
  const tools = renderListChange('tools', d.tools);
  if (tools) lines.push(tools);
  const mcp = renderListChange('mcp_servers', d.mcp_servers);
  if (mcp) lines.push(mcp);
  const skills = renderListChange('skills', d.skills);
  if (skills) lines.push(skills);
  if (
    Object.keys(d.metadata.added).length ||
    d.metadata.removed.length ||
    Object.keys(d.metadata.changed).length
  ) {
    const parts: string[] = [];
    for (const k of Object.keys(d.metadata.added)) parts.push(`\`+ ${k}\``);
    for (const k of d.metadata.removed) parts.push(`\`- ${k}\``);
    for (const k of Object.keys(d.metadata.changed)) parts.push(`\`~ ${k}\``);
    lines.push(`- **metadata:** ${parts.join(' ')}`);
  }
  if (d.environmentName.before !== d.environmentName.after) {
    lines.push(
      `- **environment.name:** \`${d.environmentName.before}\` → \`${d.environmentName.after}\` _(forces new environment)_`,
    );
  }
  const pkgs = renderListChange('packages', d.packages);
  if (pkgs) lines.push(pkgs);
  if (d.networkingType.before !== d.networkingType.after) {
    lines.push(
      `- **networking.type:** \`${d.networkingType.before}\` → \`${d.networkingType.after}\``,
    );
  }
  const hosts = renderListChange('allowed_hosts', d.allowedHosts);
  if (hosts) lines.push(hosts);
  return lines.join('\n');
}

function renderVersionPrediction(p: AgentDiffResult['versionPrediction']): string {
  return p
    .map((row) => {
      if (row.predicted === 'new-agent') {
        return `- **${row.env}**: will create new agent (no current version)`;
      }
      if (row.predicted === 'no-op') {
        return `- **${row.env}**: no-op (current v${row.current ?? '?'} unchanged)`;
      }
      const note = row.note ? ` — _${row.note}_` : '';
      return `- **${row.env}**: v${row.current} → v${(row.current ?? 0) + 1}${note}`;
    })
    .join('\n');
}

function renderAgent(r: AgentDiffResult): string {
  const lines: string[] = [];
  const headerStatus = {
    unchanged: 'no changes',
    'config-change': 'config changes only',
    'prompt-change': 'prompt changes only',
    both: 'config + prompt changes',
    'new-agent': 'new agent (first time)',
    deleted: 'deleted',
  }[r.status];

  lines.push(`### \`${r.id}\` — ${headerStatus}`);
  lines.push('');
  lines.push(`Source: \`${r.configFile}\``);
  lines.push('');

  if (r.llmSummary) {
    lines.push('**Summary**');
    lines.push(r.llmSummary);
    lines.push('');
  }

  if (r.fieldDiff) {
    lines.push('**Config changes**');
    const text = renderFieldDiff(r.fieldDiff);
    lines.push(text || '_(only metadata pipeline-prefix keys changed; not shown)_');
    lines.push('');
  }

  if (r.promptDiff) {
    lines.push(
      `**Prompt diff** — ${r.promptDiff.addedLines} line(s) added, ${r.promptDiff.removedLines} removed`,
    );
    lines.push('');
    lines.push('<details><summary>Show diff</summary>');
    lines.push('');
    lines.push('```diff');
    lines.push(r.promptDiff.diff);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('**On next deploy**');
  lines.push(renderVersionPrediction(r.versionPrediction));
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function renderSummary(results: AgentDiffResult[]): string {
  const changed = results.filter((r) => r.status !== 'unchanged');
  const lines: string[] = [];
  lines.push('## Agent change report');
  lines.push('');
  if (changed.length === 0) {
    lines.push('_No agent changes detected against the base ref._');
    return lines.join('\n');
  }
  lines.push(`**${changed.length} agent(s) changed in this PR.**`);
  lines.push('');
  for (const r of changed) lines.push(renderAgent(r));
  return lines.join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!BASE_REF) {
    console.log('No BASE_REF set — skipping agent diff.');
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const refs = discoverAgents();
  if (refs.length === 0) {
    console.log('No agents discovered.');
    return;
  }
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  if (!client) {
    console.log(
      'ANTHROPIC_API_KEY not set — skipping LLM behavioral summary; field/prompt diffs still produced.',
    );
  }
  const results: AgentDiffResult[] = [];
  for (const ref of refs) {
    const r = await processAgent(client, ref);
    results.push(r);
    writeFileSync(join(OUT_DIR, `${ref.id}.json`), JSON.stringify(r, null, 2));
    console.log(`[${ref.id}] ${r.status}`);
  }
  const summary = renderSummary(results);
  writeFileSync(join(OUT_DIR, 'summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }
  console.log(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Shared loader for agent definitions.
 *
 * An "agent" in this repo is the directory `${AGENTS_ROOT}/<id>/`, which holds:
 *
 *   agent.yaml        — the agent definition (this file's schema below)
 *   system-prompt.md  — optional. Used when agent.system_path is set.
 *   evals/            — golden.jsonl, injection.jsonl, cost-probes.jsonl
 *
 * The on-disk YAML mirrors the request bodies for POST /v1/agents and
 * POST /v1/environments (anthropic-beta: managed-agents-2026-04-01),
 * with two repo-local additions: `platform` (per-environment server-assigned
 * IDs the deploy script writes back) and `evals` (CI-only knobs).
 *
 * Platform IDs are scoped per deploy environment because each environment's
 * API key belongs to a different Anthropic Workspace, and resources don't
 * cross workspace boundaries. Shape:
 *
 *   platform:
 *     staging:    { managed_agent_id, managed_agent_version, managed_environment_id }
 *     production: { managed_agent_id, managed_agent_version, managed_environment_id }
 *     <other-env>: { ... }
 *
 * Reads/writes use Document-aware YAML so existing comments (e.g. the
 * yaml-language-server $schema hint) survive each round-trip.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import YAML, { type Document } from 'yaml';
import { z } from 'zod';

export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';

/**
 * Throws if neither ANTHROPIC_AUTH_TOKEN (WIF) nor ANTHROPIC_API_KEY is set.
 * Use instead of checking ANTHROPIC_API_KEY directly so WIF tokens are accepted.
 */
export function requireAnthropicCredential(): void {
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'No Anthropic credentials: set ANTHROPIC_AUTH_TOKEN (WIF) or ANTHROPIC_API_KEY.',
    );
  }
}

/**
 * Returns an Anthropic SDK client configured from the environment.
 * Prefers ANTHROPIC_AUTH_TOKEN (short-lived WIF bearer token) over
 * ANTHROPIC_API_KEY. Throws if neither is present.
 */
export function makeAnthropicClient(): Anthropic {
  requireAnthropicCredential();
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return new Anthropic({ authToken: process.env.ANTHROPIC_AUTH_TOKEN });
  }
  return new Anthropic();
}
export const AGENT_FILENAME = 'agent.yaml';

export function agentsRoot(): string {
  const raw = process.env.AGENTS_ROOT?.trim();
  if (!raw) return 'agents';
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

const ToolEntry = z.object({ type: z.string() }).passthrough();
const ModelField = z.union([
  z.string(),
  z.object({ id: z.string(), speed: z.enum(['standard', 'fast']).optional() }),
]);

const NetworkingUnrestricted = z.object({ type: z.literal('unrestricted') });
const NetworkingLimited = z.object({
  type: z.literal('limited'),
  allowed_hosts: z.array(z.string()).optional(),
  allow_mcp_servers: z.boolean().optional(),
  allow_package_managers: z.boolean().optional(),
});

export const PlatformEnvSchema = z.object({
  managed_agent_id: z.string().nullable().optional(),
  managed_agent_version: z.number().int().positive().nullable().optional(),
  managed_environment_id: z.string().nullable().optional(),
});

export type PlatformEnv = z.infer<typeof PlatformEnvSchema>;

export const AgentConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  agent: z
    .object({
      name: z.string().min(1),
      description: z.string().nullish(),
      model: ModelField,
      system: z.string().optional(),
      system_path: z.string().optional(),
      tools: z.array(ToolEntry).optional(),
      mcp_servers: z.array(z.record(z.unknown())).optional(),
      skills: z.array(z.record(z.unknown())).optional(),
      callable_agents: z.array(z.record(z.unknown())).optional(),
      metadata: z.record(z.string()).optional(),
    })
    .refine((a) => Boolean(a.system) !== Boolean(a.system_path), {
      message: 'agent must specify exactly one of `system` (inline) or `system_path` (file)',
    }),
  environment: z.object({
    name: z.string(),
    config: z.object({
      type: z.literal('cloud'),
      packages: z
        .object({
          apt: z.array(z.string()).optional(),
          cargo: z.array(z.string()).optional(),
          gem: z.array(z.string()).optional(),
          go: z.array(z.string()).optional(),
          npm: z.array(z.string()).optional(),
          pip: z.array(z.string()).optional(),
        })
        .optional(),
      networking: z.union([NetworkingUnrestricted, NetworkingLimited]).optional(),
    }),
  }),
  // platform is keyed by deploy environment name (staging, production, dev, …).
  // Each entry holds the IDs returned by Anthropic for that environment's workspace.
  platform: z.record(PlatformEnvSchema).optional(),
  evals: z
    .object({
      default_mode: z.enum(['messages', 'session']).optional(),
      session_mode_environment_required: z.boolean().optional(),
    })
    .optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface LoadedAgent {
  config: AgentConfig;
  configPath: string;
  systemPrompt: string;
  /** Path to the file the prompt came from. For inline prompts this is configPath. */
  systemPromptPath: string;
  agentDir: string;
  /** Original YAML Document — preserved so writes don't strip comments. */
  doc: Document;
}

function findConfigFile(agentDir: string): string | null {
  const p = join(agentDir, AGENT_FILENAME);
  return existsSync(p) ? p : null;
}

export function listAgentDirs(filter?: string): string[] {
  const root = agentsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => findConfigFile(join(root, id)) !== null)
    .filter((id) => !filter || filter === id);
}

export function loadAgent(id: string): LoadedAgent {
  const agentDir = join(agentsRoot(), id);
  const configPath = findConfigFile(agentDir);
  if (!configPath) {
    throw new Error(`No agent.yaml found in ${agentDir}`);
  }
  const text = readFileSync(configPath, 'utf8');
  const doc = YAML.parseDocument(text);
  const raw = doc.toJS() as unknown;
  const config = AgentConfigSchema.parse(raw);
  if (config.id !== id) {
    throw new Error(`Config id "${config.id}" does not match directory "${id}"`);
  }

  let systemPrompt: string;
  let systemPromptPath: string;
  if (config.agent.system) {
    systemPrompt = config.agent.system;
    systemPromptPath = configPath;
  } else if (config.agent.system_path) {
    systemPromptPath = join(agentDir, config.agent.system_path);
    if (!existsSync(systemPromptPath)) {
      throw new Error(`system_path missing: ${systemPromptPath}`);
    }
    systemPrompt = readFileSync(systemPromptPath, 'utf8');
  } else {
    throw new Error('agent must specify either `system` or `system_path`');
  }

  return { config, configPath, systemPrompt, systemPromptPath, agentDir, doc };
}

export function modelId(model: AgentConfig['agent']['model']): string {
  return typeof model === 'string' ? model : model.id;
}

/**
 * Read the platform IDs for a specific deploy environment (e.g. "staging",
 * "production"). Returns an empty record if the environment was never deployed.
 */
export function getPlatformEnv(cfg: AgentConfig, env: string): PlatformEnv {
  return cfg.platform?.[env] ?? {};
}

/**
 * Update one deploy environment's platform IDs in the on-disk YAML, preserving
 * comments and formatting elsewhere in the file. Only writes the keys provided.
 */
export function updatePlatformEnv(
  loaded: LoadedAgent,
  env: string,
  patch: Partial<PlatformEnv>,
): void {
  const { doc } = loaded;
  if (!doc.has('platform')) {
    doc.set('platform', new YAML.YAMLMap());
  }
  const platform = doc.get('platform') as YAML.YAMLMap | undefined;
  if (!platform || !platform.has) {
    // Defensive — shouldn't happen because we just set it above.
    return;
  }
  if (!platform.has(env)) {
    platform.set(env, new YAML.YAMLMap());
  }
  const envNode = platform.get(env) as YAML.YAMLMap;
  for (const [key, value] of Object.entries(patch)) {
    envNode.set(key, value ?? null);
  }
  writeFileSync(loaded.configPath, doc.toString());
}

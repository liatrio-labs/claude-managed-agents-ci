#!/usr/bin/env tsx
/**
 * Sync each agent in the repo with the Claude Managed Agents API.
 *
 * Platform IDs are tracked PER deploy environment because each environment's
 * API key belongs to a different Anthropic Workspace, and Managed Agents
 * resources don't cross workspace boundaries. Reads/writes
 * `agent.yaml`'s `platform.<DEPLOY_ENV>` block.
 *
 *   - If `platform.<env>.managed_agent_id` is unset, POST /v1/agents to create one.
 *     The returned id + version are written back to that env's block.
 *   - Otherwise, GET the live agent to read the current version, then POST
 *     /v1/agents/{id} with that version + the desired fields. The API
 *     auto-bumps the version, or returns the current version unchanged
 *     if there is no diff (no-op detection).
 *   - Same idempotent logic for environments — if `platform.<env>.managed_environment_id`
 *     is unset, create; otherwise we leave it (environments are not versioned).
 *   - For rollback, pass --rollback-to-version <N> (or "previous"): we read
 *     version N's snapshot and re-apply it as a new update, producing a
 *     fresh version that mirrors N.
 *
 * Beta header `managed-agents-2026-04-01` is injected by the api client.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY     — required
 *   AGENT                 — optional single-agent filter
 *   DEPLOY_ENV            — staging | production | <other> — REQUIRED. Determines
 *                           which `platform.<env>` block is read/written.
 *   ROLLBACK_TO_VERSION   — optional integer, or "previous"
 *   PIPELINE_METADATA_PREFIX — override the default `pipeline.` metadata-key prefix
 */
import { agents, environments } from './lib/managed-agents-api.js';
import {
  getPlatformEnv,
  listAgentDirs,
  loadAgent,
  modelId,
  requireAnthropicCredential,
  updatePlatformEnv,
} from './lib/config.js';
import type { AgentConfig, LoadedAgent } from './lib/config.js';
import type { AgentCreateBody, AgentUpdateBody } from './lib/managed-agents-api.js';

const _DEPLOY_ENV_RAW = process.env.DEPLOY_ENV;
if (!_DEPLOY_ENV_RAW) {
  console.error('DEPLOY_ENV is required (e.g. staging | production)');
  process.exit(1);
}
const DEPLOY_ENV: string = _DEPLOY_ENV_RAW;
const AGENT_FILTER = process.env.AGENT || '';
const ROLLBACK_RAW = process.env.ROLLBACK_TO_VERSION || '';
// "previous" → currently-deployed version - 1 (per agent).
// Numeric string → exact target version.
// Empty → no rollback.
const ROLLBACK_MODE: 'none' | 'previous' | 'exact' = ROLLBACK_RAW
  ? ROLLBACK_RAW === 'previous'
    ? 'previous'
    : 'exact'
  : 'none';
const ROLLBACK_EXACT = ROLLBACK_MODE === 'exact' ? Number(ROLLBACK_RAW) : null;

// Metadata key prefix for fields the pipeline writes. Override per-org via
// PIPELINE_METADATA_PREFIX (e.g. `acme.` → `acme.deploy_env`).
const META_PREFIX = process.env.PIPELINE_METADATA_PREFIX ?? 'pipeline.';

function buildCreateBody(cfg: AgentConfig, systemPrompt: string): AgentCreateBody {
  return {
    name: cfg.agent.name,
    model: cfg.agent.model,
    system: systemPrompt,
    description: cfg.agent.description ?? null,
    tools: cfg.agent.tools ?? [],
    mcp_servers: cfg.agent.mcp_servers ?? [],
    skills: cfg.agent.skills ?? [],
    metadata: {
      ...(cfg.agent.metadata ?? {}),
      [`${META_PREFIX}deploy_env`]: DEPLOY_ENV,
      [`${META_PREFIX}git_sha`]: process.env.GITHUB_SHA ?? 'local',
      [`${META_PREFIX}repo_id`]: cfg.id,
    },
  };
}

async function syncEnvironment(loaded: LoadedAgent): Promise<{ id: string; created: boolean }> {
  const platform = getPlatformEnv(loaded.config, DEPLOY_ENV);
  if (platform.managed_environment_id) {
    // Environments are not versioned — we don't try to reconcile config diffs.
    // Operators who change the environment config should bump the `name` field
    // (which must be unique per workspace) so a new environment is created
    // on next deploy.
    return { id: platform.managed_environment_id, created: false };
  }
  const env = await environments.create(loaded.config.environment);
  console.log(
    `[${loaded.config.id}] [${DEPLOY_ENV}] created environment ${env.id} (${loaded.config.environment.name})`,
  );
  return { id: env.id, created: true };
}

async function syncAgent(
  loaded: LoadedAgent,
  systemPrompt: string,
): Promise<{ id: string; version: number; created: boolean }> {
  const platform = getPlatformEnv(loaded.config, DEPLOY_ENV);
  const desired = buildCreateBody(loaded.config, systemPrompt);

  if (!platform.managed_agent_id) {
    const created = await agents.create(desired);
    console.log(
      `[${loaded.config.id}] [${DEPLOY_ENV}] created agent ${created.id} v${created.version} ("${created.name}")`,
    );
    return { id: created.id, version: created.version, created: true };
  }

  const live = await agents.get(platform.managed_agent_id);
  if (live.archived_at) {
    throw new Error(
      `[${loaded.config.id}] [${DEPLOY_ENV}] live agent ${live.id} is archived — un-archive or clear platform.${DEPLOY_ENV}.managed_agent_id`,
    );
  }

  const update: AgentUpdateBody = {
    version: live.version,
    name: desired.name,
    model: desired.model,
    system: desired.system,
    description: desired.description ?? null,
    tools: desired.tools ?? [],
    mcp_servers: desired.mcp_servers ?? [],
    skills: desired.skills ?? [],
    metadata: desired.metadata,
  };
  const updated = await agents.update(live.id, update);
  if (updated.version === live.version) {
    console.log(
      `[${loaded.config.id}] [${DEPLOY_ENV}] agent ${updated.id} unchanged (still v${updated.version})`,
    );
  } else {
    console.log(
      `[${loaded.config.id}] [${DEPLOY_ENV}] agent ${updated.id} v${live.version} → v${updated.version}`,
    );
  }
  return { id: updated.id, version: updated.version, created: false };
}

async function rollbackAgent(
  loaded: LoadedAgent,
  toVersion: number,
): Promise<{ id: string; version: number }> {
  const platform = getPlatformEnv(loaded.config, DEPLOY_ENV);
  if (!platform.managed_agent_id) {
    throw new Error(
      `[${loaded.config.id}] [${DEPLOY_ENV}] cannot rollback — no managed_agent_id for this env`,
    );
  }
  const id = platform.managed_agent_id;
  const target = await agents.versions.get(id, toVersion);
  const live = await agents.get(id);
  console.log(
    `[${loaded.config.id}] [${DEPLOY_ENV}] rolling back ${id}: v${live.version} → applying v${toVersion} snapshot`,
  );

  const restored = await agents.update(id, {
    version: live.version,
    name: target.name,
    model: target.model,
    system: target.system,
    description: target.description,
    tools: target.tools,
    mcp_servers: target.mcp_servers,
    skills: target.skills,
    metadata: {
      ...target.metadata,
      [`${META_PREFIX}rolled_back_from`]: String(live.version),
      [`${META_PREFIX}rolled_back_to_snapshot_of`]: String(toVersion),
      [`${META_PREFIX}git_sha`]: process.env.GITHUB_SHA ?? 'local',
    },
  });
  console.log(
    `[${loaded.config.id}] [${DEPLOY_ENV}] rollback complete: now at v${restored.version} (mirrors v${toVersion})`,
  );
  return { id: restored.id, version: restored.version };
}

async function main(): Promise<void> {
  requireAnthropicCredential();
  const ids = listAgentDirs(AGENT_FILTER);
  if (ids.length === 0) {
    console.log('No agents to deploy.');
    return;
  }

  for (const id of ids) {
    const loaded = loadAgent(id);
    const { config, systemPrompt } = loaded;
    console.log(`[${id}] [${DEPLOY_ENV}] model=${modelId(config.agent.model)}`);

    if (ROLLBACK_MODE !== 'none') {
      const platform = getPlatformEnv(config, DEPLOY_ENV);
      let target: number;
      if (ROLLBACK_MODE === 'exact') {
        target = ROLLBACK_EXACT as number;
      } else {
        const liveVersion = platform.managed_agent_version;
        if (!liveVersion || liveVersion < 2) {
          console.log(
            `[${id}] [${DEPLOY_ENV}] cannot roll back "previous" — current version is ${liveVersion ?? 'unknown'}`,
          );
          continue;
        }
        target = liveVersion - 1;
      }
      const result = await rollbackAgent(loaded, target);
      updatePlatformEnv(loaded, DEPLOY_ENV, {
        managed_agent_id: result.id,
        managed_agent_version: result.version,
      });
      continue;
    }

    const env = await syncEnvironment(loaded);
    const agent = await syncAgent(loaded, systemPrompt);

    updatePlatformEnv(loaded, DEPLOY_ENV, {
      managed_agent_id: agent.id,
      managed_agent_version: agent.version,
      managed_environment_id: env.id,
    });
    console.log(
      `[${id}] [${DEPLOY_ENV}] state written: agent=${agent.id} v${agent.version} env=${env.id}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

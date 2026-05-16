#!/usr/bin/env tsx
/**
 * Cleanup orphaned Managed Agents and Environments in a Workspace.
 *
 * Background: when a deploy crashes mid-run, the script's local YAML on the
 * runner has the new IDs for whatever agents were processed before the
 * crash, but the workflow's "Commit platform IDs back" step previously only
 * ran on full success. The next deploy then read NULL IDs from agent.yaml
 * and created fresh resources, orphaning the previous ones.
 *
 * This script lists agents in the current Workspace tagged with this
 * pipeline's metadata (`pipeline.repo_id`), compares to what's currently
 * recorded in agents/<id>/agent.yaml, and reports anything in the Workspace
 * that isn't pointed at by the YAML.
 *
 * Run LOCALLY with the Workspace's regular API key (NOT an admin key):
 *
 *   ANTHROPIC_API_KEY=sk-ant-... DEPLOY_ENV=staging pnpm agents:cleanup
 *   ANTHROPIC_API_KEY=sk-ant-... DEPLOY_ENV=staging pnpm agents:cleanup --apply
 *
 * Without `--apply` it's a dry run. With `--apply` it archives the orphans
 * (idempotent — archived agents stay queryable but won't be deployed against).
 *
 * Env:
 *   ANTHROPIC_API_KEY  — workspace-scoped key (the one you'd use for deploy)
 *   DEPLOY_ENV         — which platform.<env> block to compare against (default staging)
 *   PIPELINE_METADATA_PREFIX — must match what deploy.ts uses (default `pipeline.`)
 */
import { listAgentDirs, loadAgent, requireAnthropicCredential } from './lib/config.js';
import { agents, environments } from './lib/managed-agents-api.js';

const APPLY = process.argv.includes('--apply');
const _DEPLOY_ENV_RAW = process.env.DEPLOY_ENV;
if (!_DEPLOY_ENV_RAW) {
  console.error('DEPLOY_ENV is required (e.g. staging | production)');
  process.exit(1);
}
const DEPLOY_ENV: string = _DEPLOY_ENV_RAW;
const META_PREFIX = process.env.PIPELINE_METADATA_PREFIX || 'pipeline.';

interface Orphan {
  type: 'agent' | 'environment';
  id: string;
  name: string;
  repoId: string;
  whyOrphan: string;
}

function expectedAgentIds(): {
  byRepoId: Map<string, { agent_id: string | null; env_id: string | null; env_name: string }>;
} {
  const byRepoId = new Map<
    string,
    { agent_id: string | null; env_id: string | null; env_name: string }
  >();
  for (const id of listAgentDirs()) {
    const loaded = loadAgent(id);
    const platform = loaded.config.platform?.[DEPLOY_ENV] ?? {};
    byRepoId.set(id, {
      agent_id: platform.managed_agent_id ?? null,
      env_id: platform.managed_environment_id ?? null,
      env_name: loaded.config.environment.name,
    });
  }
  return { byRepoId };
}

async function main(): Promise<void> {
  requireAnthropicCredential();

  const { byRepoId } = expectedAgentIds();

  console.log(`Cleanup scan against DEPLOY_ENV=${DEPLOY_ENV}`);
  console.log(`Local YAML expects:`);
  for (const [repoId, ids] of byRepoId) {
    console.log(`  - ${repoId}: agent=${ids.agent_id ?? '(unset)'} env=${ids.env_id ?? '(unset)'}`);
  }
  console.log('');

  const liveAgents = (await agents.list()).data.filter((a) => a.archived_at == null);
  const liveEnvs = (await environments.list()).data.filter((e) => e.archived_at == null);

  console.log(
    `Workspace has ${liveAgents.length} active agents and ${liveEnvs.length} active environments.\n`,
  );

  const orphans: Orphan[] = [];

  for (const a of liveAgents) {
    const repoId = a.metadata?.[`${META_PREFIX}repo_id`];
    if (!repoId) continue; // not ours
    if (!byRepoId.has(repoId)) continue; // unknown agent id in this repo
    const expected = byRepoId.get(repoId)!.agent_id;
    if (a.id !== expected) {
      orphans.push({
        type: 'agent',
        id: a.id,
        name: a.name,
        repoId,
        whyOrphan: `agent.yaml expects agent=${expected ?? '(unset)'}, this one has same repo_id but a different id`,
      });
    }
  }

  // Environments don't carry our metadata, so we match by name. We assume the
  // pipeline-created envs share their `environment.name` field with the local
  // agent.yaml — orphans are envs whose name matches a known agent's
  // environment.name but whose id is not the one in platform.<env>.
  const expectedEnvByName = new Map<string, string>();
  for (const [, ids] of byRepoId) {
    expectedEnvByName.set(ids.env_name, ids.env_id ?? '');
  }
  for (const e of liveEnvs) {
    const expected = expectedEnvByName.get(e.name);
    if (expected == null) continue; // not ours
    if (e.id !== expected) {
      orphans.push({
        type: 'environment',
        id: e.id,
        name: e.name,
        repoId: '(by env name)',
        whyOrphan: `agent.yaml expects environment=${expected || '(unset)'} for name "${e.name}", this one is different`,
      });
    }
  }

  if (orphans.length === 0) {
    console.log('No orphans detected. Workspace and agent.yaml are in sync.');
    return;
  }

  console.log(`Found ${orphans.length} orphan(s):\n`);
  for (const o of orphans) {
    console.log(`  [${o.type}] ${o.id}  name="${o.name}"  ${o.repoId}`);
    console.log(`    → ${o.whyOrphan}`);
  }
  console.log('');

  if (!APPLY) {
    console.log('Dry run — pass --apply to archive these.');
    console.log(
      'Anthropic does not provide a "delete" for these resources; archive is the canonical retire.',
    );
    return;
  }

  console.log('Archiving…');
  for (const o of orphans) {
    try {
      if (o.type === 'agent') await agents.archive(o.id);
      else await environments.archive(o.id);
      console.log(`  archived ${o.type} ${o.id}`);
    } catch (err) {
      console.error(`  FAILED to archive ${o.type} ${o.id}: ${(err as Error).message}`);
    }
  }
  console.log('\nDone. Re-run without --apply to confirm.');
}

main().catch((err: Error) => {
  console.error(`cleanup failed: ${err.message}`);
  process.exit(1);
});

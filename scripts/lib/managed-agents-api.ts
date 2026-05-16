/**
 * Thin client for the Claude Managed Agents REST API.
 *
 * Beta: managed-agents-2026-04-01
 * Docs: https://platform.claude.com/docs/en/managed-agents/overview
 *
 * We use raw fetch instead of the SDK so the pipeline doesn't depend on a
 * specific SDK version that ships the beta surface. Promotes to SDK calls
 * when they become stable.
 */
import { MANAGED_AGENTS_BETA } from './config.js';

const API_BASE = process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com';

function headers(): Record<string, string> {
  const base: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': MANAGED_AGENTS_BETA,
    'content-type': 'application/json',
  };
  // Prefer the Workload-Identity-Federation Bearer token (sk-ant-oat01-…)
  // when present; fall back to a long-lived API key (sk-ant-api…) for the
  // pre-WIF path.
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (authToken) return { ...base, authorization: `Bearer ${authToken}` };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { ...base, 'x-api-key': apiKey };
  throw new Error('No Anthropic credentials: set ANTHROPIC_AUTH_TOKEN (WIF) or ANTHROPIC_API_KEY');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: headers() };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${txt}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Agents ────────────────────────────────────────────────────────────────

export interface AgentResponse {
  id: string;
  type: 'agent';
  name: string;
  description: string | null;
  model: { id: string; speed?: string };
  system: string | null;
  tools: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface AgentCreateBody {
  name: string;
  model: string | { id: string; speed?: string | undefined };
  system?: string | null | undefined;
  description?: string | null | undefined;
  tools?: Array<Record<string, unknown>> | undefined;
  mcp_servers?: Array<Record<string, unknown>> | undefined;
  skills?: Array<Record<string, unknown>> | undefined;
  callable_agents?: Array<Record<string, unknown>> | undefined;
  metadata?: Record<string, string> | undefined;
}

export interface AgentUpdateBody extends Partial<AgentCreateBody> {
  version: number;
}

export const agents = {
  create: (body: AgentCreateBody) => call<AgentResponse>('POST', '/v1/agents', body),
  get: (id: string) => call<AgentResponse>('GET', `/v1/agents/${id}`),
  list: () => call<{ data: AgentResponse[] }>('GET', '/v1/agents?limit=100'),
  update: (id: string, body: AgentUpdateBody) =>
    call<AgentResponse>('POST', `/v1/agents/${id}`, body),
  archive: (id: string) => call<AgentResponse>('POST', `/v1/agents/${id}/archive`),
  versions: {
    list: (id: string) => call<{ data: AgentResponse[] }>('GET', `/v1/agents/${id}/versions`),
    get: (id: string, version: number) =>
      call<AgentResponse>('GET', `/v1/agents/${id}/versions/${version}`),
  },
};

// ── Environments ──────────────────────────────────────────────────────────

export interface EnvironmentResponse {
  id: string;
  type: 'environment';
  name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface EnvironmentCreateBody {
  name: string;
  config: Record<string, unknown>;
}

export const environments = {
  create: (body: EnvironmentCreateBody) =>
    call<EnvironmentResponse>('POST', '/v1/environments', body),
  get: (id: string) => call<EnvironmentResponse>('GET', `/v1/environments/${id}`),
  list: () => call<{ data: EnvironmentResponse[] }>('GET', '/v1/environments'),
  archive: (id: string) => call<EnvironmentResponse>('POST', `/v1/environments/${id}/archive`),
  delete: (id: string) => call<void>('DELETE', `/v1/environments/${id}`),
};

// ── Sessions + Events ─────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'running' | 'rescheduling' | 'terminated';

export interface SessionResponse {
  id: string;
  type: 'session';
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SessionCreateBody {
  agent: string | { type: 'agent'; id: string; version: number };
  environment_id: string;
  vault_ids?: string[];
  title?: string;
}

export interface UserMessageEvent {
  type: 'user.message';
  content: Array<{ type: 'text'; text: string }>;
}

export interface InterruptEvent {
  type: 'user.interrupt';
}

export type SendableEvent = UserMessageEvent | InterruptEvent;

export interface SessionEvent {
  type: string;
  // The full event taxonomy (assistant.message, tool.use, tool.result,
  // status, etc.) is documented under
  // /docs/en/managed-agents/events-and-streaming. We surface the union
  // shape loosely here and let callers narrow.
  [k: string]: unknown;
}

export const sessions = {
  create: (body: SessionCreateBody) => call<SessionResponse>('POST', '/v1/sessions', body),
  get: (id: string) => call<SessionResponse>('GET', `/v1/sessions/${id}`),
  archive: (id: string) => call<SessionResponse>('POST', `/v1/sessions/${id}/archive`),
  delete: (id: string) => call<void>('DELETE', `/v1/sessions/${id}`),
  events: {
    send: (id: string, events: SendableEvent[]) =>
      call<void>('POST', `/v1/sessions/${id}/events`, { events }),
    list: (id: string) => call<{ data: SessionEvent[] }>('GET', `/v1/sessions/${id}/events`),
  },
};

// ── Polling helper for session-mode evals ────────────────────────────────

export async function waitUntilIdle(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SessionResponse> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sessions.get(id);
    if (s.status === 'idle' || s.status === 'terminated') return s;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`session ${id} did not become idle within ${timeoutMs}ms`);
}

export function extractAssistantText(events: SessionEvent[]): string {
  // Best-effort extractor: concatenate text blocks from any
  // assistant.message events. The full schema is broader (tool calls,
  // tool results, status, etc.) — callers that need richer behavior
  // should walk the events array directly.
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'assistant.message') continue;
    const content = ev.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * High-level helper: create a session, send a user message, wait until idle,
 * extract the assistant's text, then clean up. Throws if the session terminates
 * without producing any assistant text.
 */
export async function runAgentSession(
  agentId: string | { type: 'agent'; id: string; version: number },
  environmentId: string,
  input: string,
  opts: { title?: string; timeoutMs?: number } = {},
): Promise<string> {
  const session = await sessions.create({
    agent: agentId,
    environment_id: environmentId,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
  });
  try {
    await sessions.events.send(session.id, [
      { type: 'user.message', content: [{ type: 'text', text: input }] },
    ]);
    const final = await waitUntilIdle(session.id, { timeoutMs: opts.timeoutMs ?? 300_000 });
    if (final.status === 'terminated') {
      throw new Error('session terminated without completing');
    }
    const eventsResult = await sessions.events.list(session.id);
    const text = extractAssistantText(eventsResult.data as SessionEvent[]);
    if (!text) {
      throw new Error('session produced no assistant text');
    }
    return text;
  } finally {
    try {
      await sessions.delete(session.id);
    } catch {
      /* best-effort cleanup */
    }
  }
}

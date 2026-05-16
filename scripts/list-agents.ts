#!/usr/bin/env tsx
/**
 * Lists discoverable agents (directories under AGENTS_ROOT containing agent.yaml).
 * Used by GH Actions to build a dynamic eval matrix.
 */
import { listAgentDirs } from './lib/config.js';

const json = process.argv.includes('--json');
const ids = listAgentDirs();
console.log(json ? JSON.stringify(ids) : ids.join('\n'));

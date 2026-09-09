#!/usr/bin/env node
// Standard I/O entry point for agentdox MCP (local, auth-disabled, full access).
// `createMcpServer` (the shared factory) lives in index.ts and is also used by the
// server package to build per-connection HTTP MCP sessions.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentDox } from '@agentdox/core';
import { createMcpServer } from './index.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
// AGENTDOX_DATABASE_URL (Postgres) wins over AGENTDOX_DB (a SQLite file), like the server.
const target = process.env.AGENTDOX_DATABASE_URL || process.env.AGENTDOX_DB || resolve(here, '../../..', 'data', 'agentdox.db');
if (!AgentDox.isPostgres(target)) mkdirSync(dirname(target), { recursive: true });
const dox = await AgentDox.open(target);

const server = createMcpServer(dox, null); // stdio: local full access
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[agentdox-mcp] stdio server ready (${dox.storage})`);

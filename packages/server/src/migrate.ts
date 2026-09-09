#!/usr/bin/env node
/**
 * `agentdox-migrate --from <store> --to <store> [--replace]`
 *
 * Copies one agentdox store into another. A store is a SQLite file path or a `postgres://`
 * URL (`--to-schema` / `--from-schema` pick the Postgres schema, default `agentdox`). Ids are
 * preserved and the retrieval mirrors are copied, so the target is ready to serve when the
 * command returns. The target must be empty unless `--replace` is given.
 */
import { copyStore, openStore } from '@agentdox/core';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const from = flag('from');
const to = flag('to');
if (!from || !to) {
  console.error('usage: agentdox-migrate --from <sqlite path | postgres://…> --to <sqlite path | postgres://…> [--replace] [--from-schema s] [--to-schema s]');
  process.exit(2);
}

const source = await openStore(from, { schema: flag('from-schema') });
const target = await openStore(to, { schema: flag('to-schema') });
try {
  const report = await copyStore(source, target, { replace: process.argv.includes('--replace'), log: (l) => console.log(`[migrate] ${l}`) });
  console.log(`[migrate] copied ${report.total} rows from ${source.description} to ${target.description}`);
} catch (e) {
  console.error(`[migrate] failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await source.close();
  await target.close();
}

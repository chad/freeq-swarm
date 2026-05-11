#!/usr/bin/env node
import { main } from './main.js';
import { discover } from './discover.js';

const args = process.argv.slice(2);
const sub = args[0];

async function run(): Promise<void> {
  if (sub === 'discover' || sub === 'join') {
    const channel = arg('--channel') ?? args.find((a) => a.startsWith('#'));
    const owner = arg('--owner');
    if (!channel || !owner) {
      console.error('usage: swarm-worker discover --channel #name --owner did:plc:... [--yes] [--coord <nick>] [--server host:port]');
      process.exit(2);
    }
    await discover({
      channel,
      ownerDid: owner,
      coordinatorNick: arg('--coord'),
      server: arg('--server'),
      writeConfig: args.includes('--yes'),
    });
    return;
  }
  if (sub === 'launch' || sub === undefined) {
    await main();
    return;
  }
  console.error('usage: swarm-worker [launch|discover|join] [...]');
  process.exit(2);
}

function arg(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

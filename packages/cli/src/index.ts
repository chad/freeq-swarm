#!/usr/bin/env node

const sub = process.argv[2];

async function run(): Promise<void> {
  switch (sub) {
    case 'coordinator': {
      const { main } = await import('@freeq-swarm/coordinator');
      await main();
      break;
    }
    case 'worker': {
      const { main } = await import('@freeq-swarm/worker');
      await main();
      break;
    }
    default:
      console.error('usage: swarm <coordinator|worker> [args...]');
      process.exit(2);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

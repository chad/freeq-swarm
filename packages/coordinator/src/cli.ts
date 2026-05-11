#!/usr/bin/env node
import { main } from './main.js';

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

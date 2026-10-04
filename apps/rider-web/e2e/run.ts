import { runE2E } from './harness';

void runE2E({ app: 'rider-web', playwrightArgs: process.argv.slice(2) });

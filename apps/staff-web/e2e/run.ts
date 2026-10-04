import { runE2E } from '../../rider-web/e2e/harness';

void runE2E({
  app: 'staff-web',
  staff: [
    { email: 'e2e-admin-a@captain.et', name: 'Admin A', role: 'admin' },
    { email: 'e2e-admin-b@captain.et', name: 'Admin B', role: 'admin' },
    { email: 'e2e-admin-c@captain.et', name: 'Admin C', role: 'admin' },
    { email: 'e2e-operator@captain.et', name: 'Operator', role: 'operator' },
  ],
  playwrightArgs: process.argv.slice(2),
});

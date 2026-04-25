import { execSync } from 'child_process';
import { createOvhClient } from './ovh-client.js';
import { scaleNodepool } from './scale-nodepool.js';

interface HelmRelease {
  name: string;
  namespace: string;
}

// Uninstall in REVERSE order of start.ts (services first, infrastructure last)
const HELM_RELEASES: HelmRelease[] = [
  { name: 'teams-bot',     namespace: 'cip-app' },
  { name: 'platform-core', namespace: 'cip-app' },
  { name: 'hr-service',    namespace: 'cip-app' },
  { name: 'langfuse',      namespace: 'cip-app' },
  { name: 'litellm',       namespace: 'cip-app' },
  { name: 'keycloak',      namespace: 'cip-auth' },
  { name: 'nats',          namespace: 'cip-infra' },
  { name: 'postgres',      namespace: 'cip-infra' },
];

async function main(): Promise<void> {
  console.log('=== CIP Evening Shutdown ===');

  const client = createOvhClient();

  // Step 1: Uninstall Helm releases — pods terminated, Cinder volumes detach from node
  // IMPORTANT: Never delete PVCs — data is permanent
  for (const release of HELM_RELEASES) {
    console.log(`Uninstalling ${release.name}...`);
    try {
      execSync(
        `helm uninstall ${release.name} -n ${release.namespace} --ignore-not-found`,
        { stdio: 'inherit' },
      );
    } catch {
      console.warn(`  Warning: ${release.name} uninstall failed (may not be installed)`);
    }
  }

  // Step 2: Scale node pool to zero — node VM destroyed, volumes safely detached
  await scaleNodepool(client, 0);

  console.log('\n=== Shutdown complete ===');
  console.log('Node destroyed. PVCs (postgres-pvc, nats-pvc) and their Cinder volumes persist safely.');
}

main().catch((err) => {
  console.error('Shutdown failed:', err);
  process.exit(1);
});

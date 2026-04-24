import { scaleNodePool } from './scale-nodepool.js';
import { execSync } from 'child_process';

// Helm releases to uninstall — order matters (app before infra)
const HELM_RELEASES = [
  { name: 'hr-service',     namespace: 'cip-app' },
  { name: 'platform-core',  namespace: 'cip-app' },
  { name: 'teams-bot',      namespace: 'cip-app' },
  { name: 'monitoring',     namespace: 'cip-observe' },
  { name: 'keycloak',       namespace: 'cip-auth' },
  { name: 'nats',           namespace: 'cip-infra' },
  { name: 'postgres',       namespace: 'cip-infra' },
];

async function main() {
  console.log('=== CIP Evening Shutdown ===');

  // Step 1: Uninstall Helm releases — pods gone, volumes detach from node
  // PVCs are NOT touched — Cinder volumes remain in OVH
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

  // Step 2: Scale node pool to zero — node VM destroyed, volumes detached and safe
  await scaleNodePool(0);

  console.log('');
  console.log('=== Shutdown complete ===');
  console.log('Node destroyed. PVCs (postgres-pvc, nats-pvc) and their Cinder volumes persist.');
}

main().catch((err) => {
  console.error('Shutdown failed:', err);
  process.exit(1);
});

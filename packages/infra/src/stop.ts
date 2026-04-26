import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { createOvhClient } from './ovh-client.js';
import { scaleNodepool } from './scale-nodepool.js';

// __dirname = packages/infra/src  →  ../../.. = repo root
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface HelmRelease {
  name: string;
  namespace: string;
}

const LANGFUSE_SELF_HOSTED = process.env['LANGFUSE_SELF_HOSTED'] === 'true';

// Uninstall app-layer charts in reverse startup order.
// Infra charts (postgres, nats, keycloak, monitoring) are managed by Terraform — never uninstalled here.
// IMPORTANT: Never delete PVCs — Cinder volumes persist across node restarts.
const APP_RELEASES: HelmRelease[] = [
  // teams-bot, platform-core, hr-service restored here once images are built and pushed to registry
  ...(LANGFUSE_SELF_HOSTED ? [{ name: 'langfuse', namespace: 'cip-observe' }] : []),
  { name: 'litellm',       namespace: 'cip-app' },
];
/*
  { name: 'teams-bot',     namespace: 'cip-app' },
  { name: 'platform-core', namespace: 'cip-app' },
  { name: 'hr-service',    namespace: 'cip-app' },*/
   
async function main(): Promise<void> {
  console.log('=== CIP Evening Shutdown ===');

  const client = createOvhClient();

  // Step 1: Uninstall app Helm releases — pods terminated, volumes safely idle
  for (const release of APP_RELEASES) {
    console.log(`Uninstalling ${release.name}...`);
    try {
      execSync(
        `helm uninstall ${release.name} -n ${release.namespace} --ignore-not-found`,
        { stdio: 'inherit', cwd: REPO_ROOT },
      );
    } catch {
      console.warn(`  Warning: ${release.name} uninstall failed`);
    }
  }

  // Step 2: Scale node pool to zero — node VM destroyed, Cinder volumes safely detached
  await scaleNodepool(client, 0);

  console.log('\n=== Shutdown complete ===');
  console.log('Node destroyed. PVCs (postgres-data, nats-data) and Cinder volumes persist safely.');
}

main().catch((err) => {
  console.error('Shutdown failed:', err);
  process.exit(1);
});

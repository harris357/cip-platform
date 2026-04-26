import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { createOvhClient } from './ovh-client.js';
import { scaleNodepool } from './scale-nodepool.js';

// pnpm runs scripts from the package directory — resolve back to repo root
// so that chart paths like './infra/helm/litellm' resolve correctly.
// __dirname = packages/infra/src  →  ../../.. = repo root
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface HelmRelease {
  name: string;
  chart: string;
  namespace: string;
  values?: string;
}

// Toggle: true = deploy Langfuse in-cluster (POC/prod); false = use Langfuse Cloud (dev default)
const LANGFUSE_SELF_HOSTED = process.env['LANGFUSE_SELF_HOSTED'] === 'true';

// Infrastructure charts (postgres, nats, keycloak, monitoring) are managed by Terraform.
// start.ts only manages app-layer charts that scale with the node pool.
const APP_CHARTS: HelmRelease[] = [
  { name: 'litellm',       chart: './infra/helm/litellm',       namespace: 'cip-app',     values: './infra/helm/litellm-values.yaml' },
  ...(LANGFUSE_SELF_HOSTED ? [
    { name: 'langfuse',    chart: 'langfuse/langfuse',          namespace: 'cip-observe', values: './infra/helm/langfuse-self-hosted-values.yaml' },
  ] : []),
  // hr-service, platform-core, teams-bot restored here once images are built and pushed to registry
  /*  { name: 'hr-service',    chart: './packages/hr-service/helm',    namespace: 'cip-app' },
      { name: 'platform-core', chart: './packages/platform-core/helm', namespace: 'cip-app' },
      { name: 'teams-bot',     chart: './packages/teams-bot/helm',     namespace: 'cip-app' },*/
];

function helmInstall(release: HelmRelease): void {
  const valuesFlag = release.values != null ? `-f ${release.values}` : '';
  const cmd = `helm upgrade --install ${release.name} ${release.chart} -n ${release.namespace} --create-namespace ${valuesFlag} --wait`.trim();
  console.log(`  Installing ${release.name}...`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: REPO_ROOT });
  } catch {
    // Release may be stuck in a failed state from a previous attempt — clean up and retry once
    console.log(`  ${release.name} failed — cleaning stale release and retrying...`);
    execSync(`helm uninstall ${release.name} -n ${release.namespace} --ignore-not-found`, { stdio: 'inherit', cwd: REPO_ROOT });
    execSync(cmd, { stdio: 'inherit', cwd: REPO_ROOT });
  }
}

async function main(): Promise<void> {
  console.log('=== CIP Morning Startup ===');
  console.log(`Repo root: ${REPO_ROOT}`);

  const client = createOvhClient();

  // Step 1: Scale node pool up — Cinder volumes (postgres-data, nats-data) re-attach automatically
  await scaleNodepool(client, 1);
  console.log('Node up. Cinder volumes re-attached. Infra charts (postgres, nats, keycloak) already running via Terraform.');
  console.log(`Langfuse mode: ${LANGFUSE_SELF_HOSTED ? 'self-hosted (cip-observe)' : 'cloud (cloud.langfuse.com)'}`);

  // Step 2: Add helm repos required by the current config
  if (LANGFUSE_SELF_HOSTED) {
    console.log('\nAdding langfuse helm repo...');
    execSync('helm repo add langfuse https://langfuse.com/helm --force-update', { stdio: 'inherit', cwd: REPO_ROOT });
    execSync('helm repo update langfuse', { stdio: 'inherit', cwd: REPO_ROOT });
  }

  // Step 3: Application services
  console.log('\nDeploying application services...');
  for (const release of APP_CHARTS) {
    helmInstall(release);
  }

  console.log('\n=== Startup complete ===');
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

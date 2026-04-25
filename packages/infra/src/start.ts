import { execSync } from 'child_process';
import { createOvhClient } from './ovh-client.js';
import { scaleNodepool } from './scale-nodepool.js';

interface HelmRelease {
  name: string;
  chart: string;
  namespace: string;
  values?: string;
}

// Startup order: infrastructure first, then application services
const INFRA_CHARTS: HelmRelease[] = [
  { name: 'postgres',  chart: 'bitnami/postgresql', namespace: 'cip-infra', values: 'infra/helm/postgres-values.yaml' },
  { name: 'nats',      chart: 'nats/nats',          namespace: 'cip-infra', values: 'infra/helm/nats-values.yaml' },
  { name: 'keycloak',  chart: 'bitnami/keycloak',   namespace: 'cip-auth',  values: 'infra/helm/keycloak-values.yaml' },
];

const APP_CHARTS: HelmRelease[] = [
  { name: 'litellm',       chart: 'infra/helm/litellm',              namespace: 'cip-app', values: 'infra/helm/litellm-values.yaml' },
  { name: 'langfuse',      chart: 'infra/helm/langfuse',             namespace: 'cip-app', values: 'infra/helm/langfuse-values.yaml' },
  { name: 'hr-service',    chart: 'packages/hr-service/helm',        namespace: 'cip-app' },
  { name: 'platform-core', chart: 'packages/platform-core/helm',     namespace: 'cip-app' },
  { name: 'teams-bot',     chart: 'packages/teams-bot/helm',         namespace: 'cip-app' },
];

function helmInstall(release: HelmRelease): void {
  const valuesFlag = release.values != null ? `-f ${release.values}` : '';
  console.log(`  Installing ${release.name}...`);
  execSync(
    `helm upgrade --install ${release.name} ${release.chart} -n ${release.namespace} ${valuesFlag} --wait`.trim(),
    { stdio: 'inherit' },
  );
}

async function main(): Promise<void> {
  console.log('=== CIP Morning Startup ===');

  const client = createOvhClient();

  // Step 1: Scale node pool up — new node VM created
  await scaleNodepool(client, 1);
  console.log('Node up. K8s will re-attach Cinder volumes (postgres-pvc, nats-pvc) automatically.');

  // Step 2: Infrastructure charts — postgres and nats will find their data intact
  console.log('\nDeploying infrastructure...');
  for (const release of INFRA_CHARTS) {
    helmInstall(release);
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

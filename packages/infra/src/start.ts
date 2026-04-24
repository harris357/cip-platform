import { scaleNodePool } from './scale-nodepool.js';
import { execSync } from 'child_process';

const INFRA_CHARTS = [
  { name: 'postgres',  chart: 'bitnami/postgresql',  namespace: 'cip-infra',   values: 'infra/helm/postgres-values.yaml' },
  { name: 'nats',      chart: 'nats/nats',           namespace: 'cip-infra',   values: 'infra/helm/nats-values.yaml' },
  { name: 'keycloak',  chart: 'bitnami/keycloak',    namespace: 'cip-auth',    values: 'infra/helm/keycloak-values.yaml' },
  { name: 'monitoring',chart: 'prometheus-community/kube-prometheus-stack',
                                                       namespace: 'cip-observe', values: 'infra/helm/monitoring-values.yaml' },
];

const APP_CHARTS = [
  { name: 'hr-service',    chart: 'packages/hr-service/helm',    namespace: 'cip-app' },
  { name: 'platform-core', chart: 'packages/platform-core/helm', namespace: 'cip-app' },
  { name: 'teams-bot',     chart: 'packages/teams-bot/helm',     namespace: 'cip-app' },
];

async function main() {
  console.log('=== CIP Morning Startup ===');

  // Step 1: Scale node pool up — new node VM created
  await scaleNodePool(1);
  console.log('Node up. K8s will re-attach Cinder volumes (postgres-pvc, nats-pvc) automatically.');

  // Step 2: Infrastructure charts — postgres and nats will find their data intact
  console.log('\nDeploying infrastructure...');
  for (const release of INFRA_CHARTS) {
    console.log(`  Installing ${release.name}...`);
    execSync(
      `helm upgrade --install ${release.name} ${release.chart} -n ${release.namespace} -f ${release.values} --wait`,
      { stdio: 'inherit' },
    );
  }

  // Step 3: Application charts
  console.log('\nDeploying application services...');
  for (const release of APP_CHARTS) {
    console.log(`  Installing ${release.name}...`);
    execSync(
      `helm upgrade --install ${release.name} ${release.chart} -n ${release.namespace} --wait`,
      { stdio: 'inherit' },
    );
  }

  console.log('\n=== Startup complete ===');
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

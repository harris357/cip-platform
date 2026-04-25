import type { OvhClient } from './ovh-client.js';

const PROJECT_ID = process.env['OVH_CLOUD_PROJECT_SERVICE'] ?? '';
const CLUSTER_ID  = process.env['OVH_CLUSTER_ID'] ?? '';
const POOL_ID     = process.env['OVH_NODEPOOL_ID'] ?? '';

const POLL_INTERVAL_MS = 15_000;
const TIMEOUT_MS       = 20 * 60 * 1_000; // 20 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scaleNodepool(client: OvhClient, targetSize: number): Promise<void> {
  if (!PROJECT_ID || !CLUSTER_ID || !POOL_ID) {
    throw new Error(
      'Missing OVH env vars: OVH_CLOUD_PROJECT_SERVICE, OVH_CLUSTER_ID, OVH_NODEPOOL_ID',
    );
  }

  console.log(`Scaling node pool ${POOL_ID} to ${targetSize} node(s)...`);

  await client.requestPromised(
    'PUT',
    `/cloud/project/${PROJECT_ID}/kube/${CLUSTER_ID}/nodepool/${POOL_ID}`,
    { desiredNodes: targetSize, minNodes: 0, maxNodes: 1 },
  );

  // Poll until node pool reaches target state
  const deadline = Date.now() + TIMEOUT_MS;
  while (true) {
    const pool = await client.requestPromised(
      'GET',
      `/cloud/project/${PROJECT_ID}/kube/${CLUSTER_ID}/nodepool/${POOL_ID}`,
    ) as { status: string };

    if (pool.status === 'READY') break;

    if (Date.now() > deadline) {
      throw new Error(`Timeout: node pool ${POOL_ID} did not reach READY within 20 minutes`);
    }

    console.log(`  Node pool status: ${pool.status} — waiting...`);
    await sleep(POLL_INTERVAL_MS);
  }

  console.log(`Node pool ${POOL_ID} is READY.`);
}

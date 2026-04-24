export async function scaleNodePool(targetSize: number): Promise<void> {
  const serviceId  = process.env['OVH_CLOUD_PROJECT_SERVICE'];
  const clusterId  = process.env['OVH_CLUSTER_ID'];
  const nodepoolId = process.env['OVH_NODEPOOL_ID'];

  if (!serviceId || !clusterId || !nodepoolId) {
    throw new Error('Missing OVH env vars: OVH_CLOUD_PROJECT_SERVICE, OVH_CLUSTER_ID, OVH_NODEPOOL_ID');
  }

  console.log(`Scaling node pool ${nodepoolId} to ${targetSize} node(s)...`);
  void targetSize;

  // TODO: call OVH API PUT /cloud/project/{serviceId}/kube/{clusterId}/nodepool/{nodepoolId}
  // Poll until desiredNodes matches targetSize
  throw new Error('scaleNodePool: not implemented');
}

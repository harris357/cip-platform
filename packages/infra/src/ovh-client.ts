import ovhFactory from '@ovhcloud/node-ovh';

export type OvhClient = ReturnType<typeof ovhFactory>;

export function createOvhClient(): OvhClient {
  const appKey = process.env['OVH_APPLICATION_KEY'];
  const appSecret = process.env['OVH_APPLICATION_SECRET'];
  const consumerKey = process.env['OVH_CONSUMER_KEY'];

  if (!appKey || !appSecret || !consumerKey) {
    throw new Error(
      'Missing OVH credentials: OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY',
    );
  }

  return ovhFactory({
    endpoint: process.env['OVH_ENDPOINT'] ?? 'ovh-ca',
    appKey,
    appSecret,
    consumerKey,
  });
}

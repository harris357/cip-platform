import ovhFactory from '@ovhcloud/node-ovh';

export type OvhClient = ReturnType<typeof ovhFactory>;

export function createOvhClient(): OvhClient {
  const appKey = process.env['OVH_APP_KEY'];
  const appSecret = process.env['OVH_APP_SECRET'];
  const consumerKey = process.env['OVH_CONSUMER_KEY'];

  if (!appKey || !appSecret || !consumerKey) {
    throw new Error(
      'Missing OVH credentials: OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY',
    );
  }

  return ovhFactory({
    endpoint: process.env['OVH_ENDPOINT'] ?? 'ovh-ca',
    appKey,
    appSecret,
    consumerKey,
  });
}

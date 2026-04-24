// OVH client factory — wraps @ovhcloud/node-ovh with env-based credentials
export function createOvhClient() {
  const endpoint           = process.env['OVH_ENDPOINT'] ?? 'ovh-ca';
  const appKey             = process.env['OVH_APPLICATION_KEY'];
  const appSecret          = process.env['OVH_APPLICATION_SECRET'];
  const consumerKey        = process.env['OVH_CONSUMER_KEY'];

  if (!appKey || !appSecret || !consumerKey) {
    throw new Error('Missing OVH credentials: OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY');
  }

  // TODO: import and initialise @ovhcloud/node-ovh client
  // const ovh = require('@ovhcloud/node-ovh')({ endpoint, appKey, appSecret, consumerKey });
  // return ovh;
  void endpoint;
  throw new Error('createOvhClient: not implemented');
}

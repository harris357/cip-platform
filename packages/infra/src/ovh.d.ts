declare module '@ovhcloud/node-ovh' {
  interface OvhOptions {
    endpoint?: string;
    appKey: string;
    appSecret: string;
    consumerKey: string;
  }

  interface OvhClient {
    requestPromised(method: string, path: string, body?: unknown): Promise<unknown>;
  }

  function ovhFactory(options: OvhOptions): OvhClient;
  export default ovhFactory;
}

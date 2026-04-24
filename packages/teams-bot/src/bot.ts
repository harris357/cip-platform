import { TeamsActivityHandler, TurnContext } from 'botbuilder';
import { routeIntent } from './agents/intent-router/index.js';
import { handleCertUpload } from './handlers/cert-upload.handler.js';
import { handleComplianceQuery } from './handlers/compliance-query.handler.js';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';

export class CIPTeamsBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context: TurnContext, next) => {
      // TODO: extract TenantContext from Teams auth token (SSO)
      const tenantId = process.env['DEV_TENANT_ID'] ?? '';
      const tenantContext: TenantContext = {
        tenantId,
        userId: context.activity.from.id,
        tenantConfig: {
          tenantId,
          name: process.env['DEV_TENANT_NAME'] ?? tenantId,
          litellmVirtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
          keycloakRealm: process.env['KEYCLOAK_REALM'] ?? tenantId,
          natsPrefix: `cip.${tenantId}`,
          langfuseTags: {},
        },
      };

      const text = context.activity.text?.trim() ?? '';
      const intent = await routeIntent(text, tenantContext.tenantId);

      switch (intent.intent) {
        case 'UPLOAD_CERT':
          await handleCertUpload(context, tenantContext);
          break;
        case 'QUERY_COMPLIANCE':
          await handleComplianceQuery(context, tenantContext);
          break;
        default:
          await context.sendActivity(`I didn't understand that. Intent detected: ${intent.intent}`);
      }

      await next();
    });
  }
}

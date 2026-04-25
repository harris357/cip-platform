import { TeamsActivityHandler, TurnContext } from 'botbuilder';
import { routeIntent } from './agents/intent-router/index.js';
import { certUploadHandler } from './handlers/cert-upload.handler.js';
import { complianceQueryHandler } from './handlers/compliance-query.handler.js';
import { hitlResponseHandler } from './handlers/hitl-response.handler.js';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';

export class CIPTeamsBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context: TurnContext, next) => {
      // TODO: extract TenantContext from Teams SSO token (Keycloak)
      const tenantId = process.env['DEV_TENANT_ID'] ?? '';
      const tenantCtx: TenantContext = {
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
      const intent = await routeIntent(text, tenantCtx);

      switch (intent.intent) {
        case 'UPLOAD_CERT':
          await certUploadHandler(context, tenantCtx, intent);
          break;
        case 'QUERY_COMPLIANCE':
          await complianceQueryHandler(context, tenantCtx, intent);
          break;
        case 'RESPOND_HITL':
          await hitlResponseHandler(context, tenantCtx, intent);
          break;
        default:
          await context.sendActivity("I didn't understand that. Try uploading a certification document.");
      }

      await next();
    });
  }
}

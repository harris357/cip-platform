export { createKeycloakUserActivity } from './create-keycloak-user.activity.js';
export type { CreateKeycloakUserInput, CreateKeycloakUserOutput } from './create-keycloak-user.activity.js';

export { assignDefaultRoleActivity } from './assign-default-role.activity.js';
export type { AssignDefaultRoleInput, AssignDefaultRoleOutput } from './assign-default-role.activity.js';

export { sendWelcomeNotificationActivity } from './send-welcome-notification.activity.js';
export type { SendWelcomeNotificationInput } from './send-welcome-notification.activity.js';

export { publishEmployeeOnboardedActivity } from './publish-employee-onboarded.activity.js';
export type { PublishEmployeeOnboardedInput } from './publish-employee-onboarded.activity.js';

// ── Slice 33: identity migration + disable activities ──────────────────────

export { validateMigrationPreconditionsActivity } from './validate-migration-preconditions.activity.js';
export type { ValidateMigrationPreconditionsInput, ValidateMigrationPreconditionsOutput } from './validate-migration-preconditions.activity.js';

export { attachAadFederationActivity } from './attach-aad-federation.activity.js';
export type { AttachAadFederationInput } from './attach-aad-federation.activity.js';

export { detachAadFederationActivity } from './detach-aad-federation.activity.js';
export type { DetachAadFederationInput } from './detach-aad-federation.activity.js';

export { clearLocalCredentialsActivity } from './clear-local-credentials.activity.js';
export type { ClearLocalCredentialsInput } from './clear-local-credentials.activity.js';

export { setupOtpRequiredActionsActivity } from './setup-otp-required-actions.activity.js';
export type { SetupOtpRequiredActionsInput } from './setup-otp-required-actions.activity.js';

export { updateEmployeeIdentityActivity } from './update-employee-identity.activity.js';
export type { UpdateEmployeeIdentityInput } from './update-employee-identity.activity.js';

export { invalidateUserSessionsActivity } from './invalidate-user-sessions.activity.js';
export type { InvalidateUserSessionsInput } from './invalidate-user-sessions.activity.js';

export { disableKeycloakUserActivity } from './disable-keycloak-user.activity.js';
export type { DisableKeycloakUserInput, DisableKeycloakUserOutput } from './disable-keycloak-user.activity.js';

export { updateEmployeeStatusActivity } from './update-employee-status.activity.js';
export type { UpdateEmployeeStatusInput } from './update-employee-status.activity.js';

export { sendIdentityChangedNotificationActivity } from './send-identity-changed-notification.activity.js';
export type { SendIdentityChangedNotificationInput } from './send-identity-changed-notification.activity.js';

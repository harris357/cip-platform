type IdentityType = 'aad_federated' | 'field_employee';

export interface SendWelcomeNotificationInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
}

export async function sendWelcomeNotificationActivity(
  input: SendWelcomeNotificationInput,
): Promise<void> {
  void input;
  throw new Error('not implemented');
}

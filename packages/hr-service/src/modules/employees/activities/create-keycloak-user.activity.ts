type IdentityType = 'aad_federated' | 'field_employee';

export interface CreateKeycloakUserInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
  email:        string;
  fullName:     string;
  aadOid?:      string;
}

export interface CreateKeycloakUserOutput {
  keycloakId: string;
}

export async function createKeycloakUserActivity(
  input: CreateKeycloakUserInput,
): Promise<CreateKeycloakUserOutput> {
  if (input.identityType === 'aad_federated') {
    // Create Keycloak user linked to AAD IDP
    // User authenticates via AAD — no password set in Keycloak
    throw new Error('not implemented');
  } else {
    // Create Keycloak user with OTP-only login
    // No password, no AAD link — field employee uses SMS OTP flow
    throw new Error('not implemented');
  }
}

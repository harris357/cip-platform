// Mirrors the workers table — all column names are camelCase.
export interface Worker {
  id:          string;
  tenantId:    string;
  email:       string;
  fullName:    string;
  keycloakId:  string;
  createdAt:   string;
  updatedAt:   string;
}

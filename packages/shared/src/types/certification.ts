export type CertStatus =
  | 'pending'
  | 'processing'
  | 'validated'
  | 'expired'
  | 'rejected'
  | 'hitl_review';

// Mirrors the certifications table — all column names are camelCase.
export interface Certification {
  id:              string;
  tenantId:        string;
  workerId:        string;
  certType:        string;
  status:          CertStatus;
  expiryDate:      string | null;
  extractedFields: Record<string, unknown> | null;
  confidence:      number | null;
  objectStoreKey:  string;
  promptVersion:   string | null;
  modelUsed:       string | null;
  createdAt:       string;
  updatedAt:       string;
}

export type CertStatus = 'pending' | 'processing' | 'validated' | 'expired' | 'rejected' | 'hitl_review';

export interface Certification {
  id: string;
  tenantId: string;           // RLS key — on every row
  workerId: string;
  certType: string;
  status: CertStatus;
  expiresAt: Date | null;
  extractedFields: Record<string, string | null>;
  confidence: number | null;
  objectStoreKey: string;     // OVH S3 key for the source document
  createdAt: Date;
  updatedAt: Date;
}

export interface CertType {
  id: string;
  name: string;
  requiredFields: string[];
  validityPeriodDays: number;
  jurisdictions: string[];
}

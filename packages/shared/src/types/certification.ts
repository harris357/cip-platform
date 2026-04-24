export type CertStatus = 'pending' | 'processing' | 'valid' | 'rejected' | 'expired';

export interface Certification {
  id: string;
  tenantId: string;       // REQUIRED — RLS key
  workerId: string;
  certType: string;
  issuingBody: string;
  issueDate: string;      // ISO 8601
  expiryDate: string;     // ISO 8601
  documentUrl: string;
  status: CertStatus;
  confidenceScore: number;
  createdAt: string;      // ISO 8601
  updatedAt: string;      // ISO 8601
}

export interface PersistedExtractionResult {
  tenantId: string;       // REQUIRED
  certId: string;
  extracted: Partial<Omit<Certification, 'id' | 'tenantId' | 'workerId' | 'status' | 'createdAt' | 'updatedAt'>>;
  confidence: number;     // 0–1
  rawText: string;
  warnings: string[];
}

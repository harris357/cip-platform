export interface StaffCertEntry {
  id: string
  displayName: string
  certStatus: string
  issueDate: string | null
  expiresAt: string | null
  issuedByText: string | null
}

export interface StaffCertReport {
  employeeId: string
  certs: StaffCertEntry[]
}

export function buildStaffCertsCard(report: StaffCertReport): object {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: `Certifications for employee ${report.employeeId}`, weight: 'Bolder', size: 'Medium' },
      ...report.certs.map((c) => ({
        type: 'ColumnSet',
        columns: [
          { type: 'Column', items: [{ type: 'TextBlock', text: c.displayName }] },
          { type: 'Column', items: [{ type: 'TextBlock', text: c.certStatus }] },
          { type: 'Column', items: [{ type: 'TextBlock', text: c.expiresAt ?? 'No expiry' }] },
        ],
      })),
    ],
  }
}

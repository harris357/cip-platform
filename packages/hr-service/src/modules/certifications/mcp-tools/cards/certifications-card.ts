import type { certifications } from '../../../../db/schema.js'

type CertRow = typeof certifications.$inferSelect

export function buildCertificationsCard(certs: CertRow[]): object {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Your Certifications', weight: 'Bolder', size: 'Medium' },
      ...certs.map((c) => ({
        type: 'ColumnSet',
        columns: [
          { type: 'Column', items: [{ type: 'TextBlock', text: c.certDefId }] },
          {
            type: 'Column',
            items: [
              {
                type: 'TextBlock',
                text: c.expiresAt ? c.expiresAt.toISOString() : 'No expiry',
              },
            ],
          },
          { type: 'Column', items: [{ type: 'TextBlock', text: c.certStatus }] },
        ],
      })),
    ],
  }
}

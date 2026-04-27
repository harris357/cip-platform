export interface ExpiringCertGroup {
  employee: { id: string; fullName: string; email: string }
  certs: Array<{ displayName: string; expiresAt: string; daysRemaining: number }>
}

export function buildExpiryCard(groups: ExpiringCertGroup[]): object {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Expiring Certifications', weight: 'Bolder', size: 'Medium' },
      ...groups.map((g) => ({
        type: 'Container',
        items: [
          { type: 'TextBlock', text: g.employee.fullName, weight: 'Bolder' },
          ...g.certs.map((c) => ({
            type: 'ColumnSet',
            columns: [
              { type: 'Column', items: [{ type: 'TextBlock', text: c.displayName }] },
              { type: 'Column', items: [{ type: 'TextBlock', text: `${c.daysRemaining}d remaining` }] },
              { type: 'Column', items: [{ type: 'TextBlock', text: c.expiresAt }] },
            ],
          })),
        ],
      })),
    ],
  }
}

export interface ComplianceSummary {
  totalEmployees: number
  fullCompliance: number
  partialCompliance: number
  nonCompliant: number
  expiringWithin90Days: number
}

export function buildComplianceSummaryCard(summary: ComplianceSummary): object {
  const compliancePct =
    summary.totalEmployees > 0
      ? Math.round((summary.fullCompliance / summary.totalEmployees) * 100)
      : 0
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Compliance Summary', weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: `${compliancePct}% full compliance` },
      {
        type: 'FactSet',
        facts: [
          { title: 'Total Employees', value: String(summary.totalEmployees) },
          { title: 'Full Compliance', value: String(summary.fullCompliance) },
          { title: 'Partial Compliance', value: String(summary.partialCompliance) },
          { title: 'Non-Compliant', value: String(summary.nonCompliant) },
          { title: 'Expiring Within 90 Days', value: String(summary.expiringWithin90Days) },
        ],
      },
    ],
  }
}

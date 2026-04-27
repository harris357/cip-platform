import type { employees } from '../../../../db/schema.js'

type EmployeeRow = typeof employees.$inferSelect

export function buildStaffCard(staff: EmployeeRow[]): object {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Staff', weight: 'Bolder', size: 'Medium' },
      ...staff.map((e) => ({
        type: 'ColumnSet',
        columns: [
          { type: 'Column', items: [{ type: 'TextBlock', text: e.fullName }] },
          { type: 'Column', items: [{ type: 'TextBlock', text: e.email }] },
          { type: 'Column', items: [{ type: 'TextBlock', text: e.employmentType }] },
        ],
      })),
    ],
  }
}

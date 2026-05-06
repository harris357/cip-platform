// Slice 65: receives the joined { employee, user } shape now. The card pulls
// fullName/email from user; employmentType from employee.

export interface StaffCardRow {
  fullName:       string
  email:          string
  employmentType: string
}

export function buildStaffCard(staff: StaffCardRow[]): object {
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

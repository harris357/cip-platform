import type { certSubmissions } from '../../../../db/schema.js'

type SubmissionRow = typeof certSubmissions.$inferSelect

export function buildSubmissionStatusCard(submission: SubmissionRow): object {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Submission Status', weight: 'Bolder', size: 'Medium' },
      {
        type: 'FactSet',
        facts: [
          { title: 'Submission ID', value: submission.id },
          { title: 'Status', value: submission.submissionStatus },
          {
            title: 'Submitted',
            value: submission.createdAt ? submission.createdAt.toISOString() : 'Unknown',
          },
          {
            title: 'Confidence',
            value: submission.confidence != null ? String(submission.confidence) : 'N/A',
          },
        ],
      },
    ],
  }
}

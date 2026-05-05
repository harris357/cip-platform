// Slice 58D-A — Teams adaptive pickcard for the person matcher.
//
// Builds an adaptive card via @cip/shared's buildFactSetCard and ships
// it via @cip/shared's notifyTeamsCard to either:
//   - audience='uploader' → channelType='uploader-1to1'
//   - audience='admin'    → channelType='hr-admin'
//
// Card payload includes resolutionId + employeeId on each candidate
// button, plus a verb that the bot's invoke-router maps to the
// hr-person-pick handler (SLICE 58D-A registration).
//
// 404 channel-not-registered is non-fatal in notifyTeamsCard — for
// uploader-1to1 in particular, the channel is registered the next time
// the user interacts with the bot. The matcher treats the card-send
// as best-effort; the workflow's `condition()` wait is still bounded
// by the TTL.

import { z } from 'zod';

import {
  buildFactSetCard,
  notifyTeamsCard,
  PersonScoredCandidateSchema,
} from '@cip/shared';

export const NotifyPersonPickcardInputSchema = z.object({
  tenantId:       z.string().uuid(),
  resolutionId:   z.string().uuid(),
  audience:       z.enum(['uploader', 'admin']),
  candidates:     z.array(PersonScoredCandidateSchema).min(1),
  conversationId: z.string().optional(),
  /** Free-text title override; defaults to a sensible template. */
  heading:        z.string().optional(),
});
export type NotifyPersonPickcardInput = z.infer<typeof NotifyPersonPickcardInputSchema>;

export async function notifyPersonPickcardActivity(
  input: NotifyPersonPickcardInput,
): Promise<void> {
  const validated = NotifyPersonPickcardInputSchema.parse(input);

  const heading = validated.heading
    ?? (validated.audience === 'uploader'
      ? 'Who is this document for?'
      : 'Resolve ambiguous person match');

  const facts = validated.candidates.map((c, i) => ({
    title: `#${i + 1}`,
    value: `${c.fullName}  (score ${c.score.toFixed(2)})`,
  }));

  const actions = validated.candidates.map(c => ({
    title: c.fullName,
    data: {
      // verb routes the click through the bot's invoke-router to the
      // hr-person-pick handler.
      verb:         'hr.person.pick',
      resolutionId: validated.resolutionId,
      employeeId:   c.employeeId,
    },
  }));

  const card = buildFactSetCard({
    heading,
    facts,
    actions,
  });

  // notifyTeamsCard treats 404 as non-fatal (uploader 1:1 channel may
  // not be registered yet — message is queued via the bot's own
  // proactive-channel re-resolution).
  await notifyTeamsCard({
    tenantId:    validated.tenantId,
    channelType: validated.audience === 'uploader' ? 'uploader-1to1' : 'hr-admin',
    card,
  });
}

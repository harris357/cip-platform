// Slice infra (pre-58D): generic Teams adaptive-card notifier. POSTs a
// fully-built adaptive card to the teams-bot's /proactive endpoint for a
// given tenant + channel type. Service-specific copy (HITL reason text,
// titles, action data) lives in caller adapters; this module knows nothing
// about certs, documents, or other domain entities.
//
// Originally lived as the inline body of
// hr-service/src/modules/certifications/activities/notify-hitl.activity.ts
// — extracted here so slice 58D (subject HITL), 58F (reclassification),
// and 58H (classifier admin review) can reuse the same delivery path.

export interface NotifyTeamsCardInput {
  tenantId:    string;
  /** Logical channel category — e.g. 'hitl', 'admin-review', 'reclassify'. */
  channelType: string;
  /** A fully-constructed adaptive-card object. The notifier does not validate. */
  card:        object;
}

/**
 * POST `{TEAMS_BOT_URL}/proactive` with the given adaptive card.
 *
 * Returns void on success. A 404 is treated as non-fatal — it means no
 * channel of this type is registered for the tenant yet; the message will
 * be delivered the next time the user interacts with the bot.
 *
 * Throws on any other non-2xx response.
 */
export async function notifyTeamsCard(input: NotifyTeamsCardInput): Promise<void> {
  const botUrl = process.env['TEAMS_BOT_URL'] ?? 'http://teams-bot:3978';
  const url = `${botUrl}/proactive`;

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId:    input.tenantId,
      channelType: input.channelType,
      card:        input.card,
    }),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`notifyTeamsCard: POST ${url} returned ${response.status}`);
  }
  // 404 means no channel registered yet — not a fatal error; the card will
  // be delivered once the channel is registered on the next user interaction.
}

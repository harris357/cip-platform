// In-memory pending-message cache: userId → message captured before SSO.
// When a user sends a message and the bot has no cached KC token, the bot
// initiates Teams SSO (sends an OAuthCard). The original message would
// otherwise be lost; we stash it here and replay it after auth completes,
// so the user's first interaction never gets dropped.
//
// Single-shot: takePendingMessage removes the entry on read.
// TTL is short (60s) — auth normally completes in <5s; if it doesn't,
// the user retried and we don't want to replay a stale question.

import type { Attachment } from '@microsoft/agents-activity';

interface PendingMessage {
  text: string;
  fileAttachments: Attachment[];
  expiresAt: number;
}

const TTL_MS = 60 * 1000;
const store = new Map<string, PendingMessage>();

export function storePendingMessage(
  userId: string,
  msg: { text: string; fileAttachments: Attachment[] },
): void {
  store.set(userId, { ...msg, expiresAt: Date.now() + TTL_MS });
}

export function takePendingMessage(
  userId: string,
): { text: string; fileAttachments: Attachment[] } | null {
  const entry = store.get(userId);
  if (!entry) return null;
  store.delete(userId);
  if (Date.now() > entry.expiresAt) return null;
  return { text: entry.text, fileAttachments: entry.fileAttachments };
}

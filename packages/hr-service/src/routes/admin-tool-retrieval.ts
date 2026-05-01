// Slice 44: tool-retrieval endpoint. The teams-bot's discoverTools calls
// this to narrow the LLM-visible tool set BEFORE function calling. Bot
// passes the user's message text + a K; hr-service embeds the message
// via mistral-embed (cip-embed alias) and runs a pgvector cosine query
// against tool_embeddings; returns the top-K tool names ordered by
// similarity.
//
// The bot intersects the result with its permission-filtered list. If
// retrieval fails or returns nothing, the bot falls back to the full
// permission-filtered catalog (graceful degradation, never blocks turn).
//
// Same shared-token auth as the other /admin/* endpoints — mounted
// before the tenant JWT middleware so cross-tenant calls work.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { z } from 'zod';
import { callEmbed, createLiteLLMClient } from '@cip/shared';
import { getPool } from '../db/index.js';
import { getRoutingRule } from '../db/queries/routing-rules.js';

export const adminToolRetrievalRouter: IRouter = Router();

adminToolRetrievalRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

const RequestSchema = z.object({
  text:     z.string().min(1).max(2000),
  k:        z.number().int().min(1).max(50).optional(),
  tenantId: z.string().uuid(),  // caller's tenant — used only for observability tagging.
});

adminToolRetrievalRouter.post(
  '/admin/tool-retrieval',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    const { text, k = 15, tenantId } = parsed.data;

    const pool = getPool();
    const client = await pool.connect();
    try {
      // Resolve `bot.embed` alias (defaults to cip-embed → mistral/mistral-embed
      // via migration 016 + LiteLLM model_list). Hardcoded fallback uses the
      // gateway alias, not the raw provider name — passing the raw name 400s.
      const alias = (await getRoutingRule(client, 'bot', 'embed')) ?? 'cip-embed';

      // tenantId here is purely for Langfuse observability — tools and
      // their embeddings are global (not tenant-scoped), but tagging the
      // caller's tenant lets us filter retrieval traces in Langfuse by
      // who triggered them. The virtual key is platform-wide.
      const llmClient = createLiteLLMClient({
        tenantId,
        virtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
      });
      const [vec] = await callEmbed(llmClient, {
        model:    alias,
        input:    text,
        purpose:  'hr-service.tool_retrieval',
        tenantId,
      });
      if (!vec || vec.length === 0) {
        res.json({ tools: [] });
        return;
      }
      const vecLiteral = `[${vec.join(',')}]`;

      // pgvector cosine distance: lower = more similar. ORDER BY ASC.
      const result = await client.query<{ tool_name: string }>(
        `SELECT tool_name
           FROM tool_embeddings
          WHERE service = 'hr-service'
          ORDER BY embedding <=> $1::vector
          LIMIT $2`,
        [vecLiteral, k],
      );
      res.json({ tools: result.rows.map(r => r.tool_name) });
    } catch (err) {
      console.error('[admin-tool-retrieval] failed:', err);
      // 200 with empty result so the bot fails open (full catalog) rather
      // than dropping the turn on a 500.
      res.json({ tools: [] });
    } finally {
      client.release();
    }
  },
);

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPermissionCatalogList } from './permission-catalog.list.tool.js';
import { registerRoleList }              from './role.list.tool.js';
import { registerRoleGet }               from './role.get.tool.js';
import { registerRoleMembers }           from './role.members.tool.js';
import { registerGroupList }             from './group.list.tool.js';
import { registerGroupGet }              from './group.get.tool.js';
import { registerPermissionHolders }     from './permission.holders.tool.js';
import { registerAuditLogList }          from './audit-log.list.tool.js';
import {
  registerBotMetricsGetTurn,
  registerBotMetricsSummary,
  registerBotMetricsTopN,
  registerBotMetricsTools,
  registerBotMetricsOutliers,
} from './bot-metrics.tools.js';

// Slice 42A + 42C + 46e: admin / audit MCP tools — read-only
// discoverability and compliance surface for HR + operators. 46e adds
// the five bot_metrics_* tools that wrap the most common queries
// against bot_turn_metrics.
//
// Slice 61: removed bot_intent_training_data_*, bot_intent_model_runs_*,
// bot_intent_classifier_*, bot_turn_feedback_record, bot_classifier_*
// tools. The intent-classifier subsystem is gone; verdicts now write
// to Langfuse scores directly from the bot's /turn-feedback handler.
export function registerAdminTools(server: McpServer): void {
  registerPermissionCatalogList(server);
  registerRoleList(server);
  registerRoleGet(server);
  registerRoleMembers(server);
  registerGroupList(server);
  registerGroupGet(server);
  registerPermissionHolders(server);
  registerAuditLogList(server);
  // Slice 46e
  registerBotMetricsGetTurn(server);
  registerBotMetricsSummary(server);
  registerBotMetricsTopN(server);
  registerBotMetricsTools(server);
  registerBotMetricsOutliers(server);
}

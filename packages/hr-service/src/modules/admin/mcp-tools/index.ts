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
import {
  registerBotIntentExampleAdd,
  registerBotIntentExamplesListUnreviewed,
} from './bot-intent-examples.tools.js';

// Slice 42A + 42C + 46e: admin / audit MCP tools — read-only
// discoverability and compliance surface for HR + operators. 46e adds
// the five bot_metrics_* tools that wrap the most common queries
// against bot_turn_metrics.
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
  // Slice 55
  registerBotIntentExampleAdd(server);
  registerBotIntentExamplesListUnreviewed(server);
}

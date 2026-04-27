export interface McpModuleResponse<T = unknown> {
  data: T;
  card?: object;
  message?: string;
}

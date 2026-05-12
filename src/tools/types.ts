/**
 * Shared types for MCP tool definitions and handlers.
 */

/**
 * Safety annotations on a tool definition. Required for the Claude
 * Connectors directory; surfaced to agents so they can reason about
 * whether to call a tool autonomously vs. ask the user.
 *
 *   readOnlyHint    — tool does not mutate any state
 *   destructiveHint — tool can perform irreversible operations
 *   openWorldHint   — tool reaches outside the agent's local context
 *                     (e.g. cross-tenant content, internet, etc.)
 *   idempotentHint  — repeating the call with the same arguments returns
 *                     the same shape of response (modulo corpus updates).
 *                     MCP 2025-06-18 schema; lets agents safely retry
 *                     read paths without worrying about double-effects.
 *   title           — short human-readable display name for directory UIs
 *                     and agent reasoning ("Search company knowledge",
 *                     "List indexed domains", "Get source detail").
 *                     Optional but improves Claude Connectors directory
 *                     UX.
 *
 * Quelvio Phase 1 (v0.8.8): every tool is read-only against the tenant's
 * own connected sources. `query_knowledge` is openWorldHint=true because
 * it crosses into the tenant's external content (Drive, Slack, etc.);
 * `list_domains` and `get_source_detail` are openWorldHint=false because
 * they only return metadata about content already resident in the
 * tenant's index.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
  title?: string;
}

/** Type of a single property in a JSON schema. */
type PropertyType = "string" | "number" | "boolean" | "array" | "object";

/** Single property in the tool input schema. */
export interface InputSchemaProperty {
  type: PropertyType;
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

/** JSON Schema for tool input parameters. Flat shape — no nested objects. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, InputSchemaProperty>;
  required: string[];
}

/** MCP tool definition (returned by tools/list). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations: ToolAnnotations;
}

/** Content block in a tool result. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Result of a tool invocation (returned by tools/call). */
export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

/** Async function that executes a tool given its arguments. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

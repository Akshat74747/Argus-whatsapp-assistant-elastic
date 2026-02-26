// ============ Elastic Agent Builder MCP Client ============
// JSON-RPC 2.0 client for the Elastic Agent Builder MCP endpoint.
// When ELASTIC_MCP_URL is set, /api/chat uses an agentic tool-call loop
// instead of embedding all events in a single prompt.
//
// Exports:
//   initMcpClient    — store config + connectivity test (non-fatal on failure)
//   fetchMcpTools    — tools/list with 5-min cache, returns OpenAI function format
//   callMcpTool      — tools/call, returns result as string
//   isMcpConfigured  — true when URL + key are set
//   getMcpStatus     — for GET /api/mcp-status

import { fetchWithTimeout } from './errors.js';

// ============ Types ============

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface OpenAiFunction {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface McpStatus {
  configured: boolean;
  url: string | null;
  toolCount: number;
  toolCacheAgeMs: number | null;
  toolCacheFresh: boolean;
  lastError: string | null;
  lastSuccessAt: number | null;
}

// ============ Module state ============

let mcpUrl: string | null = null;
let mcpApiKey: string | null = null;
let toolCache: McpTool[] | null = null;
let toolCacheAt: number | null = null;
let lastError: string | null = null;
let lastSuccessAt: number | null = null;

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MCP_TIMEOUT_MS    = 10_000;          // 10s per MCP call
let   jsonRpcId         = 1;

// ============ Init ============

export async function initMcpClient(url: string, apiKey: string): Promise<void> {
  mcpUrl    = url;
  mcpApiKey = apiKey;

  console.log('[MCP] Initializing client:', url);

  try {
    const tools = await fetchMcpTools();
    console.log(`[MCP] Connected — ${tools.length} tool(s) available`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[MCP] Connectivity test failed (will retry on next request): ${lastError}`);
    // Do NOT throw — MCP is optional
  }
}

// ============ fetchMcpTools ============

export async function fetchMcpTools(): Promise<OpenAiFunction[]> {
  if (!mcpUrl || !mcpApiKey) {
    throw new Error('[MCP] Not configured');
  }

  // Return cached tools if still fresh
  if (toolCache !== null && toolCacheAt !== null &&
      Date.now() - toolCacheAt < TOOL_CACHE_TTL_MS) {
    return toolCache.map(mcpToolToOpenAi);
  }

  const requestId = jsonRpcId++;

  const response = await fetchWithTimeout(
    mcpUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `ApiKey ${mcpApiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      requestId,
        method:  'tools/list',
        params:  {},
      }),
    },
    MCP_TIMEOUT_MS
  );

  if (!response.ok) {
    const errText = await response.text();
    const msg = `[MCP] tools/list failed: HTTP ${response.status} — ${errText.slice(0, 200)}`;
    lastError = msg;
    throw new Error(msg);
  }

  const data = await response.json() as {
    jsonrpc: string;
    id: number;
    result?: { tools: McpTool[] };
    error?: { code: number; message: string };
  };

  if (data.error) {
    const msg = `[MCP] tools/list JSON-RPC error ${data.error.code}: ${data.error.message}`;
    lastError = msg;
    throw new Error(msg);
  }

  toolCache   = data.result?.tools ?? [];
  toolCacheAt = Date.now();
  lastSuccessAt = Date.now();
  lastError   = null;

  return toolCache.map(mcpToolToOpenAi);
}

function mcpToolToOpenAi(tool: McpTool): OpenAiFunction {
  return {
    type: 'function',
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  tool.inputSchema,
    },
  };
}

// ============ callMcpTool ============

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!mcpUrl || !mcpApiKey) {
    throw new Error('[MCP] Not configured');
  }

  const requestId = jsonRpcId++;

  const response = await fetchWithTimeout(
    mcpUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `ApiKey ${mcpApiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      requestId,
        method:  'tools/call',
        params:  {
          name:      toolName,
          arguments: args,
        },
      }),
    },
    MCP_TIMEOUT_MS
  );

  if (!response.ok) {
    const errText = await response.text();
    const msg = `[MCP] tools/call "${toolName}" failed: HTTP ${response.status} — ${errText.slice(0, 200)}`;
    lastError = msg;
    throw new Error(msg);
  }

  const data = await response.json() as {
    jsonrpc: string;
    id: number;
    result?: {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };

  if (data.error) {
    const msg = `[MCP] tools/call "${toolName}" JSON-RPC error ${data.error.code}: ${data.error.message}`;
    lastError = msg;
    throw new Error(msg);
  }

  if (data.result?.isError) {
    const errText = (data.result.content ?? []).map(c => c.text).join('\n');
    throw new Error(`[MCP] Tool "${toolName}" returned an error: ${errText.slice(0, 200)}`);
  }

  const resultText = (data.result?.content ?? [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  lastSuccessAt = Date.now();
  lastError     = null;
  return resultText;
}

// ============ Status helpers ============

export function isMcpConfigured(): boolean {
  return mcpUrl !== null && mcpApiKey !== null;
}

export function getMcpStatus(): McpStatus {
  const cacheAgeMs = toolCacheAt !== null ? Date.now() - toolCacheAt : null;
  return {
    configured:    isMcpConfigured(),
    url:           mcpUrl,
    toolCount:     toolCache?.length ?? 0,
    toolCacheAgeMs: cacheAgeMs,
    toolCacheFresh: cacheAgeMs !== null && cacheAgeMs < TOOL_CACHE_TTL_MS,
    lastError,
    lastSuccessAt,
  };
}

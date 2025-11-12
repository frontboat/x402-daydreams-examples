import { createAgentApp } from '@lucid-agents/agent-kit-hono';
import { paymentsFromEnv } from '@lucid-agents/agent-kit';
import { createDreams, context, LogLevel, action, Logger } from '@daydreamsai/core';
import { openrouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';

type TranscriptEntry = {
  role: 'user' | 'assistant';
  message: string;
  at: string;
};

type SupportMemory = {
  requestCount: number;
  transcript: TranscriptEntry[];
  lastUserMessage?: string;
};

type DaydreamsLog = {
  ref?: string;
  data?: unknown;
  content?: unknown;
  name?: string;
};

type LogMeta = Record<string, unknown>;
type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

const logLevelPriority: Record<LogLevelName, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const resolveLogLevel = (value: string | undefined): LogLevelName => {
  switch ((value ?? '').toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
};

const activeLogLevel = resolveLogLevel(process.env.SCHEMAAGENT_LOG_LEVEL);

const formatLogMeta = (meta?: LogMeta): string => {
  if (!meta || Object.keys(meta).length === 0) {
    return '';
  }
  const normalized = Object.entries(meta).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (value instanceof Error) {
      acc[key] = { message: value.message, stack: value.stack };
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
  const serialized = stringifyUnknown(normalized);
  return serialized ? ` ${serialized}` : '';
};

const emitLog = (level: LogLevelName, message: string, meta?: LogMeta): void => {
  if (logLevelPriority[level] < logLevelPriority[activeLogLevel]) {
    return;
  }
  const timestamp = new Date().toISOString();
  const payload = `[${timestamp}] [schema-agent] ${level.toUpperCase()} ${message}${formatLogMeta(meta)}`;
  if (level === 'error') {
    console.error(payload);
  } else if (level === 'warn') {
    console.warn(payload);
  } else {
    console.log(payload);
  }
};

const logger = {
  debug: (message: string, meta?: LogMeta) => emitLog('debug', message, meta),
  info: (message: string, meta?: LogMeta) => emitLog('info', message, meta),
  warn: (message: string, meta?: LogMeta) => emitLog('warn', message, meta),
  error: (message: string, meta?: LogMeta) => emitLog('error', message, meta),
};

const stringifyUnknown = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const extractResponseText = (log: DaydreamsLog): string | undefined => {
  const pickText = (value: unknown): string | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return pickText(JSON.parse(trimmed));
        } catch {
          // fall through to returning the original string
        }
      }
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['content', 'message', 'text']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate;
        }
      }
    }

    return undefined;
  };

  return pickText(log.content) ?? pickText(log.data) ?? stringifyUnknown(log.content) ?? stringifyUnknown(log.data);
};

const previewText = (value: string, maxLength = 120): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
};

type SupportResult = {
  output: {
    sessionId: string;
    response: string;
    totalRequests: number;
  };
};

const ensureEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    logger.error('Missing required environment variable', { name });
    throw new Error(`Missing required environment variable: ${name}`);
  }
  logger.debug('Environment variable resolved', { name });
  return value;
};

const payments = paymentsFromEnv({
  defaultPrice: process.env.SCHEMAAGENT_DEFAULT_PRICE,
});
const paymentsDisabled = process.env.SCHEMAAGENT_DISABLE_PAYMENTS === 'true';
logger.info('Payments configuration loaded', {
  disabled: paymentsDisabled,
  usingPayments: Boolean(payments),
});
if (!payments && !paymentsDisabled) {
  logger.error('Payments required but configuration missing');
  throw new Error('Schema Agent requires x402 payments. Set FACILITATOR_URL, PAYMENTS_RECEIVABLE_ADDRESS, NETWORK, and DEFAULT_PRICE.');
}
ensureEnv('OPENROUTER_API_KEY');
logger.info('OpenRouter API key availability verified');

const getSchemaStatus = action({
  name: 'fetch-schema',
  description: 'POST to URLs so you can explain their x402 required schemas.',
  schema: z.object({
    urlToFetch: z.string().min(1, 'url is required'),
  }),
  handler: async ({ urlToFetch }) => {
    logger.info('Action fetch-schema invoked', { url: urlToFetch });
    try {
      const url = new URL(urlToFetch);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const rawBody = await response.text();
      let parsedBody: unknown = rawBody;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        // leave parsedBody as the raw string
      }
      logger.info('Action fetch-schema completed', {
        url: url.toString(),
        status: response.status,
        ok: response.ok,
      });

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: parsedBody,
      };
    } catch (error) {
      logger.error('Action fetch-schema failed', {
        url: urlToFetch,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});

const supportContext = context({
  type: 'schema-support',
  key: (args) => args.sessionId,
  schema: z.object({
    sessionId: z.string(),
  }),
  create: (): SupportMemory => {
    logger.debug('Initializing support memory state');
    return {
      requestCount: 0,
      transcript: [],
      lastUserMessage: undefined,
    };
  },
  render: (state) => {
    logger.debug('Rendering support context', {
      sessionId: state.args.sessionId,
      requestCount: state.memory.requestCount,
    });
    const recent = state.memory.transcript
      .slice(-5)
      .map((entry) => `${entry.at} ${entry.role.toUpperCase()}: ${entry.message}`)
      .join('\n');

    return [
      `Session: ${state.args.sessionId}`,
      `Requests: ${state.memory.requestCount}`,
      state.memory.lastUserMessage ? `Last user message: ${state.memory.lastUserMessage}` : 'No user messages yet.',
      recent ? `Recent transcript:\n${recent}` : 'Transcript is empty.',
    ].join('\n');
  },
  instructions: `You are the X402 Resource Schema Explorer agent for x402 enabled services. Be exploratory and map out resource API surfaces, schemas, and pricing details—especially when paywalls respond with metadata.
- Stay read-only: you may only suggest GET calls or payload drafts.
- Coach users on preparing request payloads but never submit them for the user.
- Call actions whenever documentation is unclear so you can summarize their outputs (including status codes, required headers, accepts blocks, and schema fields).
- Treat 402 responses as documentation: in the very first reply include both the payment requirements and a concise breakdown of request/response fields surfaced in the body.
- Clearly explain schema structures (inputs, outputs, constraints) using whatever data the 402 payload exposes, since that is the primary way you learn about the resource.
- Never say you were unable to fetch the schema; treat any response body (especially 402 payloads) as authoritative and explain it directly.
- When actions return payment requirements, highlight the network, asset, payTo address, price, and any other hints so users know how to proceed.`,
  onRun: async (ctx) => {
    ctx.memory.requestCount += 1;
    logger.info('Support context run invoked', {
      sessionId: ctx.args.sessionId,
      totalRequests: ctx.memory.requestCount,
    });
  },
}).setActions([getSchemaStatus]);

const modelId = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
const temperature = Number(process.env.OPENROUTER_TEMPERATURE ?? '0.2');
const resolvedTemperature = Number.isFinite(temperature) ? temperature : 0.2;
logger.info('Configuring Daydreams agent', {
  modelId,
  temperature: resolvedTemperature,
});

const agent = createDreams({
  model: openrouter(modelId),
  logLevel: LogLevel.ERROR,
  modelSettings: {
    temperature: resolvedTemperature,
  },
  contexts: [supportContext],
  inputs: {
    text: {
      description: 'User message sent to the schema agent',
      schema: z.string(),
    },
  },
  outputs: {
    text: {
      description: 'Schema agent response returned to the caller',
      schema: z.string(),
    },
  },
});
logger.info('Daydreams agent configured');

logger.info('Starting Daydreams agent runtime');
await agent.start();
logger.info('Daydreams agent runtime started');

const resolvedPayments = paymentsDisabled ? false : payments;
logger.info('Resolved payments integration', {
  enabled: Boolean(resolvedPayments),
});

const { app, addEntrypoint } = createAgentApp(
  {
    name: 'X402 Resource Schema Explorer',
    version: '1.1.2',
    description: 'Speak with a Daydreams agent to explore x402 resources, inspect schemas, and get help shaping request payloads.',
  },
  {
    payments: resolvedPayments,
  }
);
logger.info('Agent application initialized', {
  name: 'X402 Resource Schema Explorer',
  version: '1.1.2',
});

const registerEntrypoint = addEntrypoint as (def: unknown) => void;

type SupportInput = {
  message: string;
  sessionId?: string;
};

const supportInput = z.object({
  message: z
    .string()
    .min(1, 'message is required')
    .describe('User question or request.'),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional session identifier to resume a previous context.'),
});

const supportOutput = z.object({
  sessionId: z.string(),
  response: z.string(),
  totalRequests: z.number(),
});

registerEntrypoint({
  key: 'explore',
  description: 'Speak with a Daydreams agent to explore x402 resources, inspect schemas, and get help shaping request payloads.',
  input: supportInput,
  output: supportOutput,
  async handler({ input }: { input: unknown }): Promise<SupportResult> {
    const payload = input as SupportInput;
    const sessionId = payload.sessionId ?? crypto.randomUUID();
    const userMessagePreview = previewText(payload.message);
    logger.info('Explore entrypoint invoked', {
      sessionId,
      providedSessionId: payload.sessionId ?? null,
      messageLength: payload.message.length,
      messagePreview: userMessagePreview,
    });
    logger.debug('Loading support context for session', { sessionId });
    const contextState = (await agent.getContext({
      context: supportContext,
      args: { sessionId },
    })) as { memory: SupportMemory };
    logger.debug('Support context loaded', {
      sessionId,
      requestCount: contextState.memory.requestCount,
      transcriptEntries: contextState.memory.transcript.length,
    });

    const now = new Date().toISOString();
    contextState.memory.lastUserMessage = payload.message;
    contextState.memory.transcript.push({
      role: 'user',
      message: payload.message,
      at: now,
    });
    logger.debug('User message appended to transcript', {
      sessionId,
      transcriptEntries: contextState.memory.transcript.length,
    });
    if (contextState.memory.transcript.length > 20) {
      contextState.memory.transcript = contextState.memory.transcript.slice(-20);
      logger.debug('Transcript truncated after user append', {
        sessionId,
        transcriptEntries: contextState.memory.transcript.length,
      });
    }

    logger.info('Sending message to Dream agent', { sessionId });
    const result = (await agent.send({
      context: supportContext,
      args: { sessionId },
      input: { type: 'text', data: payload.message },
    })) as DaydreamsLog[];
    logger.info('Agent run completed', {
      sessionId,
      logEntries: result.length,
    });
    logger.debug('Agent log refs', {
      sessionId,
      refs: result.map((entry) => entry.ref ?? 'unknown'),
    });

    const output = [...result].reverse().find((entry) => entry.ref === 'output');
    const response = output ? extractResponseText(output) ?? 'I could not process that request.' : 'I could not process that request.';
    logger.debug('Response extracted from agent output', {
      sessionId,
      hasOutput: Boolean(output),
      responsePreview: previewText(response),
    });

    contextState.memory.transcript.push({
      role: 'assistant',
      message: response,
      at: new Date().toISOString(),
    });
    logger.debug('Assistant response appended to transcript', {
      sessionId,
      transcriptEntries: contextState.memory.transcript.length,
    });
    if (contextState.memory.transcript.length > 20) {
      contextState.memory.transcript = contextState.memory.transcript.slice(-20);
      logger.debug('Transcript truncated after assistant append', {
        sessionId,
        transcriptEntries: contextState.memory.transcript.length,
      });
    }

    logger.info('Explore entrypoint completed', {
      sessionId,
      totalRequests: contextState.memory.requestCount,
    });
    logger.info('Explore entrypoint response ready', {
      sessionId,
      totalRequests: contextState.memory.requestCount,
      responseLength: response.length,
      responsePreview: previewText(response, 240),
    });

    return {
      output: {
        sessionId,
        response,
        totalRequests: contextState.memory.requestCount,
      },
    };
  },
});
logger.info('Explore entrypoint registered');

const port = Number(process.env.PORT ?? 3000);
const corsAllowedOrigin = process.env.SCHEMAAGENT_CORS_ORIGIN ?? '*';
const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': corsAllowedOrigin,
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
logger.info('HTTP server configuration resolved', { port, corsAllowedOrigin });

const applyCors = (response: Response): Response => {
  logger.debug('Applying CORS headers to response', {
    status: response.status,
    statusText: response.statusText,
  });
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const handleCorsPreflight = (request: Request): Response | null => {
  logger.debug('Evaluating request for CORS preflight handling', {
    method: request.method,
    url: request.url,
  });
  if (request.method !== 'OPTIONS') {
    return null;
  }
  logger.info('Handling CORS preflight request', {
    url: request.url,
    origin: request.headers.get('origin'),
  });
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
};

type ForwardedRequestInit = RequestInit & { duplex?: 'half' };

const normalizeForwardedRequest = (request: Request): Request => {
  logger.debug('Normalizing forwarded request', {
    url: request.url,
    method: request.method,
    forwardedProto: request.headers.get('x-forwarded-proto'),
  });
  // Railway (and similar proxies) terminate TLS and forward the request over http, so
  // we honor X-Forwarded-Proto to keep the paywall resource URL aligned with HTTPS.
  const protoHeader = request.headers.get('x-forwarded-proto');
  if (!protoHeader) {
    return request;
  }
  const forwardedProto = protoHeader.split(',')[0]?.trim();
  if (!forwardedProto) {
    return request;
  }
  const currentUrl = new URL(request.url);
  const currentProto = currentUrl.protocol.replace(':', '');
  if (currentProto === forwardedProto) {
    return request;
  }
  currentUrl.protocol = `${forwardedProto}:`;
  const cloned = request.clone();
  const init: ForwardedRequestInit = {
    method: cloned.method,
    headers: Array.from(cloned.headers.entries()),
    body: cloned.body ?? undefined,
  };
  if (cloned.body) {
    init.duplex = 'half';
  }
  const normalized = new Request(currentUrl.toString(), init);
  logger.info('Adjusted forwarded protocol for request', {
    originalUrl: request.url,
    normalizedUrl: normalized.url,
  });
  return normalized;
};

const server = Bun.serve({
  port,
  fetch: async (incomingRequest) => {
    const requestId = crypto.randomUUID();
    logger.info('Incoming HTTP request received', {
      requestId,
      method: incomingRequest.method,
      url: incomingRequest.url,
    });
    const request = normalizeForwardedRequest(incomingRequest);
    const preflight = handleCorsPreflight(request);
    if (preflight) {
      logger.info('Responding to CORS preflight', { requestId });
      return preflight;
    }
    logger.debug('Forwarding request to app handler', {
      requestId,
      url: request.url,
    });
    const response = await app.fetch(request);
    logger.info('App handler produced response', {
      requestId,
      status: response.status,
    });
    const finalResponse = applyCors(response);
    logger.debug('CORS headers applied to response', { requestId });
    return finalResponse;
  },
});

app.get('/entrypoints/explore/invoke', (c) => {
  logger.info('Entrypoint metadata requested', { path: '/entrypoints/explore/invoke' });
  return c.json({
    description:
      'Speak with a Daydreams agent to explore x402 resources, inspect schemas, and get help shaping request payloads.',
    method: 'POST',
    body: {
      type: 'json',
      fields: {
        message: { type: 'string', required: true, description: 'User request or question.' },
        sessionId: { type: 'string', required: false, description: 'Optional session identifier to resume context.' },
      },
    },
    output: {
      sessionId: 'string',
      response: 'string',
      totalRequests: 'number',
    }
  });
});

logger.info('X402 Schema Explorer agent running', {
  url: `http://localhost:${server.port}`,
});

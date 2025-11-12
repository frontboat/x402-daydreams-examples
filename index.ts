import { createAgentApp } from '@lucid-agents/agent-kit-hono';
import { paymentsFromEnv } from '@lucid-agents/agent-kit';
import { createDreams, context, LogLevel, action } from '@daydreamsai/core';
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
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const payments = paymentsFromEnv({
  defaultPrice: process.env.SCHEMAAGENT_DEFAULT_PRICE,
});
const paymentsDisabled = process.env.SCHEMAAGENT_DISABLE_PAYMENTS === 'true';
if (!payments && !paymentsDisabled) {
  throw new Error('Schema Agent requires x402 payments. Set FACILITATOR_URL, PAYMENTS_RECEIVABLE_ADDRESS, NETWORK, and DEFAULT_PRICE.');
}
ensureEnv('OPENROUTER_API_KEY');

const getSchemaStatus = action({
  name: 'fetch-schema',
  description: 'POST to URLs so you can explain their x402 required schemas.',
  schema: z.object({
    urlToFetch: z.string().min(1, 'url is required'),
  }),
  handler: async ({ urlToFetch }) => {
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

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: parsedBody,
      };
    } catch (error) {
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
  create: (): SupportMemory => ({
    requestCount: 0,
    transcript: [],
    lastUserMessage: undefined,
  }),
  render: (state) => {
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
  },
}).setActions([getSchemaStatus]);

const modelId = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
const temperature = Number(process.env.OPENROUTER_TEMPERATURE ?? '0.2');

const agent = createDreams({
  model: openrouter(modelId),
  modelSettings: {
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
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
  logLevel: process.env.DAYDREAMS_LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

await agent.start();

const resolvedPayments = paymentsDisabled ? false : payments;

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
    console.log(`[schema-agent] session=${sessionId}`);
    const contextState = (await agent.getContext({
      context: supportContext,
      args: { sessionId },
    })) as { memory: SupportMemory };

    const now = new Date().toISOString();
    contextState.memory.lastUserMessage = payload.message;
    contextState.memory.transcript.push({
      role: 'user',
      message: payload.message,
      at: now,
    });
    if (contextState.memory.transcript.length > 20) {
      contextState.memory.transcript = contextState.memory.transcript.slice(-20);
    }

    const result = (await agent.send({
      context: supportContext,
      args: { sessionId },
      input: { type: 'text', data: payload.message },
    })) as DaydreamsLog[];

    const output = result.find((entry) => entry.ref === 'output');
    const response =
      output && 'data' in output
        ? typeof output.data === 'string'
          ? output.data
          : JSON.stringify(output.data)
        : 'I could not process that request.';

    contextState.memory.transcript.push({
      role: 'assistant',
      message: response,
      at: new Date().toISOString(),
    });
    if (contextState.memory.transcript.length > 20) {
      contextState.memory.transcript = contextState.memory.transcript.slice(-20);
    }

    return {
      output: {
        sessionId,
        response,
        totalRequests: contextState.memory.requestCount,
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
const corsAllowedOrigin = process.env.SCHEMAAGENT_CORS_ORIGIN ?? '*';
const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': corsAllowedOrigin,
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const applyCors = (response: Response): Response => {
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
  if (request.method !== 'OPTIONS') {
    return null;
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
};

type ForwardedRequestInit = RequestInit & { duplex?: 'half' };

const normalizeForwardedRequest = (request: Request): Request => {
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
  return new Request(currentUrl.toString(), init);
};

const server = Bun.serve({
  port,
  fetch: async (incomingRequest) => {
    const request = normalizeForwardedRequest(incomingRequest);
    const preflight = handleCorsPreflight(request);
    if (preflight) {
      return preflight;
    }
    const response = await app.fetch(request);
    return applyCors(response);
  },
});

app.get('/entrypoints/explore/invoke', (c) =>
  c.json({
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
  })
);

console.log(`X402 Schema Explorer agent running on http://localhost:${server.port}`);

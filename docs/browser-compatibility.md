# MCP Server Browser & Edge Runtime Compatibility Assessment

## 1. Survey of Existing Browser-Friendly MCP Server Options

* **Official SDKs.** The current `@modelcontextprotocol/sdk` package only ships Node-targeted server transports (stdio, HTTP/SSE). No first-party browser or service-worker transport exists yet, so we must extend this package rather than adopting an external implementation.
* **Community ecosystem.** Public repositories focus on Node hosts. Packages such as `vscode-jsonrpc` can help with message framing, but none implement MCP-specific initialization, capabilities, or resumable sessions out of the box.
* **Edge runtimes.** Platforms such as Cloudflare Workers expose Fetch-style request handlers and lack Node primitives like `http.ServerResponse`. Instead of forking the SDK, we can adapt the existing SSE transport through a Fetch-compatible adapter that binds the server core to Worker APIs.

## 2. Node-Specific Dependencies in `src/server`

| File | Node / Environment Assumption |
| --- | --- |
| `auth/handlers/register.ts` | Express middleware, CORS helpers, rate limiters, and Node `crypto` for PKCE & OAuth. Cloudflare Workers provide Web Crypto, but browsers lack the server-side OAuth callback flow entirely.【F:src/server/auth/handlers/register.ts†L1-L118】 |
| `stdio.ts` | Uses `process`, Node streams, and Buffers; cannot run in browsers or Workers.【F:src/server/stdio.ts†L1-L92】 |
| `sse.ts` | Streaming surface now uses an abstract connection interface so Fetch adapters can plug in, but `handlePostMessage` still assumes Node `IncomingMessage` for legacy servers.【F:src/server/sse.ts†L1-L221】 |
| `streamableHttp.ts` | Similar Node `http` assumptions plus `raw-body`, `content-type`, and long-lived connection state that is reset whenever a Worker instance is evicted.【F:src/server/streamableHttp.ts†L1-L200】 |
| Higher-level server core | `Server` and `McpServer` orchestrate schemas and callbacks without Node APIs, so they can be reused once a compatible transport is provided.【F:src/server/index.ts†L1-L161】【F:src/server/mcp.ts†L1-L120】 |

**OAuth considerations.** Browsers cannot accept inbound OAuth redirects, so a browser-embedded server must delegate OAuth to an external service. Cloudflare Workers expose `crypto.subtle` and Fetch but still lack Express middleware, so the current auth module would need a Worker-specific implementation.

## 3. Why a New Transport Is Necessary (and Not Sufficient on Its Own)

* **Transport layer.** A Fetch-compatible adapter now reuses `SSEServerTransport` by providing a stream implementation backed by the Web Streams API. This keeps the core server untouched while letting Workers and browsers participate in SSE without a bespoke transport class.【F:src/cloudflare/sse.ts†L1-L170】
* **Packaging constraints.** Even with the adapter, bundlers will still pull Node-only files unless we provide separate entry points (e.g., `package.json` exports for `./server/node` vs `./server/edge`). Installing the current package in a browser bundler fails because it eagerly resolves `node:http`, so conditional exports remain a requirement to avoid forking the SDK.
* **Shared utilities.** Crypto, body parsing, and header helpers must be rewritten against Web APIs (Fetch & Web Crypto). Cloudflare supports these APIs already; browsers need polyfills only when hosting OAuth or long-lived sessions.

## 4. Minimal Refactor Plan

1. **Transport modules.** Keep `SSEServerTransport` as the shared core and add thin adapters (Fetch today, postMessage next) under `src/cloudflare/` (Workers) and future browser-specific directories. Re-export them through `server/transports/index.ts` so bundlers can tree-shake per environment.【F:src/server/transports/index.ts†L1-L7】【F:src/cloudflare/index.ts†L1-L6】
2. **Utility shims.** Create shared helpers for headers, streaming bodies, and crypto so both Node and Worker adapters depend on runtime-neutral code. The Fetch adapter already normalizes headers into plain objects for the server core.【F:src/cloudflare/sse.ts†L129-L170】
3. **Conditional exports.** Update `package.json` to expose `@modelcontextprotocol/sdk/server/transports/edge` (Fetch SSE, upcoming postMessage) alongside the existing Node exports. This lets browser bundlers avoid Node entry points without copying the entire codebase.
4. **Authentication split.** Keep OAuth in a Node/Worker-only subpath. Browser builds should omit OAuth entirely; Cloudflare Workers can receive redirects by registering a dedicated Fetch handler that uses Web Crypto to validate PKCE. This keeps OAuth support for Workers without blocking browser adoption.

## 5. Cloudflare Worker Example

The Fetch adapter enables a Worker script to host MCP endpoints without Node globals. A minimal Worker looks like this:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    createFetchSSESession,
    handleFetchSSEPost
} from '@modelcontextprotocol/sdk/cloudflare/index.js';
import { z } from 'zod';

const server = new McpServer({ name: 'cf-worker-demo', version: '0.1.0' });
const sessions = new Map<string, Awaited<ReturnType<typeof createFetchSSESession>>['transport']>();

server.registerTool(
    'echo',
    {
        title: 'Echo Tool',
        description: 'Echo back the provided message',
        inputSchema: { text: z.string() },
        outputSchema: { text: z.string() }
    },
    async ({ text }) => ({
        content: [{ type: 'text', text }],
        structuredContent: { text }
    })
);

export default {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/sse') {
            const { transport, response } = await createFetchSSESession('/messages', {
                signal: request.signal
            });
            sessions.set(transport.sessionId, transport);
            transport.onclose = () => sessions.delete(transport.sessionId);
            await server.connect(transport);
            return response;
        }

        if (request.method === 'POST' && url.pathname === '/messages') {
            const sessionId = url.searchParams.get('sessionId');
            if (!sessionId) {
                return new Response('Missing sessionId', { status: 400 });
            }
            const transport = sessions.get(sessionId);
            if (!transport) {
                return new Response('Unknown session', { status: 404 });
            }
            return handleFetchSSEPost(request, transport);
        }

        return new Response('Not found', { status: 404 });
    }
};
```

This sample lives in `src/examples/cloudflareWorker.ts` for easy copy/paste into a Cloudflare Worker project.【F:src/examples/cloudflareWorker.ts†L1-L112】

## 6. Browser Strategy (Post-Worker Milestone)

1. **postMessage transport.** After stabilizing the Worker transport, implement a browser transport that wraps `MessagePort`/`postMessage`. It can reuse the request queueing logic from the Worker transport with a different I/O adapter.
2. **Bundled build.** Publish an ES module bundle targeting `es2022` + `dom` libs for browsers. The bundle should exclude Node-only dependencies and rely on tree-shaken entry points described above.
3. **Tool execution model.** Browser servers will proxy tools to remote APIs (fetch calls) because direct filesystem or network access is unavailable. Provide helper utilities to register HTTP-backed tools.
4. **OAuth offload.** Document that OAuth must be delegated to a backend (e.g., the Worker transport) when running purely in-browser.

## 7. Next Steps

1. Carve existing transports into `server/transports/node/` and mark them as Node-only exports.
2. Add Web Crypto + Fetch shims for auth and body parsing so Cloudflare Worker OAuth flows can reuse shared code.
3. Implement a MessagePort/browser transport and ship a browser-focused bundle once the Worker path is verified.
4. Build integration tests that run against Miniflare (Workers) and a browser automation harness to ensure compatibility.

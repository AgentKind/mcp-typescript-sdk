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
| `sse.ts` | Strictly Node: depends on `node:http`, `raw-body`, and `node:crypto` for UUIDs. The Worker-friendly replacement lives in `src/cloudflare/sse.ts`.【F:src/server/sse.ts†L1-L221】【F:src/cloudflare/sse.ts†L1-L207】 |
| `streamableHttp.ts` | Similar Node `http` assumptions plus `raw-body`, `content-type`, and long-lived connection state that is reset whenever a Worker instance is evicted.【F:src/server/streamableHttp.ts†L1-L200】 |
| Higher-level server core | `Server` and `McpServer` orchestrate schemas and callbacks without Node APIs, so they can be reused once a compatible transport is provided.【F:src/server/index.ts†L1-L161】【F:src/server/mcp.ts†L1-L120】 |

**OAuth considerations.** Browsers cannot accept inbound OAuth redirects, so a browser-embedded server must delegate OAuth to an external service. Cloudflare Workers expose `crypto.subtle` and Fetch but still lack Express middleware, so the current auth module would need a Worker-specific implementation.

## 3. Why a New Transport Is Necessary (and Not Sufficient on Its Own)

* **Transport layer.** A dedicated `FetchSSEServerTransport` reimplements the `SSEServerTransport` contract on top of Fetch/Web Streams so Workers expose the same handshake without pulling Node dependencies.【F:src/cloudflare/sse.ts†L95-L197】
* **Packaging constraints.** Even with the adapter, bundlers will still pull Node-only files unless we provide separate entry points (e.g., `package.json` exports for `./server/node` vs `./server/edge`). Installing the current package in a browser bundler fails because it eagerly resolves `node:http`, so conditional exports remain a requirement to avoid forking the SDK. Node-specific runtime dependencies (Express, raw-body, etc.) are now exposed as optional peer dependencies so edge builds can install the SDK without dragging in incompatible modules.
* **Shared utilities.** Crypto, body parsing, and header helpers must be rewritten against Web APIs (Fetch & Web Crypto). Cloudflare supports these APIs already; browsers need polyfills only when hosting OAuth or long-lived sessions.

## 4. Minimal Refactor Plan

1. **Transport modules.** Keep the Node transports untouched and add Fetch-specific counterparts (e.g., `FetchSSEServerTransport`) under `src/cloudflare/`, re-exported via `server/transports/` for opt-in edge builds.【F:src/server/sse.ts†L1-L221】【F:src/server/transports/index.ts†L1-L8】
2. **Utility shims.** Create shared helpers for headers, streaming bodies, and crypto so both Node and Worker adapters depend on runtime-neutral code. The Fetch adapter already normalizes headers into plain objects for the server core.【F:src/cloudflare/sse.ts†L129-L170】
3. **Conditional exports.** Update `package.json` to expose `@modelcontextprotocol/sdk/server/transports/edge` (Fetch SSE, upcoming postMessage) alongside the existing Node exports. This lets browser bundlers avoid Node entry points without copying the entire codebase.
4. **Authentication split.** Keep OAuth in a Node/Worker-only subpath. Browser builds should omit OAuth entirely; Cloudflare Workers can receive redirects by registering a dedicated Fetch handler that uses Web Crypto to validate PKCE. This keeps OAuth support for Workers without blocking browser adoption.

## 5. Cloudflare Worker Example

The Fetch adapter enables a Worker script to host MCP endpoints without Node globals. The helper returns `{ transport, response, dispose }` so Workers can clean up streams if the handshake fails or when the client disconnects. A minimal Worker looks like this:

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
            const { transport, response, dispose } = await createFetchSSESession('/messages', {
                signal: request.signal
            });

            try {
                await server.connect(transport);
            } catch (error) {
                dispose();
                return new Response(`Failed to start SSE session: ${error instanceof Error ? error.message : String(error)}`, {
                    status: 500
                });
            }

            sessions.set(transport.sessionId, transport);
            transport.onclose = () => {
                dispose();
                sessions.delete(transport.sessionId);
            };
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

This sample lives in `src/examples/cloudflareWorker.ts` for easy copy/paste into a Cloudflare Worker project.【F:src/examples/cloudflareWorker.ts†L1-L74】

### Local Wrangler smoke tests

To confirm the environment before wiring in MCP, keep two progressively more advanced Workers handy:

1. **Hello world sanity check.** `src/examples/cloudflareHelloWorker.ts` returns plain text so you can validate that `wrangler dev` is reachable from the container with `curl http://127.0.0.1:8787/`.【F:src/examples/cloudflareHelloWorker.ts†L1-L7】
2. **Raw SSE probe.** `src/examples/cloudflareSseHelloWorker.ts` streams an `event: ready` record plus periodic keep-alive comments so `wrangler dev` stays happy with long-lived requests before the MCP server is involved.【F:src/examples/cloudflareSseHelloWorker.ts†L1-L35】

Once both scripts respond locally, switch to the MCP example and hit `GET /sse` to watch the endpoint announcement followed by keep-alive frames (every ~15s) generated by the Fetch transport itself.【F:src/cloudflare/sse.ts†L22-L116】 Pair the stream with `POST /messages?sessionId=...` to send JSON-RPC payloads back into the server.【F:src/examples/cloudflareWorker.ts†L36-L69】

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

# MCP Server Browser & Edge Runtime Compatibility Assessment

## 1. Survey of Existing Browser-Friendly MCP Server Options

* **Official SDKs.** The current `@modelcontextprotocol/sdk` package only ships Node-targeted server transports (stdio, HTTP/SSE). No first-party browser or service-worker transport exists yet, so we must extend this package rather than adopting an external implementation.
* **Community ecosystem.** Public repositories focus on Node hosts. Packages such as `vscode-jsonrpc` can help with message framing, but none implement MCP-specific initialization, capabilities, or resumable sessions out of the box.
* **Edge runtimes.** Platforms such as Cloudflare Workers expose Fetch-style request handlers and lack Node primitives like `http.ServerResponse`. There is no ready-made adapter today, which is why we are introducing a Worker transport in this repo.

## 2. Node-Specific Dependencies in `src/server`

| File | Node / Environment Assumption |
| --- | --- |
| `auth/handlers/register.ts` | Express middleware, CORS helpers, rate limiters, and Node `crypto` for PKCE & OAuth. Cloudflare Workers provide Web Crypto, but browsers lack the server-side OAuth callback flow entirely.【F:src/server/auth/handlers/register.ts†L1-L118】 |
| `stdio.ts` | Uses `process`, Node streams, and Buffers; cannot run in browsers or Workers.【F:src/server/stdio.ts†L1-L92】 |
| `sse.ts` | Depends on Node `http.IncomingMessage`/`ServerResponse`, `crypto.randomUUID`, and streaming helpers unavailable in Fetch environments.【F:src/server/sse.ts†L1-L198】 |
| `streamableHttp.ts` | Similar Node `http` assumptions plus `raw-body`, `content-type`, and long-lived connection state that is reset whenever a Worker instance is evicted.【F:src/server/streamableHttp.ts†L1-L200】 |
| Higher-level server core | `Server` and `McpServer` orchestrate schemas and callbacks without Node APIs, so they can be reused once a compatible transport is provided.【F:src/server/index.ts†L1-L161】【F:src/server/mcp.ts†L1-L120】 |

**OAuth considerations.** Browsers cannot accept inbound OAuth redirects, so a browser-embedded server must delegate OAuth to an external service. Cloudflare Workers expose `crypto.subtle` and Fetch but still lack Express middleware, so the current auth module would need a Worker-specific implementation.

## 3. Why a New Transport Is Necessary (and Not Sufficient on Its Own)

* **Transport layer.** A Fetch-compatible transport is required to translate Worker/browser requests into MCP JSON-RPC messages. We added an initial `WorkerFetchTransport` that handles request/response lifecycles for Cloudflare Workers and queues notifications between polls.【F:src/server/transports/workerFetch.ts†L1-L208】 This replaces the Node `streamableHttp` transport in edge environments.
* **Packaging constraints.** Even with a new transport, bundlers will still pull Node-only files unless we provide separate entry points (e.g., `package.json` exports for `./server/node` vs `./server/worker`). Installing the current package in a browser bundler fails because it eagerly resolves `node:http`, `raw-body`, and other Node-builtins. Splitting transports into subdirectories and using conditional exports avoids having to ship an entirely parallel SDK, but we must reorganize the module surface.
* **Shared utilities.** Crypto, body parsing, and header helpers must be rewritten against Web APIs (Fetch & Web Crypto). Cloudflare supports these APIs already; browsers need polyfills only when hosting OAuth or long-lived sessions.

## 4. Minimal Refactor Plan

1. **Transport modules.** Introduce `src/server/transports/workerFetch.ts` (done) and migrate existing Node transports into `src/server/transports/node/` during follow-up work. Re-export transports from `src/server/transports/index.ts` so bundlers can tree-shake per environment.【F:src/server/transports/index.ts†L1-L6】
2. **Utility shims.** Create shared helpers for headers, streaming bodies, and crypto so both Node and Worker transports depend on runtime-neutral code. The new Worker transport already normalizes headers into `IsomorphicHeaders` expected by the server core.【F:src/server/transports/workerFetch.ts†L109-L142】
3. **Conditional exports.** Update `package.json` to expose `@modelcontextprotocol/sdk/server/transports/worker` (Worker) and `.../node` (existing). This lets browser bundlers avoid Node entry points without copying the entire codebase.
4. **Authentication split.** Keep OAuth in a Node/Worker-only subpath. Browser builds should omit OAuth entirely; Cloudflare Workers can receive redirects by registering a dedicated Fetch handler that uses Web Crypto to validate PKCE. This keeps OAuth support for Workers without blocking browser adoption.

## 5. Cloudflare Worker Example

The new Worker transport enables a Worker script to host MCP endpoints without Node globals. A minimal Worker looks like this:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkerFetchTransport } from '@modelcontextprotocol/sdk/server/transports/index.js';
import { z } from 'zod';

const server = new McpServer({ name: 'cf-worker-demo', version: '0.1.0' });
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
        const transport = new WorkerFetchTransport({ responseTimeoutMs: 5000 });
        await server.connect(transport);
        try {
            const workerResponse = await transport.handleRequest({
                method: request.method,
                headers: request.headers,
                text: () => request.text()
            });
            await transport.close();
            return new Response(workerResponse.body, {
                status: workerResponse.status,
                headers: workerResponse.headers
            });
        } catch (error) {
            await transport.close();
            return new Response(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: error instanceof Error ? error.message : 'Unknown error'
                    }
                }),
                {
                    status: 500,
                    headers: { 'content-type': 'application/json' }
                }
            );
        }
    }
};
```

This sample lives in `src/examples/cloudflareWorker.ts` for easy copy/paste into a Cloudflare Worker project.【F:src/examples/cloudflareWorker.ts†L1-L64】

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

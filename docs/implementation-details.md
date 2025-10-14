# Implementation Details

## Overview

This iteration keeps the public MCP client and server interfaces untouched while swapping out the pieces that previously locked the package to Node-only dependencies. The goal was to make the SDK installable inside Worker and browser projects without forcing incompatible transitive packages, and to prove parity by running a real MCP server behind `wrangler dev` with a full client round trip.

## Dependency Strategy

* **Runtime dependencies.** The only runtime packages that remain in `dependencies` are now Fetch/Web Streams compatible (`ajv`, `content-type`, `eventsource-parser`, `zod`). Node-only libraries such as Express, `cross-spawn`, and `raw-body` are declared as optional peer dependencies so npm/yarn/pnpm do not pull them when targeting edge or browser builds.【F:package.json†L55-L95】
* **Node shims removed from the client.** The SSE client transport no longer uses the Node `eventsource` polyfill. Instead it relies on `fetch`, `ReadableStream`, and the streaming parser so the same code runs under browsers, Workers, and Node 18+. The class surface (`start`, `send`, `close`, auth hooks) and option bag stay identical to the historical implementation.【F:src/client/sse.ts†L1-L215】【F:src/shared/transport.ts†L1-L63】

## Worker Transport Layer

* **Fetch-compatible server transport.** `FetchSSEServerTransport` reimplements the existing server transport contract using Web Streams. It emits the same `event: endpoint` handshake, validates request headers, and pipes JSON-RPC payloads back to the `Server` core without touching Node primitives.【F:src/cloudflare/sse.ts†L1-L197】
* **Re-exports for parity.** The new transport is surfaced via `src/server/transports` so existing imports like `@modelcontextprotocol/sdk/server/transports` keep working and edge runtimes can opt in without a fork.【F:src/server/transports/index.ts†L1-L8】

## Wrangler Integration Testing

* **End-to-end Worker harness.** `src/examples/cloudflareWorker.ts` wires the Fetch transport into an `McpServer`, tracks sessions, and exposes `/sse` and `/messages` routes for clients.【F:src/examples/cloudflareWorker.ts†L1-L74】
* **Automated regression test.** `src/examples/cloudflareWorker.integration.test.ts` spawns `wrangler dev`, waits until the Worker is ready, connects an MCP client over SSE, lists tools, and invokes the `echo` tool. This ensures the Worker example stays healthy and exercises both sides of the protocol.【F:src/examples/cloudflareWorker.integration.test.ts†L1-L193】

## Documentation

* **Compatibility guide updates.** `docs/browser-compatibility.md` now explains the optional peer dependency stance, the Fetch transport architecture, and the staged Wrangler smoke tests so developers can reproduce the setup before enabling MCP in their Workers.【F:docs/browser-compatibility.md†L1-L160】
* **Implementation summary (this file).** Captures the reasoning behind each change so future refactors can track which pieces are safe to reuse in browsers versus Workers.

## Interface Verification

The exported client/server classes, transport contracts, and shared types remain unchanged. TypeScript still compiles against the original `Transport` interface, and the new transports implement that contract without extending or altering it. This preserves source compatibility for existing consumers.【F:src/shared/transport.ts†L1-L63】【F:src/server/index.ts†L1-L112】【F:src/client/index.ts†L1-L114】

## Follow-up Work

1. Publish conditional exports that separate Node-only transports (`stdio`, HTTP) from Fetch-based adapters so bundlers can tree-shake unused environments.
2. Implement a browser `postMessage` transport leveraging the same request queueing primitives as the Fetch adapter.
3. Extract the Worker helpers into a dedicated edge companion package once the API stabilises.

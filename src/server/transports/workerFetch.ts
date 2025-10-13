import { JSONRPCMessage, MessageExtraInfo, RequestId } from '../../types.js';
import { Transport, TransportSendOptions } from '../../shared/transport.js';

/**
 * Minimal representation of a Fetch-like Headers object that works in Cloudflare Workers.
 */
export interface HeadersLike {
    forEach(callback: (value: string, key: string) => void): void;
}

/**
 * A Fetch-like request shape that Cloudflare Workers provide.
 */
export interface WorkerRequestLike {
    method: string;
    headers: HeadersLike | Record<string, string | string[]>;
    text(): Promise<string>;
}

/**
 * A simplified Response object so callers can build a platform-specific response.
 */
export interface WorkerResponseLike {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface WorkerFetchTransportOptions {
    /**
     * Optional headers that will be merged into every response.
     */
    responseHeaders?: Record<string, string>;

    /**
     * How long to wait (in milliseconds) for handlers to emit a response before
     * returning an empty JSON array. Defaults to 0 (return immediately if there are
     * no pending request IDs).
     */
    responseTimeoutMs?: number;
}

interface ActiveExchange {
    expectedRequestIds: Set<RequestId>;
    messages: JSONRPCMessage[];
    resolve: (response: WorkerResponseLike) => void;
    reject: (error: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * Transport that maps Fetch-style requests to MCP JSON-RPC messages.
 *
 * Cloudflare Workers invoke `handleRequest` for each incoming HTTP request. The server
 * pushes JSON-RPC responses via the transport and they are packaged as a JSON array in
 * the returned `WorkerResponseLike`.
 */
export class WorkerFetchTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    sessionId?: string;
    setProtocolVersion?: (version: string) => void;

    private readonly responseHeaders: Record<string, string>;
    private readonly responseTimeoutMs?: number;
    private activeExchange?: ActiveExchange;
    private pendingMessages: JSONRPCMessage[] = [];

    constructor(options: WorkerFetchTransportOptions = {}) {
        this.responseHeaders = { 'content-type': 'application/json', ...options.responseHeaders };
        this.responseTimeoutMs = options.responseTimeoutMs;
    }

    async start(): Promise<void> {
        // The transport is event-driven; there is no persistent connection to open.
    }

    async close(): Promise<void> {
        this.activeExchange = undefined;
        this.pendingMessages = [];
        this.onclose?.();
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (!this.activeExchange) {
            this.pendingMessages.push(message);
            return;
        }

        this.activeExchange.messages.push(message);
        if (isResponseForExchange(message, options, this.activeExchange.expectedRequestIds)) {
            if (this.activeExchange.expectedRequestIds.size === 0) {
                this.flushActiveExchange();
            }
            return;
        }

        // Notifications (no ID) are delivered immediately when we already have an
        // active exchange waiting for responses.
        this.flushActiveExchange();
    }

    /**
     * Converts a Fetch-like request to JSON-RPC messages, forwarding them to the
     * attached server instance and returning all responses as a JSON payload.
     */
    async handleRequest(request: WorkerRequestLike): Promise<WorkerResponseLike> {
        const payloadText = await request.text();
        const incoming = parseMessages(payloadText);
        const expectedRequestIds = collectRequestIds(incoming);
        const extra: MessageExtraInfo = {
            requestInfo: { headers: normalizeHeaders(request.headers) }
        };

        return await new Promise<WorkerResponseLike>((resolve, reject) => {
            if (this.activeExchange) {
                reject(new Error('Cannot process multiple concurrent requests on WorkerFetchTransport'));
                return;
            }

            const messages = [...this.pendingMessages];
            this.pendingMessages = [];

            const exchange: ActiveExchange = {
                expectedRequestIds,
                messages,
                resolve: response => {
                    if (exchange.timeoutId) {
                        clearTimeout(exchange.timeoutId);
                    }
                    this.activeExchange = undefined;
                    resolve(response);
                },
                reject: error => {
                    if (exchange.timeoutId) {
                        clearTimeout(exchange.timeoutId);
                    }
                    this.activeExchange = undefined;
                    reject(error);
                }
            };

            if (this.responseTimeoutMs && expectedRequestIds.size > 0) {
                exchange.timeoutId = setTimeout(() => {
                    this.flushActiveExchange();
                }, this.responseTimeoutMs);
            }

            this.activeExchange = exchange;

            try {
                for (const message of incoming) {
                    this.onmessage?.(message, extra);
                }
            } catch (error) {
                this.activeExchange = undefined;
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            if (expectedRequestIds.size === 0) {
                this.flushActiveExchange();
            }
        });
    }

    private flushActiveExchange(): void {
        if (!this.activeExchange) {
            return;
        }

        const { messages, resolve } = this.activeExchange;
        const responseBody = JSON.stringify(messages.length === 1 ? messages[0] : messages);
        resolve({
            status: 200,
            headers: { ...this.responseHeaders },
            body: responseBody
        });
    }
}

function parseMessages(payloadText: string): JSONRPCMessage[] {
    if (!payloadText) {
        return [];
    }

    const parsed = JSON.parse(payloadText) as JSONRPCMessage | JSONRPCMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
}

function collectRequestIds(messages: JSONRPCMessage[]): Set<RequestId> {
    const ids = new Set<RequestId>();
    for (const message of messages) {
        if (typeof message === 'object' && message !== null && 'id' in message && message.id !== undefined) {
            ids.add(message.id as RequestId);
        }
    }
    return ids;
}

function isResponseForExchange(
    message: JSONRPCMessage,
    options: TransportSendOptions | undefined,
    expected: Set<RequestId>
): boolean {
    if (options?.relatedRequestId !== undefined) {
        expected.delete(options.relatedRequestId);
        return true;
    }

    if (typeof message === 'object' && message !== null && 'id' in message && message.id !== undefined) {
        expected.delete(message.id as RequestId);
        return true;
    }

    return false;
}

function normalizeHeaders(headers: HeadersLike | Record<string, string | string[]>): Record<string, string | string[]> {
    if (isHeadersLike(headers)) {
        const normalized: Record<string, string> = {};
        headers.forEach((value, key) => {
            normalized[key.toLowerCase()] = value;
        });
        return normalized;
    }

    const normalized: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
        normalized[key.toLowerCase()] = value;
    }
    return normalized;
}

function isHeadersLike(value: unknown): value is HeadersLike {
    return typeof value === 'object' && value !== null && 'forEach' in value && typeof (value as HeadersLike).forEach === 'function';
}

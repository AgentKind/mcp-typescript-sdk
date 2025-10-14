import { Transport } from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema, MessageExtraInfo, RequestInfo } from '../types.js';
import contentType from 'content-type';
import type { AuthInfo } from './auth/types.js';

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024; // 4MB in bytes

function generateSessionId(): string {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    // Simple UUID v4 polyfill for environments without Web Crypto
    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Configuration options for SSEServerTransport.
 */
export interface SSEServerTransportOptions {
    /**
     * List of allowed host header values for DNS rebinding protection.
     * If not specified, host validation is disabled.
     */
    allowedHosts?: string[];

    /**
     * List of allowed origin header values for DNS rebinding protection.
     * If not specified, origin validation is disabled.
     */
    allowedOrigins?: string[];

    /**
     * Enable DNS rebinding protection (requires allowedHosts and/or allowedOrigins to be configured).
     * Default is false for backwards compatibility.
     */
    enableDnsRebindingProtection?: boolean;
}

// Type for the response object (compatible with both Node ServerResponse and Fetch-style responses)
interface ResponseLike {
    writeHead(statusCode: number, headers?: Record<string, string>): ResponseLike;
    write(chunk: string): boolean | void;
    end(chunk?: string): void;
    on?(event: string, listener: (...args: any[]) => void): void;
}

// Type for the request object (compatible with both Node IncomingMessage and Fetch Request)
interface RequestLike {
    headers: Record<string, string | string[] | undefined> | Headers;
    auth?: AuthInfo;
    text?: () => Promise<string>;
    on?(event: string, listener: (...args: any[]) => void): void;
}

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 *
 * This transport uses Web APIs and is compatible with browsers, edge runtimes, and Node.js 18+.
 */
export class SSEServerTransport implements Transport {
    private _sseResponse?: ResponseLike;
    private _sessionId: string;
    private _options: SSEServerTransportOptions;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /**
     * Creates a new SSE server transport, which will direct the client to POST messages to the relative or absolute URL identified by `_endpoint`.
     */
    constructor(
        private _endpoint: string,
        private res: ResponseLike,
        options?: SSEServerTransportOptions
    ) {
        this._sessionId = generateSessionId();
        this._options = options || { enableDnsRebindingProtection: false };
    }

    /**
     * Validates request headers for DNS rebinding protection.
     * @returns Error message if validation fails, undefined if validation passes.
     */
    private validateRequestHeaders(headers: Record<string, string | string[] | undefined> | Headers): string | undefined {
        // Skip validation if protection is not enabled
        if (!this._options.enableDnsRebindingProtection) {
            return undefined;
        }

        const getHeader = (name: string): string | undefined => {
            if (headers instanceof Headers) {
                return headers.get(name) || undefined;
            }
            const value = headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
        };

        // Validate Host header if allowedHosts is configured
        if (this._options.allowedHosts && this._options.allowedHosts.length > 0) {
            const hostHeader = getHeader('host');
            if (!hostHeader || !this._options.allowedHosts.includes(hostHeader)) {
                return `Invalid Host header: ${hostHeader}`;
            }
        }

        // Validate Origin header if allowedOrigins is configured
        if (this._options.allowedOrigins && this._options.allowedOrigins.length > 0) {
            const originHeader = getHeader('origin');
            if (!originHeader || !this._options.allowedOrigins.includes(originHeader)) {
                return `Invalid Origin header: ${originHeader}`;
            }
        }

        return undefined;
    }

    /**
     * Handles the initial SSE connection request.
     *
     * This should be called when a GET request is made to establish the SSE stream.
     */
    async start(): Promise<void> {
        if (this._sseResponse) {
            throw new Error('SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.');
        }

        this.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });

        // Send the endpoint event
        // Use a dummy base URL because this._endpoint is relative.
        // This allows using URL/URLSearchParams for robust parameter handling.
        const dummyBase = 'http://localhost'; // Any valid base works
        const endpointUrl = new URL(this._endpoint, dummyBase);
        endpointUrl.searchParams.set('sessionId', this._sessionId);

        // Reconstruct the relative URL string (pathname + search + hash)
        const relativeUrlWithSession = endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;

        this.res.write(`event: endpoint\ndata: ${relativeUrlWithSession}\n\n`);

        this._sseResponse = this.res;
        
        // Set up close handler if available
        if (this.res.on) {
            this.res.on('close', () => {
                this._sseResponse = undefined;
                this.onclose?.();
            });
        }
    }

    /**
     * Handles incoming POST messages.
     *
     * This should be called when a POST request is made to send a message to the server.
     */
    async handlePostMessage(req: RequestLike, res: ResponseLike, parsedBody?: unknown): Promise<void> {
        if (!this._sseResponse) {
            const message = 'SSE connection not established';
            res.writeHead(500).end(message);
            throw new Error(message);
        }

        // Validate request headers for DNS rebinding protection
        const validationError = this.validateRequestHeaders(req.headers);
        if (validationError) {
            res.writeHead(403).end(validationError);
            this.onerror?.(new Error(validationError));
            return;
        }

        const authInfo: AuthInfo | undefined = req.auth;
        
        // Convert headers to plain object
        const requestInfo: RequestInfo = {
            headers: req.headers instanceof Headers
                ? Object.fromEntries(req.headers.entries())
                : req.headers as Record<string, string | string[] | undefined>
        };

        let body: string | unknown;
        try {
            const getHeader = (name: string): string | undefined => {
                if (req.headers instanceof Headers) {
                    return req.headers.get(name) || undefined;
                }
                const value = req.headers[name.toLowerCase()];
                return Array.isArray(value) ? value[0] : value;
            };

            const contentTypeHeader = getHeader('content-type') ?? '';
            const ct = contentType.parse(contentTypeHeader);
            if (ct.type !== 'application/json') {
                throw new Error(`Unsupported content-type: ${ct.type}`);
            }

            if (parsedBody !== undefined) {
                body = parsedBody;
            } else if (req.text) {
                // Fetch-style Request
                const bodyText = await req.text();
                if (bodyText.length > MAXIMUM_MESSAGE_SIZE) {
                    throw new Error('Request body too large');
                }
                body = bodyText;
            } else if (req.on) {
                // Node-style IncomingMessage
                const chunks: Buffer[] = [];
                let totalLength = 0;
                
                await new Promise<void>((resolve, reject) => {
                    req.on!('data', (chunk: Buffer) => {
                        totalLength += chunk.length;
                        if (totalLength > MAXIMUM_MESSAGE_SIZE) {
                            reject(new Error('Request body too large'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    req.on!('end', () => resolve());
                    req.on!('error', reject);
                });
                
                const encoding = ct.parameters.charset ?? 'utf-8';
                body = Buffer.concat(chunks).toString(encoding as BufferEncoding);
            } else {
                throw new Error('Unable to read request body');
            }
        } catch (error) {
            res.writeHead(400).end(String(error));
            this.onerror?.(error as Error);
            return;
        }

        try {
            await this.handleMessage(typeof body === 'string' ? JSON.parse(body) : body, { requestInfo, authInfo });
        } catch {
            res.writeHead(400).end(`Invalid message: ${body}`);
            return;
        }

        res.writeHead(202).end('Accepted');
    }

    /**
     * Handle a client message, regardless of how it arrived. This can be used to inform the server of messages that arrive via a means different than HTTP POST.
     */
    async handleMessage(message: unknown, extra?: MessageExtraInfo): Promise<void> {
        let parsedMessage: JSONRPCMessage;
        try {
            parsedMessage = JSONRPCMessageSchema.parse(message);
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }

        this.onmessage?.(parsedMessage, extra);
    }

    async close(): Promise<void> {
        this._sseResponse?.end();
        this._sseResponse = undefined;
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._sseResponse) {
            throw new Error('Not connected');
        }

        this._sseResponse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }

    /**
     * Returns the session ID for this transport.
     *
     * This can be used to route incoming POST requests.
     */
    get sessionId(): string {
        return this._sessionId;
    }
}

/**
 * Adapter: Creates a Fetch-compatible SSE session using SSEServerTransport
 * Includes batching and keep-alive optimizations for Cloudflare Workers
 */
export interface SSESessionAdapter {
    transport: SSEServerTransport;
    response: Response;
    dispose(): void;
}

export function createSSESessionAdapter(
    endpoint: string,
    options: { signal?: AbortSignal; transportOptions?: SSEServerTransportOptions } = {}
): SSESessionAdapter {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    let disposed = false;
    const closeListeners = new Set<() => void>();
    
    // Batching support - collect chunks and flush periodically
    const pendingChunks: Uint8Array[] = [];
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let needsFlush = false;
    let pendingClose = false;

    const finish = () => {
        if (disposed) return;
        disposed = true;

        // Clean up timers
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        if (flushTimer) {
            clearInterval(flushTimer);
            flushTimer = null;
        }

        // Close stream
        if (streamController) {
            try {
                streamController.close();
            } catch {
                // Already closed
            }
            streamController = null;
        }

        // Notify listeners
        closeListeners.forEach(listener => listener());
        closeListeners.clear();
    };

    const flushQueue = () => {
        if (!streamController || disposed) {
            return;
        }

        if (!needsFlush && (!pendingClose || pendingChunks.length === 0)) {
            return;
        }

        needsFlush = false;

        // Flush all pending chunks
        while (pendingChunks.length > 0) {
            const chunk = pendingChunks.shift();
            if (chunk) {
                streamController.enqueue(chunk);
            }
        }

        // If close was pending and queue is empty, close now
        if (pendingClose && pendingChunks.length === 0) {
            finish();
        }
    };

    // Create the ReadableStream with batching and keep-alive
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;

            // Set up periodic flush (every 5ms to batch writes)
            flushTimer = setInterval(flushQueue, 5);

            // Send keep-alive comments every 15 seconds
            keepAliveTimer = setInterval(() => {
                if (!disposed && streamController) {
                    try {
                        streamController.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
                    } catch {
                        finish();
                    }
                }
            }, 15000);

            // Flush any initial writes
            needsFlush = true;
            flushQueue();
        },
        cancel() {
            finish();
        }
    });

    // Handle client abort signal
    if (options.signal) {
        options.signal.addEventListener('abort', finish, { once: true });
    }

    // Create adapter that implements ResponseLike interface
    const adapter: ResponseLike = {
        writeHead: (statusCode: number, headers?: Record<string, string>) => {
            // Headers already set on Response
            return adapter;
        },
        write: (chunk: string) => {
            if (disposed) {
                return false;
            }

            // Add to pending chunks for batched flush
            pendingChunks.push(encoder.encode(chunk));
            needsFlush = true;
            return true;
        },
        end: (chunk?: string) => {
            if (disposed) return;

            if (chunk) {
                pendingChunks.push(encoder.encode(chunk));
            }

            pendingClose = true;
            needsFlush = true;
        },
        on: (event: string, listener: (...args: any[]) => void) => {
            if (event === 'close') {
                if (disposed) {
                    // Already closed, call immediately
                    listener();
                } else {
                    closeListeners.add(listener);
                }
            }
        }
    };

    // Create SSEServerTransport using the adapter
    const transport = new SSEServerTransport(endpoint, adapter, options.transportOptions);

    // Create Fetch Response with SSE headers
    const response = new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        }
    });

    return {
        transport,
        response,
        dispose: finish
    };
}

/**
 * Handles POST requests for SSE transport created via adapter
 * Note: The response goes back through the SSE stream, not the POST response
 */
export async function handleSSEAdapterPost(
    request: Request,
    transport: SSEServerTransport,
    options: { authInfo?: AuthInfo } = {}
): Promise<Response> {
    const headers = request.headers;
    
    // Validate content-type
    const ct = headers.get('content-type');
    if (!ct || !ct.includes('application/json')) {
        return new Response('Content-Type must be application/json', { status: 415 });
    }

    // Get request body
    const bodyText = await request.text();
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(bodyText);
    } catch {
        return new Response('Invalid JSON', { status: 400 });
    }

    // Create extra info for the message
    const extra: MessageExtraInfo = {
        requestInfo: { headers: Object.fromEntries(headers.entries()) },
        authInfo: options.authInfo
    };

    // Handle the message - response will be sent via SSE stream
    try {
        await transport.handleMessage(parsedBody, extra);
        // POST requests for SSE always return 202 Accepted
        // The actual response goes through the SSE stream
        return new Response('Accepted', { status: 202 });
    } catch (error) {
        return new Response('Invalid message: ' + String(error), { status: 400 });
    }
}

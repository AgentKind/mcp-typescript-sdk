import { Transport } from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema, MessageExtraInfo } from '../types.js';
import type { AuthInfo } from '../server/auth/types.js';
import contentType from 'content-type';

const DEFAULT_SSE_HEADERS: Record<string, string> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
};

type CloseHandler = () => void;

interface FetchSSEConnection {
    setHeaders(headers: Record<string, string>): void | Promise<void>;
    write(data: string): void | Promise<void>;
    end(data?: string): void | Promise<void>;
    onClose(handler: CloseHandler): void;
}

function generateSessionId(): string {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    // Simple UUID v4 polyfill for environments without Web Crypto.
    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function createStreamConnection(signal?: AbortSignal): {
    adapter: FetchSSEConnection;
    response: Response;
    dispose(): void;
} {
    const headers = new Headers(DEFAULT_SSE_HEADERS);
    const encoder = new TextEncoder();
    const closeListeners = new Set<CloseHandler>();
    const pendingChunks: Uint8Array[] = [];

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let abortHandler: (() => void) | null = null;
    let needsFlush = false;
    let pendingClose = false;

    const finish = (action: 'close' | 'error' = 'close', error?: Error) => {
        if (closed) {
            return;
        }
        closed = true;

        if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
            abortHandler = null;
        }

        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }

        if (flushTimer) {
            clearInterval(flushTimer);
            flushTimer = null;
        }

        if (controller) {
            try {
                if (action === 'error') {
                    controller.error(error ?? new Error('Client disconnected'));
                } else {
                    controller.close();
                }
            } catch {
                // Ignore attempts to close an already-closed controller.
            }
        }

        closeListeners.forEach(listener => listener());
        closeListeners.clear();
    };

    const stream = new ReadableStream<Uint8Array>({
        start(startController) {
            controller = startController;

            if (signal) {
                abortHandler = () => finish('error', new Error('Client disconnected'));
                signal.addEventListener('abort', abortHandler, { once: true });
            }

            const flushQueue = () => {
                if (!controller || closed) {
                    return;
                }

                if (!needsFlush && (!pendingClose || pendingChunks.length === 0)) {
                    return;
                }

                needsFlush = false;

                while (pendingChunks.length > 0) {
                    controller.enqueue(pendingChunks.shift()!);
                }

                if (pendingClose && pendingChunks.length === 0) {
                    finish();
                }
            };

            flushTimer = setInterval(flushQueue, 5);

            const sendKeepAlive = () => {
                if (closed || !controller) {
                    return;
                }

                controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
            };

            keepAliveTimer = setInterval(sendKeepAlive, 15000);

            needsFlush = true;
            flushQueue();
        },
        cancel() {
            finish();
        }
    });

    const response = new Response(stream, { headers });

    const adapter: FetchSSEConnection = {
        async setHeaders(custom: Record<string, string>): Promise<void> {
            for (const [key, value] of Object.entries(custom)) {
                headers.set(key, value);
            }
        },
        async write(data: string): Promise<void> {
            if (closed) {
                return;
            }

            pendingChunks.push(encoder.encode(data));
            needsFlush = true;
        },
        async end(data?: string): Promise<void> {
            if (closed) {
                return;
            }

            if (data) {
                pendingChunks.push(encoder.encode(data));
            }

            pendingClose = true;
            needsFlush = true;
        },
        onClose(handler: CloseHandler): void {
            if (closed) {
                handler();
                return;
            }

            closeListeners.add(handler);
        }
    };

    return {
        adapter,
        response,
        dispose(): void {
            finish();
        }
    };
}

export interface FetchSSEServerTransportOptions {
    allowedHosts?: string[];
    allowedOrigins?: string[];
    enableDnsRebindingProtection?: boolean;
}

export class FetchSSEServerTransport implements Transport {
    private readonly connection: FetchSSEConnection;
    private readonly options: FetchSSEServerTransportOptions;
    private readonly _sessionId: string;
    private _started = false;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(
        private readonly endpoint: string,
        connection: FetchSSEConnection,
        options: FetchSSEServerTransportOptions = {}
    ) {
        this.connection = connection;
        this.options = { enableDnsRebindingProtection: false, ...options };
        this._sessionId = generateSessionId();
    }

    get sessionId(): string {
        return this._sessionId;
    }

    get started(): boolean {
        return this._started;
    }

    validateRequestHeaders(headers: Headers): string | undefined {
        if (!this.options.enableDnsRebindingProtection) {
            return undefined;
        }

        if (this.options.allowedHosts && this.options.allowedHosts.length > 0) {
            const hostHeader = headers.get('host');
            if (!hostHeader || !this.options.allowedHosts.includes(hostHeader)) {
                return `Invalid Host header: ${hostHeader}`;
            }
        }

        if (this.options.allowedOrigins && this.options.allowedOrigins.length > 0) {
            const originHeader = headers.get('origin');
            if (!originHeader || !this.options.allowedOrigins.includes(originHeader)) {
                return `Invalid Origin header: ${originHeader}`;
            }
        }

        return undefined;
    }

    async start(): Promise<void> {
        if (this._started) {
            throw new Error(
                'FetchSSEServerTransport already started! If using Server class, note that connect() calls start() automatically.'
            );
        }

        this._started = true;

        await this.connection.setHeaders(DEFAULT_SSE_HEADERS);

        const dummyBase = 'http://localhost';
        const endpointUrl = new URL(this.endpoint, dummyBase);
        endpointUrl.searchParams.set('sessionId', this._sessionId);
        const relativeUrlWithSession = endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;

        await this.connection.write(`event: endpoint\ndata: ${relativeUrlWithSession}\n\n`);

        this.connection.onClose(() => {
            this._started = false;
            this.onclose?.();
        });
    }

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
        if (!this._started) {
            return;
        }

        await this.connection.end();
        this._started = false;
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._started) {
            throw new Error('Not connected');
        }

        await this.connection.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }
}

export interface CreateFetchSSESessionOptions {
    transportOptions?: FetchSSEServerTransportOptions;
    signal?: AbortSignal;
}

export interface FetchSSESession {
    transport: FetchSSEServerTransport;
    response: Response;
    dispose(): void;
}

export async function createFetchSSESession(
    endpoint: string,
    options: CreateFetchSSESessionOptions = {}
): Promise<FetchSSESession> {
    const connection = createStreamConnection(options.signal);
    const transport = new FetchSSEServerTransport(endpoint, connection.adapter, options.transportOptions);

    return {
        transport,
        response: connection.response,
        dispose: connection.dispose
    };
}

export interface HandleFetchSSEPostOptions {
    authInfo?: AuthInfo;
}

export async function handleFetchSSEPost(
    request: Request,
    transport: FetchSSEServerTransport,
    options: HandleFetchSSEPostOptions = {}
): Promise<Response> {
    if (!transport.started) {
        return new Response('SSE connection not established', { status: 500 });
    }

    const validationError = transport.validateRequestHeaders(request.headers);
    if (validationError) {
        transport.onerror?.(new Error(validationError));
        return new Response(validationError, { status: 403 });
    }

    let mediaType: string;
    try {
        mediaType = contentType.parse(request.headers.get('content-type') ?? '').type;
    } catch (error) {
        return new Response(String(error), { status: 400 });
    }

    if (mediaType !== 'application/json') {
        return new Response(`Unsupported content-type: ${mediaType}`, { status: 400 });
    }

    const bodyText = await request.text();
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(bodyText);
    } catch {
        return new Response(`Invalid message: ${bodyText}`, { status: 400 });
    }

    const extra: MessageExtraInfo = {
        requestInfo: { headers: headersToObject(request.headers) },
        authInfo: options.authInfo
    };

    try {
        await transport.handleMessage(parsedBody, extra);
    } catch {
        return new Response(`Invalid message: ${bodyText}`, { status: 400 });
    }

    return new Response('Accepted', { status: 202 });
}

function headersToObject(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key.toLowerCase()] = value;
    });
    return result;
}

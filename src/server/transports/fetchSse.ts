import {
    SSEServerTransport,
    type SSEServerTransportOptions,
    type SSEConnectionAdapter
} from '../sse.js';
import type { AuthInfo } from '../auth/types.js';
import type { MessageExtraInfo } from '../../types.js';
import contentType from 'content-type';

interface FetchSseConnectionOptions {
    signal?: AbortSignal;
}

class FetchSseConnection implements SSEConnectionAdapter {
    private readonly encoder = new TextEncoder();
    private readonly stream: ReadableStream<Uint8Array>;
    private controller?: ReadableStreamDefaultController<Uint8Array>;
    private abortHandler?: () => void;
    private readonly signal?: AbortSignal;
    private closed = false;
    private closeListeners: Array<() => void> = [];

    public readonly response: Response;

    constructor(options: FetchSseConnectionOptions = {}) {
        this.signal = options.signal;
        this.stream = new ReadableStream<Uint8Array>({
            start: controller => {
                this.controller = controller;
                if (this.signal) {
                    const onAbort = () => {
                        if (this.closed) {
                            return;
                        }
                        this.closed = true;
                        controller.error(new Error('Client disconnected'));
                        this.removeAbortListener();
                        this.closeListeners.forEach(listener => listener());
                    };
                    this.signal.addEventListener('abort', onAbort, { once: true });
                    this.abortHandler = onAbort;
                }
            },
            cancel: () => {
                if (this.closed) {
                    return;
                }
                this.closed = true;
                this.removeAbortListener();
                this.closeListeners.forEach(listener => listener());
            }
        });
        this.response = new Response(this.stream, {
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive'
            }
        });
    }

    async setHeaders(headers: Record<string, string>): Promise<void> {
        // Headers were initialized in the constructor. Merge any custom headers here.
        for (const [key, value] of Object.entries(headers)) {
            this.response.headers.set(key, value);
        }
    }

    async write(data: string): Promise<void> {
        if (this.closed) {
            return;
        }

        this.controller?.enqueue(this.encoder.encode(data));
    }

    async end(data?: string): Promise<void> {
        if (this.closed) {
            return;
        }

        if (data) {
            await this.write(data);
        }

        this.closed = true;
        this.removeAbortListener();
        this.controller?.close();
        this.closeListeners.forEach(listener => listener());
    }

    onClose(handler: () => void): void {
        if (this.closed) {
            handler();
            return;
        }

        this.closeListeners.push(handler);
    }

    removeAbortListener(): void {
        if (this.signal && this.abortHandler) {
            this.signal.removeEventListener('abort', this.abortHandler);
        }
    }
}

export interface CreateFetchSSESessionOptions {
    transportOptions?: SSEServerTransportOptions;
    signal?: AbortSignal;
}

export interface FetchSSESession {
    transport: SSEServerTransport;
    response: Response;
}

export async function createFetchSSESession(
    endpoint: string,
    options: CreateFetchSSESessionOptions = {}
): Promise<FetchSSESession> {
    const connection = new FetchSseConnection({ signal: options.signal });
    const transport = new SSEServerTransport(endpoint, connection, options.transportOptions);

    try {
        await transport.start();
    } catch (error) {
        connection.removeAbortListener();
        await connection.end();
        throw error;
    }

    return {
        transport,
        response: connection.response
    };
}

export interface HandleFetchSSEPostOptions {
    authInfo?: AuthInfo;
}

export async function handleFetchSSEPost(
    request: Request,
    transport: SSEServerTransport,
    options: HandleFetchSSEPostOptions = {}
): Promise<Response> {
    let mediaType: string;
    try {
        mediaType = contentType.parse(request.headers.get('content-type') ?? '').type;
    } catch (error) {
        return new Response(String(error), { status: 400 });
    }

    if (mediaType !== 'application/json') {
        return new Response(`Unsupported content-type: ${mediaType}`, { status: 400 });
    }

    let parsedBody: unknown;
    const bodyText = await request.text();
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
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
        record[key.toLowerCase()] = value;
    });
    return record;
}

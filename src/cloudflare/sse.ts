import {
    SSEServerTransport,
    type SSEServerTransportOptions,
    type SSEConnectionAdapter
} from '../server/sse.js';
import type { AuthInfo } from '../server/auth/types.js';
import type { MessageExtraInfo } from '../types.js';
import contentType from 'content-type';

const DEFAULT_SSE_HEADERS = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
};

interface StreamConnection {
    adapter: SSEConnectionAdapter;
    response: Response;
    dispose(): void;
}

function createStreamConnection(signal?: AbortSignal): StreamConnection {
    const headers = new Headers(DEFAULT_SSE_HEADERS);
    const encoder = new TextEncoder();
    const closeListeners = new Set<() => void>();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    let abortHandler: (() => void) | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    const pendingChunks: Uint8Array[] = [];
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
                if (closed) {
                    return;
                }
                if (!controller) {
                    return;
                }
                controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
            };

            keepAliveTimer = setInterval(sendKeepAlive, 15000);

            // Ensure any data queued before start is flushed immediately.
            needsFlush = true;
            flushQueue();
        },
        cancel() {
            finish();
        }
    });

    const response = new Response(stream, { headers });

    const adapter: SSEConnectionAdapter = {
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
        onClose(handler: () => void): void {
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

export interface CreateFetchSSESessionOptions {
    transportOptions?: SSEServerTransportOptions;
    signal?: AbortSignal;
}

export interface FetchSSESession {
    transport: SSEServerTransport;
    response: Response;
    dispose(): void;
}

export async function createFetchSSESession(
    endpoint: string,
    options: CreateFetchSSESessionOptions = {}
): Promise<FetchSSESession> {
    const connection = createStreamConnection(options.signal);
    const transport = new SSEServerTransport(endpoint, connection.adapter, options.transportOptions);

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

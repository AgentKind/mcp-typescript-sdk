import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transport } from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema, MessageExtraInfo, RequestInfo } from '../types.js';
import contentType from 'content-type';
import { AuthInfo } from './auth/types.js';

const MAXIMUM_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface SSEConnectionAdapter {
    setHeaders(headers: Record<string, string>): void | Promise<void>;
    write(data: string): void | Promise<void>;
    end(data?: string): void | Promise<void>;
    onClose(handler: () => void): void;
}

class NodeResponseConnection implements SSEConnectionAdapter {
    constructor(private readonly res: ServerResponse) {}

    setHeaders(headers: Record<string, string>): void {
        this.res.writeHead(200, headers);
    }

    write(data: string): void {
        this.res.write(data);
    }

    end(data?: string): void {
        this.res.end(data);
    }

    onClose(handler: () => void): void {
        this.res.on('close', handler);
    }
}

function resolveConnection(res: ServerResponse | SSEConnectionAdapter): SSEConnectionAdapter {
    if (typeof (res as ServerResponse).writeHead === 'function') {
        return new NodeResponseConnection(res as ServerResponse);
    }

    return res as SSEConnectionAdapter;
}

function generateSessionId(): string {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    // Fall back to a simple UUID v4 polyfill if Web Crypto is unavailable. This code path
    // is retained for backwards compatibility with older Node versions.
    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function readIncomingMessage(req: IncomingMessage, encoding: BufferEncoding): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalLength = 0;

        req.on('data', chunk => {
            const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalLength += bufferChunk.byteLength;

            if (totalLength > MAXIMUM_MESSAGE_BYTES) {
                reject(new Error('Request body exceeds maximum size of 4mb'));
                req.destroy();
                return;
            }

            chunks.push(bufferChunk);
        });

        req.on('end', () => {
            resolve(Buffer.concat(chunks).toString(encoding));
        });

        req.on('error', reject);
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

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 *
 * This transport now supports any runtime that provides an `SSEConnectionAdapter` implementation.
 */
export class SSEServerTransport implements Transport {
    private readonly _connection: SSEConnectionAdapter;
    private _sessionId: string;
    private _options: SSEServerTransportOptions;
    private _started = false;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /**
     * Creates a new SSE server transport, which will direct the client to POST messages to the relative or absolute URL identified by `_endpoint`.
     */
    constructor(
        private _endpoint: string,
        res: ServerResponse | SSEConnectionAdapter,
        options?: SSEServerTransportOptions
    ) {
        this._sessionId = generateSessionId();
        this._options = options || { enableDnsRebindingProtection: false };
        this._connection = resolveConnection(res);
    }

    /**
     * Validates request headers for DNS rebinding protection.
     * @returns Error message if validation fails, undefined if validation passes.
     */
    private validateRequestHeaders(req: IncomingMessage): string | undefined {
        // Skip validation if protection is not enabled
        if (!this._options.enableDnsRebindingProtection) {
            return undefined;
        }

        // Validate Host header if allowedHosts is configured
        if (this._options.allowedHosts && this._options.allowedHosts.length > 0) {
            const hostHeader = req.headers.host;
            if (!hostHeader || !this._options.allowedHosts.includes(hostHeader)) {
                return `Invalid Host header: ${hostHeader}`;
            }
        }

        // Validate Origin header if allowedOrigins is configured
        if (this._options.allowedOrigins && this._options.allowedOrigins.length > 0) {
            const originHeader = req.headers.origin;
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
        if (this._started) {
            throw new Error('SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.');
        }

        this._started = true;

        await this._connection.setHeaders({
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

        await this._connection.write(`event: endpoint\ndata: ${relativeUrlWithSession}\n\n`);

        this._connection.onClose(() => {
            this.onclose?.();
        });
    }

    /**
     * Handles incoming POST messages.
     *
     * This should be called when a POST request is made to send a message to the server.
     */
    async handlePostMessage(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        if (!this._started) {
            const message = 'SSE connection not established';
            res.writeHead(500).end(message);
            throw new Error(message);
        }

        // Validate request headers for DNS rebinding protection
        const validationError = this.validateRequestHeaders(req);
        if (validationError) {
            res.writeHead(403).end(validationError);
            this.onerror?.(new Error(validationError));
            return;
        }

        const authInfo: AuthInfo | undefined = req.auth;
        const requestInfo: RequestInfo = { headers: req.headers };

        let body: string | unknown;
        try {
            const ct = contentType.parse(req.headers['content-type'] ?? '');
            if (ct.type !== 'application/json') {
                throw new Error(`Unsupported content-type: ${ct.type}`);
            }

            body =
                parsedBody ??
                (await readIncomingMessage(req, (ct.parameters.charset ?? 'utf-8') as BufferEncoding));
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
        if (!this._started) {
            return;
        }

        await this._connection.end();
        this._started = false;
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._started) {
            throw new Error('Not connected');
        }

        await this._connection.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
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

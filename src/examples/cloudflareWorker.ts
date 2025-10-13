import { McpServer } from '../server/mcp.js';
import {
    createFetchSSESession,
    handleFetchSSEPost
} from '../cloudflare/index.js';
import type { SSEServerTransport } from '../server/sse.js';
import { z } from 'zod';

const server = new McpServer({
    name: 'cf-worker-demo',
    version: '0.1.0'
});

const sessions = new Map<string, SSEServerTransport>();

server.registerTool(
    'echo',
    {
        title: 'Echo Tool',
        description: 'Echo back the provided message',
        inputSchema: { text: z.string() },
        outputSchema: { text: z.string() }
    },
    async ({ text }) => ({
        content: [
            { type: 'text', text }
        ],
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

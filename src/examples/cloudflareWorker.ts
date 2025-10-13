import { McpServer } from '../server/mcp.js';
import { WorkerFetchTransport } from '../server/transports/index.js';
import { z } from 'zod';

const server = new McpServer({
    name: 'cf-worker-demo',
    version: '0.1.0'
});

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
                    headers: {
                        'content-type': 'application/json'
                    }
                }
            );
        }
    }
};

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { URL } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { jest } from '@jest/globals';
import { Client } from '../client/index.js';
import { SSEClientTransport } from '../client/sse.js';

jest.setTimeout(120_000);

async function waitForWranglerReady(proc: ChildProcess, logs: string[]): Promise<void> {
    return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for wrangler dev to be ready. Logs:\n${logs.join('')}`));
        }, 45_000);

        const handleData = (chunk: Buffer) => {
            const text = chunk.toString();
            logs.push(text);
            if (text.includes('Ready on')) {
                cleanup();
                resolve();
            }
        };

        const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(new Error(`wrangler dev exited before becoming ready (code=${code}, signal=${signal}). Logs:\n${logs.join('')}`));
        };

        const cleanup = () => {
            clearTimeout(timeout);
            proc.stdout?.off('data', handleData);
            proc.stderr?.off('data', handleData);
            proc.off('exit', handleExit);
        };

        proc.stdout?.on('data', handleData);
        proc.stderr?.on('data', handleData);
        proc.once('exit', handleExit);
    });
}

async function getAvailablePort(): Promise<number> {
    const server = createServer();
    return await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as AddressInfo | null;
            if (!address) {
                server.close(() => reject(new Error('Failed to allocate test port')));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });
}

describe('Cloudflare Worker MCP integration with SSE Adapter', () => {
    test('client can list and call tools through wrangler dev using adapter', async () => {
        const wranglerBin = process.platform === 'win32'
            ? path.resolve(process.cwd(), 'node_modules/.bin/wrangler.cmd')
            : path.resolve(process.cwd(), 'node_modules/.bin/wrangler');
        const projectRoot = process.cwd();
        const port = await getAvailablePort();

        const logs: string[] = [];
        const wrangler = spawn(
            process.execPath,
            [
                wranglerBin,
                'dev',
                'src/examples/cloudflareWorkerAdapter.ts',
                '--local',
                '--compatibility-date=2024-09-01',
                `--port=${port}`,
                '--inspector-port=0'
            ],
            {
                cwd: projectRoot,
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );

        try {
            await waitForWranglerReady(wrangler, logs);

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
            await client.connect(transport);

            const toolsList = await client.listTools();
            expect(toolsList.tools).toHaveLength(1);
            expect(toolsList.tools[0].name).toBe('echo');

            const callResult = await client.callTool({
                name: 'echo',
                arguments: { text: 'Hello from adapter test!' }
            });

            expect(callResult.content).toHaveLength(1);
            expect((callResult.content as any)[0]).toEqual({
                type: 'text',
                text: 'Hello from adapter test!'
            });

            await client.close();
        } finally {
            wrangler.kill('SIGTERM');

            const [exitCode] = await once(wrangler, 'exit');
            if (exitCode !== 0 && exitCode !== null) {
                console.error('Wrangler dev failed. Logs:');
                console.error(logs.join(''));
            }
        }
    });
});


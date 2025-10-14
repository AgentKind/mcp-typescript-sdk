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

describe('Cloudflare Worker MCP integration', () => {
    test('client can list and call tools through wrangler dev', async () => {
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
                'src/examples/cloudflareWorker.ts',
                '--local',
                '--compatibility-date=2024-09-01',
                `--port=${port}`,
                '--inspector-port=0'
            ],
            {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    BROWSER: 'none',
                    WRANGLER_SEND_ANALYTICS: 'false',
                    WRANGLER_TELEMETRY: 'false'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );

        let client: Client | undefined;

        try {
            await waitForWranglerReady(wrangler, logs);

            client = new Client({ name: 'wrangler-test-client', version: '0.0.1' });
            const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));

            await client.connect(transport);

            const tools = await client.listTools();
            expect(tools.tools.map(tool => tool.name)).toContain('echo');

            const message = 'Hello from wrangler integration test';
            const result = await client.callTool({
                name: 'echo',
                arguments: { text: message }
            });

            expect(result.content).toEqual([
                {
                    type: 'text',
                    text: message
                }
            ]);
            expect(result.structuredContent).toEqual({ text: message });
        } catch (error) {
            const details = logs.join('');
            const failure = new Error(
                `Cloudflare Worker test failed: ${error instanceof Error ? error.message : String(error)}\nLogs:\n${details}`
            );
            if (error instanceof Error) {
                (failure as Error & { cause?: unknown }).cause = error;
            }
            throw failure;
        } finally {
            if (client) {
                await client.close().catch(() => undefined);
                client = undefined;
            }
            if (wrangler.exitCode === null && wrangler.signalCode === null) {
                if (!wrangler.killed) {
                    wrangler.kill('SIGINT');
                }
                await once(wrangler, 'exit');
            }
        }
    });
});

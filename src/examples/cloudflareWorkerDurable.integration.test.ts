import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { URL } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { jest } from '@jest/globals';
import { Client } from '../client/index.js';
import { SSEClientTransport } from '../client/sse.js';
import { StreamableHTTPClientTransport } from '../client/streamableHttp.js';

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

async function getTimingStats(port: number): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${port}/timing-stats`);
    return await response.json();
}

describe('Durable Object Universal Cloudflare Worker Performance', () => {
    let wrangler: ChildProcess;
    let port: number;
    let logs: string[];

    beforeAll(async () => {
        const wranglerBin = process.platform === 'win32'
            ? path.resolve(process.cwd(), 'node_modules/.bin/wrangler.cmd')
            : path.resolve(process.cwd(), 'node_modules/.bin/wrangler');
        const projectRoot = process.cwd();
        port = await getAvailablePort();

        logs = [];
        wrangler = spawn(
            process.execPath,
            [
                wranglerBin,
                'dev',
                'src/examples/cloudflareWorkerDurableUniversal.ts',
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

        await waitForWranglerReady(wrangler, logs);
        
        // Wait a bit for Durable Objects to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
    });

    afterAll(async () => {
        if (wrangler) {
            wrangler.kill('SIGTERM');
            const [exitCode] = await once(wrangler, 'exit');
            if (exitCode !== 0 && exitCode !== null) {
                console.error('Wrangler dev failed. Logs:');
                console.error(logs.join(''));
            }
        }
    });

    test('StreamableHTTP client can connect with Durable Object session management', async () => {
        const client = new Client(
            {
                name: 'test-durable-streamable-client',
                version: '1.0.0'
            },
            {
                capabilities: {}
            }
        );

        console.log('🚀 Starting StreamableHTTP client test...');

        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        await client.connect(transport);

        console.log('📋 Listing tools...');
        const toolsList = await client.listTools();
        expect(toolsList.tools).toHaveLength(2); // echo + timing-stats
        expect(toolsList.tools.map(t => t.name)).toContain('echo');
        expect(toolsList.tools.map(t => t.name)).toContain('timing-stats');

        console.log('🔧 Calling echo tool...');
        const echoResult = await client.callTool({
            name: 'echo',
            arguments: { text: 'Hello from Durable Objects!' }
        });

        expect(echoResult.content).toHaveLength(1);
        expect((echoResult.content as any)[0]).toEqual({
            type: 'text',
            text: 'Hello from Durable Objects!'
        });

        console.log('📊 Getting timing stats...');
        const timingResult = await client.callTool({
            name: 'timing-stats',
            arguments: {}
        });

        await client.close();

        // Get final timing stats from the monitoring endpoint
        const finalStats = await getTimingStats(port);
        console.log('⏱️  Final Durable Object Performance Stats:', JSON.stringify(finalStats, null, 2));

        // Verify we have timing data
        expect(finalStats.timingStats).toBeDefined();
        expect(finalStats.timingStats.total).toBeGreaterThan(0);
        
        // Check that we have both client-side and server-side measurements
        const recent = finalStats.timingStats.recent || [];
        const hasCreateSession = recent.some((stat: any) => stat.operation.includes('createSession'));
        
        if (hasCreateSession) {
            console.log('✅ Successfully recorded Durable Object session operations');
        }
    });

    test('SSE client performance comparison', async () => {
        const client = new Client(
            {
                name: 'test-sse-performance-client',
                version: '1.0.0'
            },
            {
                capabilities: {}
            }
        );

        console.log('🔌 Starting SSE client test...');
        const startTime = performance.now();

        const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
        await client.connect(transport);
        
        const connectTime = performance.now() - startTime;
        console.log(`⚡ SSE connection took: ${connectTime.toFixed(2)}ms`);

        const toolStart = performance.now();
        const callResult = await client.callTool({
            name: 'echo',
            arguments: { text: 'SSE performance test' }
        });
        const toolTime = performance.now() - toolStart;
        
        console.log(`🔧 SSE tool call took: ${toolTime.toFixed(2)}ms`);

        expect((callResult.content as any)[0].text).toBe('SSE performance test');

        await client.close();

        // Compare with Durable Object performance
        const stats = await getTimingStats(port);
        console.log('📈 Performance comparison:');
        console.log(`   SSE Connection: ${connectTime.toFixed(2)}ms`);
        console.log(`   SSE Tool Call: ${toolTime.toFixed(2)}ms`);
        
        if (stats.timingStats.averages?.createSession_server) {
            console.log(`   DO Create Session: ${stats.timingStats.averages.createSession_server.avg.toFixed(2)}ms`);
        }
    });

    test('Multiple concurrent sessions with Durable Objects', async () => {
        const numClients = 3;
        const clients: Client[] = [];
        const transports: StreamableHTTPClientTransport[] = [];

        console.log(`🚀 Testing ${numClients} concurrent clients...`);

        // Create multiple clients
        for (let i = 0; i < numClients; i++) {
            const client = new Client(
                { name: `concurrent-client-${i}`, version: '1.0.0' },
                { capabilities: {} }
            );
            const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
            
            clients.push(client);
            transports.push(transport);
        }

        // Connect all clients concurrently
        const connectionStart = performance.now();
        await Promise.all(clients.map((client, i) => client.connect(transports[i])));
        const connectionTime = performance.now() - connectionStart;
        
        console.log(`⚡ ${numClients} concurrent connections took: ${connectionTime.toFixed(2)}ms`);

        // Make concurrent tool calls
        const callStart = performance.now();
        const results = await Promise.all(
            clients.map((client, i) => 
                client.callTool({
                    name: 'echo',
                    arguments: { text: `Concurrent message ${i}` }
                })
            )
        );
        const callTime = performance.now() - callStart;
        
        console.log(`🔧 ${numClients} concurrent tool calls took: ${callTime.toFixed(2)}ms`);

        // Verify all calls succeeded
        results.forEach((result, i) => {
            expect((result.content as any)[0].text).toBe(`Concurrent message ${i}`);
        });

        // Clean up
        await Promise.all(clients.map(client => client.close()));

        // Check final stats
        const finalStats = await getTimingStats(port);
        console.log(`📊 Created ${finalStats.timingStats.total} total Durable Object operations`);
        
        if (finalStats.timingStats.averages) {
            Object.entries(finalStats.timingStats.averages).forEach(([op, stats]: [string, any]) => {
                console.log(`   ${op}: avg=${stats.avg.toFixed(2)}ms, min=${stats.min.toFixed(2)}ms, max=${stats.max.toFixed(2)}ms, count=${stats.count}`);
            });
        }
    });
});

import { McpServer } from '../server/mcp.js';
import { createSSESessionAdapter, handleSSEAdapterPost } from '../server/sse.js';
import { MCPSessionManager } from './mcpSessionManager.js';
import { z } from 'zod';

const server = new McpServer({
    name: 'cf-worker-durable-universal',
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

server.registerTool(
    'timing-stats',
    {
        title: 'Durable Object Timing Stats',
        description: 'Get performance statistics for Durable Object operations',
        inputSchema: {},
        outputSchema: { stats: z.any() }
    },
    async () => {
        // This will be filled in by the request handler
        return {
            content: [
                { type: 'text', text: 'Timing stats will be provided by session manager' }
            ],
            structuredContent: { stats: {} }
        };
    }
);

interface Env {
    MCP_SESSIONS: DurableObjectNamespace;
}

// Local session cache for performance (in addition to Durable Objects)
const localSessions = new Map<string, { transport: any; dispose: () => void; lastUsed: number }>();

// Function to clean up stale sessions (called on-demand, not with setInterval)
function cleanupStaleSessions() {
    const now = Date.now();
    for (const [sessionId, session] of localSessions.entries()) {
        if (now - session.lastUsed > 5 * 60 * 1000) { // 5 minutes
            session.dispose();
            localSessions.delete(sessionId);
        }
    }
}

function generateUUID(): string {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const sessionManager = new MCPSessionManager(env.MCP_SESSIONS);

        // Performance monitoring endpoint
        if (url.pathname === '/timing-stats') {
            // Clean up stale sessions when monitoring is accessed
            cleanupStaleSessions();
            
            return new Response(JSON.stringify({
                timingStats: sessionManager.getTimingStats(),
                localSessions: localSessions.size,
                timestamp: new Date().toISOString()
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Universal /mcp endpoint - handles both SSE and StreamableHTTP clients
        if (url.pathname === '/mcp') {
            if (request.method === 'GET') {
                // Handle SSE streaming connection (works for both SSE and StreamableHTTP clients)
                const sessionId = generateUUID();
                
                console.log(`🚀 Creating new session: ${sessionId}`);
                
                // Create session in Durable Object with timing - BEFORE creating transport
                const createResult = await sessionManager.createSession(sessionId, {
                    enableJsonResponse: false,
                    createdVia: 'GET /mcp'
                });
                
                console.log(`⏱️  Session creation took: ${createResult.timing?.duration}`);

                const { transport, response, dispose } = createSSESessionAdapter('/mcp', {
                    signal: request.signal,
                });

                // Connect server to this session's transport
                await server.connect(transport);

                // Store locally for fast access
                localSessions.set(sessionId, { transport, dispose, lastUsed: Date.now() });
                
                // Update Durable Object with stream info (fire and forget for performance)
                sessionManager.addStream(sessionId, '_GET_stream', {
                    createdAt: Date.now(),
                    type: 'sse'
                }).catch(console.error);

                // Clean up on disconnect
                request.signal?.addEventListener('abort', async () => {
                    console.log(`🧹 Cleaning up session: ${sessionId}`);
                    const session = localSessions.get(sessionId);
                    if (session) {
                        session.dispose();
                        localSessions.delete(sessionId);
                    }
                    
                    // Remove from Durable Object (fire and forget for performance)
                    sessionManager.deleteSession(sessionId).catch(console.error);
                });

                return response;
            }

            if (request.method === 'POST') {
                // Handle StreamableHTTP clients (they send session ID in header AFTER first POST)
                let sessionId = request.headers.get('mcp-session-id');
                
                if (!sessionId) {
                    // This is the FIRST POST (initialization) - we need to create a session
                    // and return the session ID in the response headers
                    sessionId = generateUUID();
                    
                    console.log(`🆕 Creating session for first POST: ${sessionId}`);
                    
                    // Create session in Durable Object
                    const createResult = await sessionManager.createSession(sessionId, {
                        enableJsonResponse: false,
                        createdVia: 'POST /mcp (initialization)'
                    });
                    
                    console.log(`⏱️  Session creation took: ${createResult.timing?.duration}`);

                    // Create transport for this session
                    const { transport, dispose } = (() => {
                        // For the POST-only flow, we don't need the full SSE adapter
                        // We'll create a minimal transport that can handle responses
                        return {
                            transport: null, // We'll handle this in a simpler way
                            dispose: () => {}
                        };
                    })();

                    // Store the session
                    localSessions.set(sessionId, { transport, dispose, lastUsed: Date.now() });

                    // Process the request and return JSON response with session ID
                    try {
                        const body = await request.text();
                        const message = JSON.parse(body);
                        
                        // Handle the message (for now, just echo back success)
                        // In a real implementation, you'd process this through the MCP server
                        let response;
                        if (message.method === 'initialize') {
                            response = {
                                jsonrpc: '2.0',
                                id: message.id,
                                result: {
                                    protocolVersion: '2024-11-05',
                                    capabilities: {
                                        tools: {}
                                    },
                                    serverInfo: {
                                        name: 'cf-worker-durable-universal',
                                        version: '0.1.0'
                                    }
                                }
                            };
                        } else {
                            response = {
                                jsonrpc: '2.0',
                                id: message.id,
                                error: {
                                    code: -32601,
                                    message: 'Method not supported in POST-only mode'
                                }
                            };
                        }

                        return new Response(JSON.stringify(response), {
                            headers: {
                                'Content-Type': 'application/json',
                                'mcp-session-id': sessionId  // This is the key!
                            }
                        });

                    } catch (error) {
                        return new Response(JSON.stringify({
                            jsonrpc: '2.0',
                            id: null,
                            error: {
                                code: -32700,
                                message: 'Parse error'
                            }
                        }), {
                            status: 400,
                            headers: {
                                'Content-Type': 'application/json',
                                'mcp-session-id': sessionId
                            }
                        });
                    }
                }

                // This is a subsequent POST with session ID
                console.log(`📨 Processing POST for session: ${sessionId}`);

                // Try local cache first (fast path)
                let session = localSessions.get(sessionId);
                
                if (session) {
                    session.lastUsed = Date.now();
                    console.log(`⚡ Using cached session: ${sessionId}`);
                    
                    // For POST-only sessions, handle the message directly
                    try {
                        const body = await request.text();
                        const message = JSON.parse(body);
                        
                        // Process message through server if we have a transport
                        if (session.transport) {
                            return await handleSSEAdapterPost(request, session.transport);
                        } else {
                            // Handle directly for POST-only mode
                            let response;
                            if (message.method === 'tools/list') {
                                response = {
                                    jsonrpc: '2.0',
                                    id: message.id,
                                    result: {
                                        tools: [
                                            {
                                                name: 'echo',
                                                description: 'Echo back the provided message',
                                                inputSchema: {
                                                    type: 'object',
                                                    properties: {
                                                        text: { type: 'string' }
                                                    },
                                                    required: ['text']
                                                }
                                            },
                                            {
                                                name: 'timing-stats',
                                                description: 'Get performance statistics for Durable Object operations',
                                                inputSchema: {
                                                    type: 'object',
                                                    properties: {}
                                                }
                                            }
                                        ]
                                    }
                                };
                            } else if (message.method === 'tools/call' && message.params?.name === 'echo') {
                                response = {
                                    jsonrpc: '2.0',
                                    id: message.id,
                                    result: {
                                        content: [
                                            { type: 'text', text: message.params.arguments.text }
                                        ]
                                    }
                                };
                            } else if (message.method === 'tools/call' && message.params?.name === 'timing-stats') {
                                // Get timing stats from session manager
                                const stats = sessionManager.getTimingStats();
                                response = {
                                    jsonrpc: '2.0',
                                    id: message.id,
                                    result: {
                                        content: [
                                            { 
                                                type: 'text', 
                                                text: `Durable Object Performance:\n${JSON.stringify(stats, null, 2)}` 
                                            }
                                        ],
                                        structuredContent: { stats }
                                    }
                                };
                            } else {
                                response = {
                                    jsonrpc: '2.0',
                                    id: message.id,
                                    error: {
                                        code: -32601,
                                        message: 'Method not found'
                                    }
                                };
                            }
                            
                            return new Response(JSON.stringify(response), {
                                headers: {
                                    'Content-Type': 'application/json',
                                    'mcp-session-id': sessionId
                                }
                            });
                        }
                    } catch (error) {
                        return new Response(JSON.stringify({
                            jsonrpc: '2.0',
                            id: null,
                            error: {
                                code: -32700,
                                message: 'Parse error'
                            }
                        }), {
                            status: 400,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                } else {
                    // Fallback to Durable Object (slower but reliable)
                    console.log(`🔍 Fetching session from DO: ${sessionId}`);
                    
                    const getResult = await sessionManager.getSession(sessionId);
                    console.log(`⏱️  Session fetch took: ${getResult.timing?.duration} (cache hit: ${getResult.timing?.cacheHit})`);
                    
                    if (!getResult.success) {
                        return new Response(JSON.stringify({
                            error: 'Session not found',
                            sessionId,
                            timing: getResult.timing
                        }), { 
                            status: 404,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    return new Response(JSON.stringify({
                        error: 'Session found in DO but transport not available',
                        hint: 'Use SSE mode for full functionality',
                        sessionData: getResult.session,
                        timing: getResult.timing
                    }), { 
                        status: 503,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }

            if (request.method === 'OPTIONS') {
                // Handle CORS preflight
                return new Response(null, {
                    status: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
                        'Access-Control-Max-Age': '86400',
                    }
                });
            }
        }

        // Alternative pure SSE endpoints
        if (url.pathname === '/sse' && request.method === 'GET') {
            const sessionId = generateUUID();
            
            await sessionManager.createSession(sessionId, {
                enableJsonResponse: false,
                createdVia: 'GET /sse'
            });

            const { transport, response, dispose } = createSSESessionAdapter('/messages', {
                signal: request.signal,
            });

            await server.connect(transport);
            localSessions.set(sessionId, { transport, dispose, lastUsed: Date.now() });

            request.signal?.addEventListener('abort', async () => {
                const session = localSessions.get(sessionId);
                if (session) {
                    session.dispose();
                    localSessions.delete(sessionId);
                }
                sessionManager.deleteSession(sessionId).catch(console.error);
            });

            return response;
        }

        if (url.pathname === '/messages' && request.method === 'POST') {
            // Pure SSE message endpoint - use most recent session
            const sessions = Array.from(localSessions.values());
            
            if (sessions.length === 0) {
                return new Response('No active SSE session found', { status: 404 });
            }
            
            // Use the most recent session
            const session = sessions[sessions.length - 1];
            session.lastUsed = Date.now();
            
            return await handleSSEAdapterPost(request, session.transport);
        }

        return new Response(`
# Universal MCP Cloudflare Worker with Durable Objects

This worker supports multiple connection types with persistent session storage:

## StreamableHTTP Protocol (with Durable Objects)
- GET  /mcp  - Start SSE stream (creates DO session)
- POST /mcp  - Send messages (with mcp-session-id header)

## Pure SSE Protocol  
- GET  /sse      - Start SSE stream
- POST /messages - Send messages

## Performance Monitoring
- GET /timing-stats - View Durable Object performance metrics

Sessions are stored in Cloudflare Durable Objects for persistence across worker restarts!
        `.trim(), { 
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
};

// Export the Durable Object class for Cloudflare Workers
export { MCPSessionDurableObject } from './mcpSessionDurableObject.js';

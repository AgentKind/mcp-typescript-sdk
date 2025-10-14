import { DurableObjectStorage, DurableObjectState } from '@cloudflare/workers-types';
// Durable Object for MCP Session Management
export class MCPSessionDurableObject {
    private storage: DurableObjectStorage;
    private sessions = new Map<string, any>();
    
    constructor(state: DurableObjectState, env: any) {
        this.storage = state.storage;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const startTime = performance.now();
        
        try {
            if (request.method === 'POST') {
                const { action, sessionId, data } = await request.json();
                
                switch (action) {
                    case 'createSession':
                        return await this.createSession(sessionId, data, startTime);
                    
                    case 'getSession':
                        return await this.getSession(sessionId, startTime);
                    
                    case 'updateSession':
                        return await this.updateSession(sessionId, data, startTime);
                    
                    case 'deleteSession':
                        return await this.deleteSession(sessionId, startTime);
                    
                    case 'addStream':
                        return await this.addStream(sessionId, data, startTime);
                    
                    case 'removeStream':
                        return await this.removeStream(sessionId, data, startTime);
                    
                    default:
                        return new Response(`Unknown action: ${action}`, { status: 400 });
                }
            }
            
            return new Response('Method not allowed', { status: 405 });
        } catch (error) {
            const duration = performance.now() - startTime;
            console.error(`DO Error after ${duration}ms:`, error);
            return new Response(`Internal error: ${error instanceof Error ? error.message : String(error)}`, { 
                status: 500 
            });
        }
    }

    private async createSession(sessionId: string, data: any, startTime: number): Promise<Response> {
        const sessionState = {
            sessionId,
            initialized: false,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            streamMapping: {},
            requestToStreamMapping: {},
            requestResponseMap: {},
            enableJsonResponse: data.enableJsonResponse || false,
            protocolVersion: data.protocolVersion,
            ...data
        };
        
        // Store in Durable Object storage for persistence
        await this.storage.put(`session:${sessionId}`, sessionState);
        
        // Also cache in memory for faster access
        this.sessions.set(sessionId, sessionState);
        
        const duration = performance.now() - startTime;
        
        return new Response(JSON.stringify({
            success: true,
            sessionId,
            timing: {
                operation: 'createSession',
                duration: `${duration.toFixed(2)}ms`
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    private async getSession(sessionId: string, startTime: number): Promise<Response> {
        // Try memory first (fast path)
        let session = this.sessions.get(sessionId);
        let cacheHit = !!session;
        
        if (!session) {
            // Fallback to storage (slower but persistent)
            session = await this.storage.get(`session:${sessionId}`);
            if (session) {
                this.sessions.set(sessionId, session); // Cache for next time
            }
        }
        
        const duration = performance.now() - startTime;
        
        if (!session) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Session not found',
                timing: {
                    operation: 'getSession',
                    duration: `${duration.toFixed(2)}ms`,
                    cacheHit: false
                }
            }), { 
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Update last activity
        session.lastActivity = Date.now();
        await this.storage.put(`session:${sessionId}`, session);
        
        return new Response(JSON.stringify({
            success: true,
            session,
            timing: {
                operation: 'getSession',
                duration: `${duration.toFixed(2)}ms`,
                cacheHit
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    private async updateSession(sessionId: string, updates: any, startTime: number): Promise<Response> {
        let session = this.sessions.get(sessionId);
        
        if (!session) {
            session = await this.storage.get(`session:${sessionId}`);
        }
        
        if (!session) {
            const duration = performance.now() - startTime;
            return new Response(JSON.stringify({
                success: false,
                error: 'Session not found',
                timing: { operation: 'updateSession', duration: `${duration.toFixed(2)}ms` }
            }), { 
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Merge updates
        Object.assign(session, updates);
        session.lastActivity = Date.now();
        
        // Persist to storage
        await this.storage.put(`session:${sessionId}`, session);
        
        // Update memory cache
        this.sessions.set(sessionId, session);
        
        const duration = performance.now() - startTime;
        
        return new Response(JSON.stringify({
            success: true,
            session,
            timing: {
                operation: 'updateSession',
                duration: `${duration.toFixed(2)}ms`
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    private async deleteSession(sessionId: string, startTime: number): Promise<Response> {
        // Remove from memory cache
        this.sessions.delete(sessionId);
        
        // Remove from persistent storage
        await this.storage.delete(`session:${sessionId}`);
        
        const duration = performance.now() - startTime;
        
        return new Response(JSON.stringify({
            success: true,
            timing: {
                operation: 'deleteSession',
                duration: `${duration.toFixed(2)}ms`
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    private async addStream(sessionId: string, { streamId, streamData }: any, startTime: number): Promise<Response> {
        let session = this.sessions.get(sessionId);
        
        if (!session) {
            session = await this.storage.get(`session:${sessionId}`);
        }
        
        if (!session) {
            const duration = performance.now() - startTime;
            return new Response(JSON.stringify({
                success: false,
                error: 'Session not found',
                timing: { operation: 'addStream', duration: `${duration.toFixed(2)}ms` }
            }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        // Add stream to session
        session.streamMapping[streamId] = streamData;
        session.lastActivity = Date.now();
        
        await this.storage.put(`session:${sessionId}`, session);
        this.sessions.set(sessionId, session);
        
        const duration = performance.now() - startTime;
        
        return new Response(JSON.stringify({
            success: true,
            timing: {
                operation: 'addStream',
                duration: `${duration.toFixed(2)}ms`
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    private async removeStream(sessionId: string, { streamId }: any, startTime: number): Promise<Response> {
        let session = this.sessions.get(sessionId);
        
        if (!session) {
            session = await this.storage.get(`session:${sessionId}`);
        }
        
        if (session && session.streamMapping) {
            delete session.streamMapping[streamId];
            session.lastActivity = Date.now();
            
            await this.storage.put(`session:${sessionId}`, session);
            this.sessions.set(sessionId, session);
        }
        
        const duration = performance.now() - startTime;
        
        return new Response(JSON.stringify({
            success: true,
            timing: {
                operation: 'removeStream',
                duration: `${duration.toFixed(2)}ms`
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

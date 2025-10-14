// Helper class to interact with MCP Session Durable Objects
export class MCPSessionManager {
    private durableObjectNamespace: any;
    private timingStats: Array<{ operation: string; duration: number; timestamp: number }> = [];
    
    constructor(durableObjectNamespace: any) {
        this.durableObjectNamespace = durableObjectNamespace;
    }
    
    // Get timing statistics
    getTimingStats() {
        return {
            recent: this.timingStats.slice(-10), // Last 10 operations
            averages: this.calculateAverages(),
            total: this.timingStats.length
        };
    }
    
    private calculateAverages() {
        if (this.timingStats.length === 0) return {};
        
        const byOperation = new Map<string, number[]>();
        
        for (const stat of this.timingStats) {
            if (!byOperation.has(stat.operation)) {
                byOperation.set(stat.operation, []);
            }
            byOperation.get(stat.operation)!.push(stat.duration);
        }
        
        const averages: Record<string, { avg: number; min: number; max: number; count: number }> = {};
        
        for (const [operation, durations] of byOperation.entries()) {
            const sum = durations.reduce((a, b) => a + b, 0);
            averages[operation] = {
                avg: sum / durations.length,
                min: Math.min(...durations),
                max: Math.max(...durations),
                count: durations.length
            };
        }
        
        return averages;
    }
    
    private recordTiming(operation: string, duration: number) {
        this.timingStats.push({
            operation,
            duration,
            timestamp: Date.now()
        });
        
        // Keep only last 100 entries to prevent memory bloat
        if (this.timingStats.length > 100) {
            this.timingStats = this.timingStats.slice(-50);
        }
    }
    
    private async callDurableObject(sessionId: string, action: string, data?: any): Promise<any> {
        const durableObjectId = this.durableObjectNamespace.idFromName(sessionId);
        const durableObject = this.durableObjectNamespace.get(durableObjectId);
        
        const startTime = performance.now();
        
        try {
            const response = await durableObject.fetch('https://session-manager/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, sessionId, data })
            });
            
            const result = await response.json();
            
            // Record timing from both client-side and server-side measurements
            const clientDuration = performance.now() - startTime;
            this.recordTiming(`${action}_client`, clientDuration);
            
            if (result.timing) {
                this.recordTiming(`${action}_server`, parseFloat(result.timing.duration));
            }
            
            return result;
        } catch (error) {
            const duration = performance.now() - startTime;
            this.recordTiming(`${action}_error`, duration);
            throw error;
        }
    }
    
    async createSession(sessionId: string, config: any = {}): Promise<any> {
        return await this.callDurableObject(sessionId, 'createSession', config);
    }
    
    async getSession(sessionId: string): Promise<any> {
        return await this.callDurableObject(sessionId, 'getSession');
    }
    
    async updateSession(sessionId: string, updates: any): Promise<any> {
        return await this.callDurableObject(sessionId, 'updateSession', updates);
    }
    
    async deleteSession(sessionId: string): Promise<any> {
        return await this.callDurableObject(sessionId, 'deleteSession');
    }
    
    async addStream(sessionId: string, streamId: string, streamData: any): Promise<any> {
        return await this.callDurableObject(sessionId, 'addStream', { streamId, streamData });
    }
    
    async removeStream(sessionId: string, streamId: string): Promise<any> {
        return await this.callDurableObject(sessionId, 'removeStream', { streamId });
    }
}

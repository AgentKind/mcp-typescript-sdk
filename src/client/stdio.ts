import { ReadBuffer, serializeMessage } from '../shared/stdio.js';
import { Transport } from '../shared/transport.js';
import { JSONRPCMessage } from '../types.js';

// Check if we're in a Node.js environment
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

// Use any for Node-specific types when not in Node
type ChildProcess = any;
type IOType = any;
type Stream = any;
type PassThrough = any;

export type StdioServerParameters = {
    /**
     * The executable to run to start the server.
     */
    command: string;

    /**
     * Command line arguments to pass to the executable.
     */
    args?: string[];

    /**
     * The environment to use when spawning the process.
     *
     * If not specified, the result of getDefaultEnvironment() will be used.
     */
    env?: Record<string, string>;

    /**
     * How to handle stderr of the child process. This matches the semantics of Node's `child_process.spawn`.
     *
     * The default is "inherit", meaning messages to stderr will be printed to the parent process's stderr.
     */
    stderr?: IOType | Stream | number;

    /**
     * The working directory to use when spawning the process.
     *
     * If not specified, the current working directory will be inherited.
     */
    cwd?: string;
};

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
    isNode && (globalThis as any).process.platform === 'win32'
        ? [
              'APPDATA',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PROCESSOR_ARCHITECTURE',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'USERNAME',
              'USERPROFILE',
              'PROGRAMFILES'
          ]
        : /* list inspired by the default env inheritance of sudo */
          ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
    if (!isNode) {
        return {};
    }

    const env: Record<string, string> = {};
    const processEnv = (globalThis as any).process.env;

    for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = processEnv[key];
        if (value === undefined) {
            continue;
        }

        if (value.startsWith('()')) {
            // Skip functions, which are a security risk.
            continue;
        }

        env[key] = value;
    }

    return env;
}

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * This transport is only available in Node.js environments.
 * In browser/edge environments, attempting to use this will throw an error.
 */
export class StdioClientTransport implements Transport {
    private _process?: ChildProcess;
    private _abortController: AbortController = new AbortController();
    private _readBuffer: ReadBuffer = new ReadBuffer();
    private _serverParams: StdioServerParameters;
    private _stderrStream: PassThrough | null = null;
    private _spawn: any;
    private _PassThrough: any;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(server: StdioServerParameters) {
        if (!isNode) {
            throw new Error('StdioClientTransport is only available in Node.js environments. Use SSEClientTransport or WebSocketClientTransport for browsers and edge runtimes.');
        }

        this._serverParams = server;
    }

    private async loadNodeModules() {
        if (!this._spawn) {
            try {
                // @ts-ignore - cross-spawn is optional peer dependency
                const spawnMod = await import('cross-spawn');
                this._spawn = spawnMod.default;
            } catch {
                throw new Error('cross-spawn is required for StdioClientTransport');
            }
        }

        if (!this._PassThrough) {
            // @ts-ignore - node:stream
            const streamMod = await import('node:stream');
            this._PassThrough = streamMod.PassThrough;

            if (this._serverParams.stderr === 'pipe' || this._serverParams.stderr === 'overlapped') {
                this._stderrStream = new this._PassThrough();
            }
        }
    }

    /**
     * Starts the server process and prepares to communicate with it.
     */
    async start(): Promise<void> {
        if (this._process) {
            throw new Error(
                'StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }

        await this.loadNodeModules();

        const proc = (globalThis as any).process;

        return new Promise((resolve, reject) => {
            this._process = this._spawn(this._serverParams.command, this._serverParams.args ?? [], {
                // merge default env with server env because mcp server needs some env vars
                env: {
                    ...getDefaultEnvironment(),
                    ...this._serverParams.env
                },
                stdio: ['pipe', 'pipe', this._serverParams.stderr ?? 'inherit'],
                shell: false,
                signal: this._abortController.signal,
                windowsHide: proc.platform === 'win32' && isElectron(),
                cwd: this._serverParams.cwd
            });

            this._process.on('error', (error: any) => {
                if (error.name === 'AbortError') {
                    // Expected when close() is called.
                    this.onclose?.();
                    return;
                }

                reject(error);
                this.onerror?.(error);
            });

            this._process.on('spawn', () => {
                resolve();
            });

            this._process.on('close', (_code: any) => {
                this._process = undefined;
                this.onclose?.();
            });

            this._process.stdin?.on('error', (error: any) => {
                this.onerror?.(error);
            });

            this._process.stdout?.on('data', (chunk: any) => {
                this._readBuffer.append(chunk);
                this.processReadBuffer();
            });

            this._process.stdout?.on('error', (error: any) => {
                this.onerror?.(error);
            });

            if (this._stderrStream && this._process.stderr) {
                this._process.stderr.pipe(this._stderrStream);
            }
        });
    }

    /**
     * The stderr stream of the child process, if `StdioServerParameters.stderr` was set to "pipe" or "overlapped".
     *
     * If stderr piping was requested, a PassThrough stream is returned _immediately_, allowing callers to
     * attach listeners before the start method is invoked. This prevents loss of any early
     * error output emitted by the child process.
     */
    get stderr(): Stream | null {
        if (this._stderrStream) {
            return this._stderrStream;
        }

        return this._process?.stderr ?? null;
    }

    /**
     * The child process pid spawned by this transport.
     *
     * This is only available after the transport has been started.
     */
    get pid(): number | null {
        return this._process?.pid ?? null;
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    async close(): Promise<void> {
        this._abortController.abort();
        this._process = undefined;
        this._readBuffer.clear();
    }

    send(message: JSONRPCMessage): Promise<void> {
        return new Promise(resolve => {
            if (!this._process?.stdin) {
                throw new Error('Not connected');
            }

            const json = serializeMessage(message);
            if (this._process.stdin.write(json)) {
                resolve();
            } else {
                this._process.stdin.once('drain', resolve);
            }
        });
    }
}

function isElectron() {
    return 'type' in process;
}

const encoder = new TextEncoder();

function encode(message: string): Uint8Array {
    return encoder.encode(message);
}

export default {
    async fetch(request: Request): Promise<Response> {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const send = (payload: string) => controller.enqueue(encode(payload));
                send('event: ready\ndata: hello\n\n');

                const keepAlive = setInterval(() => {
                    send(`: keep-alive ${Date.now()}\n\n`);
                }, 5000);

                const abort = () => {
                    clearInterval(keepAlive);
                    controller.close();
                };

                request.signal.addEventListener('abort', abort, { once: true });
            }
        });

        return new Response(stream, {
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                connection: 'keep-alive'
            }
        });
    }
};

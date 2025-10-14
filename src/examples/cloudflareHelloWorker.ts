export default {
    async fetch(_request: Request): Promise<Response> {
        return new Response('Hello from Wrangler dev!', {
            headers: { 'content-type': 'text/plain;charset=UTF-8' }
        });
    }
};

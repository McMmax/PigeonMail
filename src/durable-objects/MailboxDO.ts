import type { DurableObjectState } from '@cloudflare/workers-types';

export class MailboxDO {
  private state: DurableObjectState;
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const clientSocket = pair[0];
      const serverSocket = pair[1];

      serverSocket.accept();
      this.sockets.add(serverSocket);

      serverSocket.addEventListener('close', () => {
        this.sockets.delete(serverSocket);
      });

      serverSocket.addEventListener('error', () => {
        this.sockets.delete(serverSocket);
      });

      serverSocket.send(JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() }));

      return new Response(null, { status: 101, webSocket: clientSocket });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const payload = await request.text();
      for (const socket of this.sockets) {
        try {
          socket.send(payload);
        } catch {
          this.sockets.delete(socket);
        }
      }
      return new Response(JSON.stringify({ success: true, clientCount: this.sockets.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

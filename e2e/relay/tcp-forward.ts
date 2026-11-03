import { createConnection, createServer, type Server, type Socket } from 'node:net';

export interface TcpForward {
  close(): Promise<void>;
}

// Forwards 127.0.0.1:port (and [::1]:port when the machine has IPv6) to an upstream host:port, so a relay that runs in
// another container answers where the test build looks for it. The IPv6 listener is best effort.
export async function startTcpForward(o: { port: number; upstream: { host: string; port: number } }): Promise<TcpForward> {
  const sockets = new Set<Socket>();
  const handle = (client: Socket): void => {
    const upstream = createConnection({ host: o.upstream.host, port: o.upstream.port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const servers: Server[] = [];
  for (const host of ['127.0.0.1', '::1']) {
    const server = createServer(handle);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port: o.port }, () => resolve());
      });
      servers.push(server);
    } catch (error) {
      // A machine without IPv6 loopback has no ::1; any other failure (say, the port is taken) must stop the start-up.
      const code = (error as NodeJS.ErrnoException).code;
      if (host === '127.0.0.1' || (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT')) {
        await Promise.all(servers.map((started) => new Promise<void>((resolve) => started.close(() => resolve()))));
        throw error;
      }
    }
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}

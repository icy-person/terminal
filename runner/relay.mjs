import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const HOST = process.env.RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT || 8090);
const TOKEN = process.env.TERMINAL_TOKEN;
const UPSTREAM = process.env.TTYD_WS_URL || "ws://127.0.0.1:7681/ws";
const MAX_CLIENTS = Number(process.env.RELAY_MAX_CLIENTS || 8);

if (!TOKEN || TOKEN.length < 32) throw new Error("TERMINAL_TOKEN must contain at least 32 characters");

const metrics = {
  startedAt: new Date().toISOString(), upgrades: 0, authorized: 0, rejected: 0,
  activeClients: 0, upstreamOpen: 0, upstreamErrors: 0,
  messagesClientToUpstream: 0, messagesUpstreamToClient: 0,
  bytesClientToUpstream: 0, bytesUpstreamToClient: 0, queuedClientMessages: 0,
  lastClientMessageAt: null, lastUpstreamMessageAt: null, lastError: null
};

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "terminal-relay", upstream: UPSTREAM, clients: wss.clients.size, metrics }));
    return;
  }
  if (req.url === "/healthz/ready") {
    const ready = wss.clients.size < MAX_CLIENTS;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: ready, capacity: MAX_CLIENTS, clients: wss.clients.size }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("not found\n");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

function authorized(url) {
  const supplied = url.searchParams.get("token") || "";
  return supplied.length === TOKEN.length && supplied === TOKEN;
}

server.on("upgrade", (req, socket, head) => {
  metrics.upgrades++;
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { metrics.rejected++; socket.destroy(); return; }
  if (url.pathname !== "/ws") {
    metrics.rejected++; socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  if (!authorized(url)) {
    metrics.rejected++; console.log("WS_REJECT unauthorized websocket upgrade");
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  if (wss.clients.size >= MAX_CLIENTS) {
    metrics.rejected++; console.log(`WS_REJECT capacity clients=${wss.clients.size}`);
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  metrics.authorized++;
  console.log(`WS_UPGRADE authorized clients_before=${wss.clients.size}`);
  wss.handleUpgrade(req, socket, head, client => wss.emit("connection", client, req));
});

wss.on("connection", client => {
  metrics.activeClients = wss.clients.size;
  console.log(`WS_CLIENT_CONNECTED clients=${wss.clients.size}`);

  // ttyd registers its websocket protocol as "tty". Without negotiating it,
  // libwebsockets accepts the TCP upgrade but never dispatches to callback_tty.
  const upstream = new WebSocket(UPSTREAM, "tty", {
    origin: "http://127.0.0.1:7681",
    perMessageDeflate: false,
    handshakeTimeout: 10000
  });

  let closed = false;
  const pending = [];

  const sendUpstream = (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return false;
    try { upstream.send(data, { binary: isBinary }); return true; }
    catch (error) {
      metrics.lastError = String(error?.message || error);
      console.log(`WS_UPSTREAM_SEND_ERROR ${metrics.lastError}`);
      return false;
    }
  };

  const flushPending = () => {
    while (upstream.readyState === WebSocket.OPEN && pending.length) {
      const message = pending.shift();
      if (!sendUpstream(message.data, message.isBinary)) { pending.unshift(message); break; }
    }
    metrics.queuedClientMessages = pending.length;
  };

  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    metrics.activeClients = wss.clients.size;
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      try { client.close(code, reason); } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      try { upstream.close(code, reason); } catch {}
    }
  };

  upstream.on("open", () => {
    metrics.upstreamOpen++;
    console.log(`WS_UPSTREAM_OPEN protocol=${upstream.protocol} url=${UPSTREAM}`);
    flushPending();
  });
  upstream.on("message", (data, isBinary) => {
    metrics.messagesUpstreamToClient++;
    metrics.bytesUpstreamToClient += data.length ?? Buffer.byteLength(String(data));
    metrics.lastUpstreamMessageAt = new Date().toISOString();
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("unexpected-response", (_request, response) => {
    metrics.upstreamErrors++;
    metrics.lastError = `HTTP ${response.statusCode} from ttyd upstream`;
    console.log(`WS_UPSTREAM_HTTP_ERROR status=${response.statusCode}`);
    response.resume(); closeBoth(1011, "upstream handshake rejected");
  });
  upstream.on("close", (code, reason) => {
    console.log(`WS_UPSTREAM_CLOSE code=${code} reason=${reason?.toString() || ""}`);
    closeBoth(code || 1000, reason?.toString() || "upstream closed");
  });
  upstream.on("error", error => {
    metrics.upstreamErrors++;
    metrics.lastError = String(error?.message || error);
    console.log(`WS_UPSTREAM_ERROR ${metrics.lastError}`);
    closeBoth(1011, "upstream error");
  });
  client.on("message", (data, isBinary) => {
    const bytes = data.length ?? Buffer.byteLength(String(data));
    metrics.messagesClientToUpstream++;
    metrics.bytesClientToUpstream += bytes;
    metrics.lastClientMessageAt = new Date().toISOString();
    console.log(`WS_CLIENT_MESSAGE bytes=${bytes} binary=${isBinary} upstream=${upstream.readyState}`);
    if (!sendUpstream(data, isBinary)) {
      pending.push({ data, isBinary });
      metrics.queuedClientMessages = pending.length;
      console.log(`WS_QUEUE_CLIENT_MESSAGE queued=${pending.length}`);
    }
  });
  client.on("close", (code, reason) => {
    console.log(`WS_CLIENT_CLOSE code=${code} reason=${reason?.toString() || ""}`);
    closeBoth(code || 1000, reason?.toString() || "client closed");
    metrics.activeClients = wss.clients.size;
  });
  client.on("error", error => {
    metrics.lastError = String(error?.message || error);
    console.log(`WS_CLIENT_ERROR ${metrics.lastError}`);
    closeBoth(1011, "client error");
    metrics.activeClients = wss.clients.size;
  });
});

server.listen(PORT, HOST, () => {
  console.log(`terminal relay listening on ${HOST}:${PORT}`);
  console.log(`upstream ttyd: ${UPSTREAM}`);
  console.log("diagnostics: /healthz /healthz/ready");
});

function shutdown(signal) {
  console.log(`${signal}: shutting down relay`);
  for (const client of wss.clients) client.close(1001, "relay shutting down");
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const HOST = process.env.RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT || 8090);
const TOKEN = process.env.TERMINAL_TOKEN;
const UPSTREAM = process.env.TTYD_WS_URL || "ws://127.0.0.1:7681/ws";
const MAX_CLIENTS = Number(process.env.RELAY_MAX_CLIENTS || 8);

if (!TOKEN || TOKEN.length < 64) {
  throw new Error("TERMINAL_TOKEN must contain at least 64 characters");
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
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
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!authorized(url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (wss.clients.size >= MAX_CLIENTS) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
});

wss.on("connection", (client) => {
  const upstream = new WebSocket(UPSTREAM, {
    perMessageDeflate: false,
    headers: { Origin: "http://127.0.0.1:7681" }
  });

  let closed = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      try { client.close(code, reason); } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      try { upstream.close(code, reason); } catch {}
    }
  };

  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => closeBoth(code || 1000, reason?.toString() || "upstream closed"));
  upstream.on("error", () => closeBoth(1011, "upstream error"));

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  client.on("close", (code, reason) => closeBoth(code || 1000, reason?.toString() || "client closed"));
  client.on("error", () => closeBoth(1011, "client error"));
});

server.listen(PORT, HOST, () => {
  console.log(`terminal relay listening on ${HOST}:${PORT}`);
  console.log(`upstream ttyd: ${UPSTREAM}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down relay`);
  for (const client of wss.clients) client.close(1001, "relay shutting down");
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

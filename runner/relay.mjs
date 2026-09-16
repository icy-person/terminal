import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const HOST = process.env.RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT || 8090);
const TOKEN = process.env.TERMINAL_TOKEN;
const UPSTREAM = process.env.TTYD_WS_URL || "ws://127.0.0.1:7681/ws";
const NOVNC_HTTP = process.env.NOVNC_HTTP_URL || "http://127.0.0.1:6080";
const NOVNC_WS = process.env.NOVNC_WS_URL || "ws://127.0.0.1:6080/websockify";
const MAX_CLIENTS = Number(process.env.RELAY_MAX_CLIENTS || 8);

if (!TOKEN || TOKEN.length < 32) throw new Error("TERMINAL_TOKEN must contain at least 32 characters");

const metrics = {
  startedAt: new Date().toISOString(), upgrades: 0, authorized: 0, rejected: 0,
  novncUpgrades: 0, novncAuthorized: 0, novncRejected: 0,
  activeClients: 0, upstreamOpen: 0, upstreamErrors: 0,
  messagesClientToUpstream: 0, messagesUpstreamToClient: 0,
  bytesClientToUpstream: 0, bytesUpstreamToClient: 0, queuedClientMessages: 0,
  lastClientMessageAt: null, lastUpstreamMessageAt: null, lastError: null
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "terminal-relay", upstream: UPSTREAM, novnc: NOVNC_HTTP, clients: terminalWss.clients.size, metrics }));
    return;
  }
  if (url.pathname === "/healthz/ready") {
    const ready = terminalWss.clients.size < MAX_CLIENTS;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: ready, capacity: MAX_CLIENTS, clients: terminalWss.clients.size }));
    return;
  }

  if (url.pathname === "/novnc" || url.pathname.startsWith("/novnc/")) {
    proxyNoVncHttp(req, res, url);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("not found\n");
});

const terminalWss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
  handleProtocols: protocols => protocols.has("tty") ? "tty" : false
});

const novncWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024 * 1024,
  perMessageDeflate: false
});

function cookieToken(req) {
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)terminal_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function authorized(url, req = null) {
  const supplied = url.searchParams.get("token") || (req ? cookieToken(req) : "");
  return supplied.length === TOKEN.length && supplied === TOKEN;
}

function proxyNoVncHttp(req, res, url) {
  const targetPath = url.pathname === "/novnc" ? "/" : url.pathname.slice("/novnc".length) || "/";
  const target = new URL(targetPath + (url.search || ""), NOVNC_HTTP);
  const upstreamReq = http.request(target, {
    method: req.method,
    headers: { ...req.headers, host: target.host, connection: "close" }
  }, upstreamRes => {
    const headers = { ...upstreamRes.headers };
    res.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", error => {
    metrics.lastError = `noVNC HTTP proxy: ${error.message}`;
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("noVNC upstream unavailable\n");
  });
  req.pipe(upstreamReq);
}

function normalizeNoVncWsPath(pathname) {
  return pathname.replace(/^\/+/, "/");
}

server.on("upgrade", (req, socket, head) => {
  metrics.upgrades++;
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { metrics.rejected++; socket.destroy(); return; }

  const normalizedPath = normalizeNoVncWsPath(url.pathname);
  if (normalizedPath === "/novnc/websockify" || normalizedPath === "/novnc/websockify/" || normalizedPath === "/websockify" || normalizedPath === "/websockify/") {
    console.log(`NOVNC_WS_ROUTE raw=${url.pathname} normalized=${normalizedPath} auth=disabled`);
    handleNoVncUpgrade(req, socket, head, url);
    return;
  }

  if (url.pathname !== "/ws") {
    metrics.rejected++; socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  if (!authorized(url, req)) {
    metrics.rejected++; console.log("WS_REJECT unauthorized websocket upgrade");
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  if (terminalWss.clients.size >= MAX_CLIENTS) {
    metrics.rejected++; console.log(`WS_REJECT capacity clients=${terminalWss.clients.size}`);
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  metrics.authorized++;
  console.log(`WS_UPGRADE authorized clients_before=${terminalWss.clients.size}`);
  terminalWss.handleUpgrade(req, socket, head, client => terminalWss.emit("connection", client, req));
});

function handleNoVncUpgrade(req, socket, head, url) {
  metrics.novncUpgrades++;
  metrics.novncAuthorized++;
  console.log("NOVNC_WS_UPGRADE auth=disabled");
  novncWss.handleUpgrade(req, socket, head, browserWs => novncWss.emit("connection", browserWs, req));
}

novncWss.on("connection", client => {
  const upstream = new WebSocket(NOVNC_WS, undefined, { perMessageDeflate: false, handshakeTimeout: 10000 });
  let closed = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    if (client.readyState <= WebSocket.OPEN) try { client.close(code, reason); } catch {}
    if (upstream.readyState <= WebSocket.OPEN) try { upstream.close(code, reason); } catch {}
  };

  upstream.on("open", () => console.log("NOVNC_WS_UPSTREAM_OPEN"));
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("unexpected-response", (_r, response) => {
    metrics.lastError = `noVNC upstream HTTP ${response.statusCode}`;
    response.resume();
    closeBoth(1011, "noVNC upstream handshake rejected");
  });
  upstream.on("close", (code, reason) => closeBoth(code || 1000, reason?.toString() || "noVNC upstream closed"));
  upstream.on("error", error => {
    metrics.lastError = `noVNC WS proxy: ${error.message}`;
    closeBoth(1011, "noVNC upstream error");
  });
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  client.on("close", (code, reason) => closeBoth(code || 1000, reason?.toString() || "browser closed"));
  client.on("error", error => {
    metrics.lastError = `noVNC browser WS: ${error.message}`;
    closeBoth(1011, "browser websocket error");
  });
});

terminalWss.on("connection", client => {
  metrics.activeClients = terminalWss.clients.size;
  console.log(`WS_CLIENT_CONNECTED clients=${terminalWss.clients.size} protocol=${client.protocol || "none"}`);
  const upstream = new WebSocket(UPSTREAM, "tty", { origin: "http://127.0.0.1:7681", perMessageDeflate: false, handshakeTimeout: 10000 });
  let closed = false;
  const pending = [];
  const sendUpstream = (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return false;
    try { upstream.send(data, { binary: isBinary }); return true; }
    catch (error) { metrics.lastError = String(error?.message || error); return false; }
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
    if (client.readyState <= WebSocket.OPEN) try { client.close(code, reason); } catch {}
    if (upstream.readyState <= WebSocket.OPEN) try { upstream.close(code, reason); } catch {}
  };
  upstream.on("open", () => { metrics.upstreamOpen++; console.log(`WS_UPSTREAM_OPEN protocol=${upstream.protocol} url=${UPSTREAM}`); flushPending(); });
  upstream.on("message", (data, isBinary) => {
    metrics.messagesUpstreamToClient++;
    metrics.bytesUpstreamToClient += data.length ?? Buffer.byteLength(String(data));
    metrics.lastUpstreamMessageAt = new Date().toISOString();
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("unexpected-response", (_r, response) => {
    metrics.upstreamErrors++;
    metrics.lastError = `HTTP ${response.statusCode} from ttyd upstream`;
    response.resume();
    closeBoth(1011, "upstream handshake rejected");
  });
  upstream.on("close", (code, reason) => closeBoth(code || 1000, reason?.toString() || "upstream closed"));
  upstream.on("error", error => { metrics.upstreamErrors++; metrics.lastError = String(error?.message || error); closeBoth(1011, "upstream error"); });
  client.on("message", (data, isBinary) => {
    const bytes = data.length ?? Buffer.byteLength(String(data));
    metrics.messagesClientToUpstream++;
    metrics.bytesClientToUpstream += bytes;
    metrics.lastClientMessageAt = new Date().toISOString();
    if (!sendUpstream(data, isBinary)) { pending.push({ data, isBinary }); metrics.queuedClientMessages = pending.length; }
  });
  client.on("close", (code, reason) => { closeBoth(code || 1000, reason?.toString() || "client closed"); metrics.activeClients = terminalWss.clients.size; });
  client.on("error", error => { metrics.lastError = String(error?.message || error); closeBoth(1011, "client error"); metrics.activeClients = terminalWss.clients.size; });
});

server.listen(PORT, HOST, () => {
  console.log(`terminal relay listening on ${HOST}:${PORT}`);
  console.log(`upstream ttyd: ${UPSTREAM}`);
  console.log(`noVNC HTTP: ${NOVNC_HTTP}`);
  console.log(`noVNC WS: ${NOVNC_WS}`);
  console.log("diagnostics: /healthz /healthz/ready");
});

function shutdown(signal) {
  console.log(`${signal}: shutting down relay`);
  for (const client of terminalWss.clients) client.close(1001, "relay shutting down");
  for (const client of novncWss.clients) client.close(1001, "relay shutting down");
  novncWss.close();
  terminalWss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Add, Apps, ClearAll, Code, ContentCopy, Dashboard, Folder, Fullscreen,
  GitHub, History, Menu as MenuIcon, MoreVert, OpenInNew, Refresh,
  Search, Settings, Terminal as TerminalIcon, Tune, Wifi, Close, VerticalSplit,
  Link as LinkIcon, LinkOff
} from "@mui/icons-material";
import {
  AppBar, Box, Chip, CssBaseline, Divider, Drawer, IconButton, InputBase,
  List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper,
  Stack, Tab, Tabs, TextField, ThemeProvider, Toolbar, Tooltip, Typography,
  createTheme, Button
} from "@mui/material";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const drawerWidth = 260;
const INPUT = 0x30;
const RESIZE = 0x31;
const OUTPUT = 0x30;
const TITLE = 0x31;
const PREFS = 0x32;

function SidebarItem({ icon, text, selected = false }) {
  return (
    <ListItemButton selected={selected} sx={{ borderRadius: 1.5, mb: 0.5, "&.Mui-selected": { bgcolor: "rgba(124,77,255,.15)", color: "primary.light" } }}>
      <ListItemIcon sx={{ minWidth: 40, color: "inherit" }}>{icon}</ListItemIcon>
      <ListItemText primary={text} primaryTypographyProps={{ fontSize: 14 }} />
    </ListItemButton>
  );
}

function parseConnection() {
  const params = new URLSearchParams(window.location.search);
  const endpoint = params.get("endpoint") || "";
  const token = params.get("token") || "";
  if (endpoint && token) return { endpoint, token };
  return { endpoint: "", token: "" };
}

function App() {
  const [dark, setDark] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [tabs, setTabs] = useState([{ id: 1, label: "bash", cwd: "runner", status: "offline" }]);
  const [activeTab, setActiveTab] = useState(1);
  const [search, setSearch] = useState("");
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [connection, setConnection] = useState(parseConnection);
  const [connectionInput, setConnectionInput] = useState("");
  const terminals = useRef(new Map());
  const sockets = useRef(new Map());
  const containers = useRef(new Map());

  const theme = useMemo(() => createTheme({
    palette: {
      mode: dark ? "dark" : "light",
      primary: { main: "#7c4dff" },
      secondary: { main: "#00bcd4" },
      background: dark ? { default: "#090b0f", paper: "#10141b" } : { default: "#f4f5f7", paper: "#ffffff" }
    },
    shape: { borderRadius: 12 },
    typography: { fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }
  }), [dark]);

  const active = tabs.find(t => t.id === activeTab) || tabs[0];

  const setStatus = useCallback((id, status) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, status } : t));
  }, []);

  const sendResize = useCallback((id) => {
    const ws = sockets.current.get(id);
    const term = terminals.current.get(id)?.term;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
    const payload = JSON.stringify({ columns: term.cols, rows: term.rows });
    const data = new Uint8Array(1 + payload.length);
    data[0] = RESIZE;
    data.set(new TextEncoder().encode(payload), 1);
    ws.send(data);
  }, []);

  const connectTab = useCallback((id, endpoint, token) => {
    const old = sockets.current.get(id);
    if (old && old.readyState < WebSocket.CLOSING) old.close(1000, "reconnect");
    if (!endpoint || !token) {
      setStatus(id, "offline");
      return;
    }

    let url;
    try {
      url = new URL(endpoint);
      url.searchParams.set("token", token);
      if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("WebSocket endpoint required");
    } catch {
      setStatus(id, "error");
      return;
    }

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    sockets.current.set(id, ws);
    setStatus(id, "connecting");

    ws.onopen = () => {
      setStatus(id, "online");
      const term = terminals.current.get(id)?.term;
      if (!term) return;
      const init = JSON.stringify({ columns: term.cols, rows: term.rows });
      ws.send(init);
    };

    ws.onmessage = event => {
      const term = terminals.current.get(id)?.term;
      if (!term) return;
      const bytes = typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
      if (!bytes.length) return;
      const type = bytes[0];
      const text = new TextDecoder().decode(bytes.slice(1));
      if (type === OUTPUT) term.write(text);
      else if (type === TITLE) document.title = text ? `${text} — Terminal` : "Terminal";
      else if (type === PREFS) {
        try { JSON.parse(text); } catch {}
      }
    };

    ws.onclose = () => {
      if (sockets.current.get(id) === ws) sockets.current.delete(id);
      setStatus(id, "offline");
    };
    ws.onerror = () => setStatus(id, "error");
  }, [setStatus]);

  const mountTerminal = useCallback((id, node) => {
    if (!node || terminals.current.has(id)) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 14,
      theme: dark ? { background: "#10141b" } : { background: "#ffffff" },
      scrollback: 5000,
      allowTransparency: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    fit.fit();

    const record = { term, fit, node };
    terminals.current.set(id, record);
    containers.current.set(id, node);

    term.onData(data => {
      const ws = sockets.current.get(id);
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const encoded = new TextEncoder().encode(data);
      const payload = new Uint8Array(1 + encoded.length);
      payload[0] = INPUT;
      payload.set(encoded, 1);
      ws.send(payload);
    });

    term.onResize(() => sendResize(id));
    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
      sendResize(id);
    });
    observer.observe(node);
    record.observer = observer;

    if (connection.endpoint && connection.token) connectTab(id, connection.endpoint, connection.token);
    else {
      term.writeln("\x1b[1;35mGitHub Hosted Terminal\x1b[0m");
      term.writeln("Waiting for a runner connection...");
      term.writeln("Open the Pages URL generated by the workflow, or connect below.");
      term.writeln("");
    }
  }, [connection, connectTab, dark, sendResize]);

  useEffect(() => () => {
    for (const ws of sockets.current.values()) ws.close();
    for (const record of terminals.current.values()) {
      record.observer?.disconnect();
      record.term.dispose();
    }
  }, []);

  useEffect(() => {
    for (const [id, record] of terminals.current) {
      record.term.options.theme = dark ? { background: "#10141b" } : { background: "#ffffff" };
      try { record.fit.fit(); } catch {}
    }
  }, [dark]);

  function addTab() {
    const id = Math.max(...tabs.map(t => t.id), 0) + 1;
    setTabs(prev => [...prev, { id, label: "bash", cwd: "runner", status: "offline" }]);
    setActiveTab(id);
  }

  function closeTab(id) {
    if (tabs.length === 1) return;
    sockets.current.get(id)?.close(1000, "tab closed");
    const record = terminals.current.get(id);
    record?.observer?.disconnect();
    record?.term.dispose();
    terminals.current.delete(id);
    containers.current.delete(id);
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTab === id) setActiveTab(remaining[remaining.length - 1].id);
  }

  function connectAll() {
    let raw = connectionInput.trim();
    if (!raw) return;
    try {
      const u = new URL(raw);
      const token = u.searchParams.get("token") || "";
      u.searchParams.delete("token");
      if (!token) throw new Error("missing token");
      const next = { endpoint: u.toString(), token };
      setConnection(next);
      window.history.replaceState({}, "", `${window.location.pathname}?endpoint=${encodeURIComponent(next.endpoint)}&token=${encodeURIComponent(token)}`);
      for (const tab of tabs) connectTab(tab.id, next.endpoint, next.token);
    } catch {
      setStatus(activeTab, "error");
    }
  }

  async function copyOutput() {
    const term = terminals.current.get(activeTab)?.term;
    try { await navigator.clipboard.writeText(term?.getSelection() || term?.getLine(0)?.translateToString?.() || ""); } catch {}
  }

  const visibleTabs = tabs;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        {!fullscreen && drawerOpen && (
          <Drawer variant="permanent" sx={{ width: drawerWidth, flexShrink: 0, "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box", borderRight: 1, borderColor: "divider" } }}>
            <Toolbar sx={{ gap: 1.2 }}><TerminalIcon color="primary" /><Typography fontWeight={700}>Terminal</Typography></Toolbar>
            <Divider />
            <Box sx={{ p: 1.25 }}>
              <SidebarItem icon={<Dashboard />} text="Dashboard" />
              <SidebarItem icon={<TerminalIcon />} text="Terminals" selected />
              <SidebarItem icon={<History />} text="History" />
              <SidebarItem icon={<Folder />} text="Files" />
              <SidebarItem icon={<Code />} text="Repositories" />
              <SidebarItem icon={<Apps />} text="Applications" />
              <Divider sx={{ my: 1 }} />
              <SidebarItem icon={<Settings />} text="Settings" />
              <SidebarItem icon={<Tune />} text="Preferences" />
            </Box>
          </Drawer>
        )}

        <Box component="main" sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <AppBar position="static" elevation={0} color="transparent" sx={{ borderBottom: 1, borderColor: "divider" }}>
            <Toolbar sx={{ gap: 1 }}>
              {(!drawerOpen || fullscreen) && <IconButton onClick={() => setDrawerOpen(true)}><MenuIcon /></IconButton>}
              <GitHub /><Typography fontWeight={700} sx={{ flex: 1 }}>terminal</Typography>
              <Chip size="small" icon={active?.status === "online" ? <LinkIcon /> : <LinkOff />} label={active?.status || "offline"} variant="outlined" color={active?.status === "online" ? "success" : "default"} />
              <Tooltip title="Refresh"><IconButton onClick={() => window.location.reload()}><Refresh /></IconButton></Tooltip>
              <Tooltip title="Theme"><IconButton onClick={() => setDark(v => !v)}><Settings /></IconButton></Tooltip>
              <Tooltip title="Open externally"><IconButton onClick={() => window.open(window.location.href, "_blank", "noopener,noreferrer")}><OpenInNew /></IconButton></Tooltip>
              <Tooltip title="Fullscreen"><IconButton onClick={() => { setFullscreen(v => !v); setDrawerOpen(false); }}><Fullscreen /></IconButton></Tooltip>
            </Toolbar>
          </AppBar>

          <Box sx={{ px: 1.25, pt: 1.25 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ borderBottom: 1, borderColor: "divider" }}>
              <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} variant="scrollable" scrollButtons="auto" sx={{ flex: 1 }}>
                {visibleTabs.map(tab => (
                  <Tab key={tab.id} value={tab.id} label={<Stack direction="row" alignItems="center" spacing={0.6}><TerminalIcon fontSize="small" /><span>{tab.label}</span>{tabs.length > 1 && <IconButton size="small" onClick={e => { e.stopPropagation(); closeTab(tab.id); }}><Close fontSize="inherit" /></IconButton>}</Stack>} />
                ))}
              </Tabs>
              <Tooltip title="New terminal"><IconButton onClick={addTab}><Add /></IconButton></Tooltip>
            </Stack>
          </Box>

          <Box sx={{ p: 1.25, display: "flex", alignItems: "center", gap: 1 }}>
            <Chip icon={<Wifi />} label={active?.cwd || "runner"} variant="outlined" />
            <Box sx={{ flex: 1 }} />
            <TextField size="small" placeholder="wss://.../ws?token=..." value={connectionInput} onChange={e => setConnectionInput(e.target.value)} onKeyDown={e => e.key === "Enter" && connectAll()} sx={{ minWidth: 360 }} />
            <Button variant="outlined" onClick={connectAll} startIcon={<LinkIcon />}>Connect</Button>
            <Tooltip title="Copy selection"><IconButton onClick={copyOutput}><ContentCopy /></IconButton></Tooltip>
            <Tooltip title="Clear"><IconButton onClick={() => terminals.current.get(activeTab)?.term.clear()}><ClearAll /></IconButton></Tooltip>
            <Tooltip title="More"><IconButton onClick={e => setMenuAnchor(e.currentTarget)}><MoreVert /></IconButton></Tooltip>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
              <MenuItem onClick={() => { setDark(v => !v); setMenuAnchor(null); }}>Toggle theme</MenuItem>
              <MenuItem onClick={() => { terminals.current.get(activeTab)?.term.clear(); setMenuAnchor(null); }}>Clear terminal</MenuItem>
            </Menu>
          </Box>

          <Paper square sx={{ mx: 1.25, mb: 1.25, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", border: 1, borderColor: "divider" }}>
            <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", display: "flex", alignItems: "center", gap: 1 }}>
              <Search fontSize="small" /><InputBase value={search} onChange={e => setSearch(e.target.value)} placeholder="Search terminal output..." sx={{ flex: 1, fontSize: 13 }} />
              <Chip size="small" label={active?.status === "online" ? "PTY" : "Waiting"} />
            </Box>
            <Box sx={{ flex: 1, minHeight: 0, p: 1.5, position: "relative", bgcolor: "background.paper" }}>
              {tabs.map(tab => <Box key={tab.id} ref={node => node && activeTab === tab.id && mountTerminal(tab.id, node)} sx={{ position: activeTab === tab.id ? "absolute" : "absolute", inset: 12, display: activeTab === tab.id ? "block" : "none" }} />)}
              {search && <Box sx={{ position: "absolute", top: 8, right: 12, fontSize: 12, opacity: 0.6 }}>Search is available through terminal/browser find (Ctrl+F).</Box>}
            </Box>
          </Paper>

          <Box sx={{ px: 2, py: 0.75, borderTop: 1, borderColor: "divider", display: "flex", gap: 2, fontSize: 12, color: "text.secondary" }}>
            <span>{active?.label || "bash"}</span><span>UTF-8</span><span>PTY</span><span>{active?.status || "offline"}</span>
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

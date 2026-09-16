import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Add, Apps, ClearAll, Code, ContentCopy, Dashboard, Folder, Fullscreen,
  GitHub, History, Menu as MenuIcon, MoreVert, OpenInNew, Refresh,
  Search, Settings, Terminal as TerminalIcon, Tune, Wifi, Close,
  ChevronLeft, VerticalSplit
} from "@mui/icons-material";
import {
  AppBar, Box, Chip, CssBaseline, Divider, Drawer, IconButton, InputBase,
  List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper,
  Stack, Tab, Tabs, TextField, ThemeProvider, Toolbar, Tooltip, Typography,
  createTheme
} from "@mui/material";
import "./styles.css";

const drawerWidth = 260;

function SidebarItem({ icon, text, selected = false }) {
  return (
    <ListItemButton
      selected={selected}
      sx={{
        borderRadius: 1.5,
        mb: 0.5,
        "&.Mui-selected": { bgcolor: "rgba(124,77,255,.15)", color: "primary.light" }
      }}
    >
      <ListItemIcon sx={{ minWidth: 40, color: "inherit" }}>{icon}</ListItemIcon>
      <ListItemText primary={text} primaryTypographyProps={{ fontSize: 14 }} />
    </ListItemButton>
  );
}

function App() {
  const [dark, setDark] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [tabs, setTabs] = useState([
    { id: 1, label: "bash", cwd: "~/project" },
    { id: 2, label: "zsh", cwd: "~/project" }
  ]);
  const [activeTab, setActiveTab] = useState(1);
  const [output, setOutput] = useState([
    "GitHub Terminal UI",
    "UI-only mode — browser simulation",
    "Type `help` to see available commands.",
    ""
  ]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [search, setSearch] = useState("");
  const [menuAnchor, setMenuAnchor] = useState(null);

  const theme = useMemo(() => createTheme({
    palette: {
      mode: dark ? "dark" : "light",
      primary: { main: "#7c4dff" },
      secondary: { main: "#00bcd4" },
      background: dark
        ? { default: "#090b0f", paper: "#10141b" }
        : { default: "#f4f5f7", paper: "#ffffff" }
    },
    shape: { borderRadius: 12 },
    typography: { fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }
  }), [dark]);

  const active = tabs.find(t => t.id === activeTab) || tabs[0];

  function runCommand(raw) {
    const cmd = raw.trim();
    if (!cmd) return;
    const nextHistory = [cmd, ...history.filter(x => x !== cmd)].slice(0, 50);
    setHistory(nextHistory);
    setHistoryIndex(-1);

    let lines;
    switch (cmd) {
      case "help":
        lines = [
          "Available commands:",
          "  help        Show this help message",
          "  ls          List files",
          "  pwd         Show current directory",
          "  whoami      Show current user",
          "  git status  Show Git status",
          "  clear       Clear terminal"
        ];
        break;
      case "ls":
        lines = ["src  package.json  vite.config.js  index.html  README.md"];
        break;
      case "pwd":
        lines = [active.cwd];
        break;
      case "whoami":
        lines = ["browser-user"];
        break;
      case "git status":
        lines = ["On branch main", "working tree simulated by UI mode", "nothing to commit"]; 
        break;
      case "clear":
        setOutput([]);
        setCommand("");
        return;
      default:
        lines = [`command not implemented in UI mode: ${cmd}`];
    }

    setOutput(prev => [...prev, `$ ${cmd}`, ...lines, ""]);
    setCommand("");
  }

  function onKeyDown(e) {
    if (e.key === "Enter") runCommand(command);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!history.length) return;
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setCommand(history[next]);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setCommand("");
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(history[next]);
    }
  }

  function addTab() {
    const id = Math.max(...tabs.map(t => t.id), 0) + 1;
    const shell = id % 2 ? "bash" : "zsh";
    setTabs(prev => [...prev, { id, label: shell, cwd: "~/project" }]);
    setActiveTab(id);
  }

  function closeTab(id) {
    if (tabs.length === 1) return;
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTab === id) setActiveTab(remaining[remaining.length - 1].id);
  }

  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(output.join("\n"));
    } catch {
      // Clipboard permission can be unavailable on some browsers.
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        {!fullscreen && drawerOpen && (
          <Drawer
            variant="permanent"
            sx={{
              width: drawerWidth,
              flexShrink: 0,
              "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box", borderRight: 1, borderColor: "divider" }
            }}
          >
            <Toolbar sx={{ gap: 1.2 }}>
              <TerminalIcon color="primary" />
              <Typography fontWeight={700}>Terminal</Typography>
            </Toolbar>
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
              {(!drawerOpen || fullscreen) && (
                <IconButton onClick={() => setDrawerOpen(true)}><MenuIcon /></IconButton>
              )}
              <GitHub />
              <Typography fontWeight={700} sx={{ flex: 1 }}>terminal</Typography>
              <Chip size="small" label="UI MODE" variant="outlined" />
              <Tooltip title="Refresh"><IconButton><Refresh /></IconButton></Tooltip>
              <Tooltip title="Theme"><IconButton onClick={() => setDark(v => !v)}><Settings /></IconButton></Tooltip>
              <Tooltip title="Open externally"><IconButton><OpenInNew /></IconButton></Tooltip>
              <Tooltip title="Fullscreen"><IconButton onClick={() => { setFullscreen(v => !v); setDrawerOpen(false); }}><Fullscreen /></IconButton></Tooltip>
            </Toolbar>
          </AppBar>

          <Box sx={{ px: 1.25, pt: 1.25 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ borderBottom: 1, borderColor: "divider" }}>
              <Tabs
                value={activeTab}
                onChange={(_, v) => setActiveTab(v)}
                variant="scrollable"
                scrollButtons="auto"
                sx={{ flex: 1 }}
              >
                {tabs.map(tab => (
                  <Tab
                    key={tab.id}
                    value={tab.id}
                    label={
                      <Stack direction="row" alignItems="center" spacing={0.6}>
                        <TerminalIcon fontSize="small" />
                        <span>{tab.label}</span>
                        {tabs.length > 1 && (
                          <IconButton size="small" onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>
                            <Close fontSize="inherit" />
                          </IconButton>
                        )}
                      </Stack>
                    }
                  />
                ))}
              </Tabs>
              <Tooltip title="New terminal"><IconButton onClick={addTab}><Add /></IconButton></Tooltip>
            </Stack>
          </Box>

          <Box sx={{ p: 1.25, display: "flex", alignItems: "center", gap: 1 }}>
            <Chip icon={<Wifi />} label={active?.cwd || "~/project"} variant="outlined" />
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Split"><IconButton><VerticalSplit /></IconButton></Tooltip>
            <Tooltip title="Copy"><IconButton onClick={copyOutput}><ContentCopy /></IconButton></Tooltip>
            <Tooltip title="Clear"><IconButton onClick={() => setOutput([])}><ClearAll /></IconButton></Tooltip>
            <Tooltip title="More"><IconButton onClick={e => setMenuAnchor(e.currentTarget)}><MoreVert /></IconButton></Tooltip>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
              <MenuItem onClick={() => { setDark(v => !v); setMenuAnchor(null); }}>Toggle theme</MenuItem>
              <MenuItem onClick={() => { setOutput([]); setMenuAnchor(null); }}>Clear terminal</MenuItem>
            </Menu>
          </Box>

          <Paper square sx={{ mx: 1.25, mb: 1.25, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", border: 1, borderColor: "divider" }}>
            <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", display: "flex", alignItems: "center", gap: 1 }}>
              <Search fontSize="small" />
              <InputBase
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search terminal output..."
                sx={{ flex: 1, fontSize: 13 }}
              />
              <Chip size="small" label={`${output.length} lines`} />
            </Box>

            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13.5 }}>
              {output
                .filter(line => !search || line.toLowerCase().includes(search.toLowerCase()))
                .map((line, i) => (
                  <Box key={`${line}-${i}`} sx={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}>{line}</Box>
                ))}
              <Stack direction="row" alignItems="center" sx={{ mt: 1 }}>
                <Typography component="span" sx={{ fontFamily: "inherit", mr: 1, color: "primary.main" }}>
                  {active?.label || "bash"} $ 
                </Typography>
                <TextField
                  variant="standard"
                  fullWidth
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  onKeyDown={onKeyDown}
                  InputProps={{ disableUnderline: true, sx: { fontFamily: "inherit", fontSize: "inherit" } }}
                  autoFocus
                />
              </Stack>
            </Box>
          </Paper>

          <Box sx={{ px: 2, py: 0.75, borderTop: 1, borderColor: "divider", display: "flex", gap: 2, fontSize: 12, color: "text.secondary" }}>
            <span>{active?.label || "bash"}</span>
            <span>UTF-8</span>
            <span>LF</span>
            <span>UI only</span>
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

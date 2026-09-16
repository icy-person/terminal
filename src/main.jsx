import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Add, Apps, ClearAll, Code, ContentCopy, Dashboard, Folder, Fullscreen,
  GitHub, History, Menu as MenuIcon, MoreVert, OpenInNew, Refresh,
  Search, Settings, SplitScreen, Terminal as TerminalIcon, Tune, Wifi, Close,
  ChevronLeft
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
  const [activeTab, setActiveTab] = useState(0);
  const [command, setCommand] = useState("");
  const [search, setSearch] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState(null);
  const [history, setHistory] = useState(["ls", "git status", "npm run dev", "cargo build", "clear"]);
  const [tabs, setTabs] = useState([
    { id: 1, title: "bash", path: "~/project", output: [
      "GitHub Terminal UI", "────────────────────────────────────────────", "",
      "Welcome to GitHub Terminal.", "", "This is currently a UI-only terminal.",
      "Commands are simulated.", "", "Type `help` to see available demo commands.", ""
    ]},
    { id: 2, title: "zsh", path: "~/workspace", output: ["zsh 5.9", "", "Workspace terminal ready.", ""] }
  ]);

  const theme = useMemo(() => createTheme({
    palette: {
      mode: dark ? "dark" : "light",
      primary: { main: "#7c4dff" },
      secondary: { main: "#00bcd4" },
      background: { default: dark ? "#090b0f" : "#f5f5f7", paper: dark ? "#101319" : "#ffffff" }
    },
    typography: { fontFamily: "Inter, Roboto, system-ui, -apple-system, BlinkMacSystemFont, sans-serif" },
    shape: { borderRadius: 10 },
    components: { MuiButton: { defaultProps: { disableRipple: true } }, MuiIconButton: { defaultProps: { size: "small" } } }
  }), [dark]);

  const currentTab = tabs[activeTab];

  function updateCurrentTerminal(output) {
    setTabs(prev => prev.map((tab, index) => index === activeTab ? { ...tab, output } : tab));
  }

  function addTerminal() {
    const newTab = { id: Date.now(), title: `bash-${tabs.length + 1}`, path: "~/", output: ["New terminal session", "", "UI-only shell initialized.", ""] };
    setTabs([...tabs, newTab]);
    setActiveTab(tabs.length);
  }

  function closeTerminal(index) {
    if (tabs.length === 1) return;
    const next = tabs.filter((_, i) => i !== index);
    setTabs(next);
    if (activeTab >= next.length) setActiveTab(next.length - 1);
    else if (index < activeTab) setActiveTab(activeTab - 1);
  }

  function executeCommand() {
    const value = command.trim();
    if (!value) return;
    let response;
    switch (value) {
      case "help": response = ["Available commands:", "", "  help        Show this message", "  ls          List files", "  pwd         Show current directory", "  whoami      Show current user", "  git status  Show git status", "  clear       Clear terminal", ""]; break;
      case "ls": response = ["src/", "public/", "package.json", "README.md", "vite.config.js", ""]; break;
      case "pwd": response = [currentTab.path, ""]; break;
      case "whoami": response = ["github-user", ""]; break;
      case "git status": response = ["On branch main", "Your branch is up to date with 'origin/main'.", "", "nothing to commit, working tree clean", ""]; break;
      case "clear": updateCurrentTerminal([]); setCommand(""); return;
      default: response = [`bash: ${value}: command not implemented in UI mode`, ""];
    }
    updateCurrentTerminal([...currentTab.output, `$ ${value}`, ...response]);
    setHistory([value, ...history.filter(x => x !== value)]);
    setCommand("");
  }

  function copyTerminal() {
    navigator.clipboard?.writeText(currentTab.output.join("\n"));
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ height: "100vh", width: "100vw", display: "flex", overflow: "hidden", bgcolor: "background.default" }}>
        {!fullscreen && (
          <Drawer variant="persistent" open={drawerOpen} sx={{ width: drawerOpen ? drawerWidth : 0, flexShrink: 0, "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box", bgcolor: "background.paper", borderRight: "1px solid", borderColor: "divider" } }}>
            <Toolbar sx={{ minHeight: "64px !important", justifyContent: "space-between" }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Box sx={{ width: 34, height: 34, borderRadius: 1.5, display: "grid", placeItems: "center", bgcolor: "primary.main" }}><TerminalIcon /></Box>
                <Typography fontWeight={700}>GitHub Terminal</Typography>
              </Stack>
              <IconButton onClick={() => setDrawerOpen(false)}><ChevronLeft /></IconButton>
            </Toolbar>
            <Divider />
            <Box sx={{ p: 1.5 }}>
              <TextField fullWidth size="small" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} InputProps={{ startAdornment: <Search sx={{ mr: 1, color: "text.secondary" }} /> }} />
            </Box>
            <List sx={{ px: 1 }}>
              <SidebarItem icon={<Dashboard />} text="Dashboard" />
              <SidebarItem icon={<TerminalIcon />} text="Terminals" selected />
              <SidebarItem icon={<History />} text="History" />
              <SidebarItem icon={<Folder />} text="Files" />
              <SidebarItem icon={<Code />} text="Repositories" />
              <SidebarItem icon={<Apps />} text="Applications" />
            </List>
            <Box sx={{ flex: 1 }} /><Divider />
            <List sx={{ px: 1 }}><SidebarItem icon={<Settings />} text="Settings" /><SidebarItem icon={<Tune />} text="Preferences" /></List>
            <Box sx={{ p: 2 }}><Paper variant="outlined" sx={{ p: 1.5, bgcolor: "transparent" }}><Stack direction="row" spacing={1} alignItems="center"><Wifi color="success" /><Box><Typography variant="caption" color="text.secondary">CONNECTION</Typography><Typography variant="body2">UI mode</Typography></Box></Stack></Paper></Box>
          </Drawer>
        )}

        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}>
            <Toolbar sx={{ minHeight: "64px !important", gap: 1 }}>
              {!drawerOpen && !fullscreen && <IconButton onClick={() => setDrawerOpen(true)}><MenuIcon /></IconButton>}
              <GitHub /><Typography variant="body1" fontWeight={600}>terminal</Typography><Chip label="UI MODE" size="small" color="secondary" variant="outlined" />
              <Box sx={{ flex: 1 }} />
              <Tooltip title="Refresh"><IconButton><Refresh /></IconButton></Tooltip>
              <Tooltip title="Settings"><IconButton onClick={e => setSettingsAnchor(e.currentTarget)}><Settings /></IconButton></Tooltip>
              <Tooltip title="Open externally"><IconButton><OpenInNew /></IconButton></Tooltip>
              <Tooltip title={fullscreen ? "Exit fullscreen" : "Fullscreen"}><IconButton onClick={() => setFullscreen(!fullscreen)}><Fullscreen /></IconButton></Tooltip>
              <Menu anchorEl={settingsAnchor} open={Boolean(settingsAnchor)} onClose={() => setSettingsAnchor(null)}>
                <MenuItem onClick={() => { setDark(!dark); setSettingsAnchor(null); }}>Toggle theme</MenuItem>
                <MenuItem onClick={() => setSettingsAnchor(null)}>Terminal preferences</MenuItem>
              </Menu>
            </Toolbar>
          </AppBar>

          <Box sx={{ height: 48, borderBottom: "1px solid", borderColor: "divider", display: "flex", alignItems: "center", bgcolor: "background.paper" }}>
            <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value)} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 48, "& .MuiTab-root": { minHeight: 48, textTransform: "none" } }}>
              {tabs.map((tab, index) => <Tab key={tab.id} label={<Stack direction="row" spacing={1} alignItems="center"><TerminalIcon sx={{ fontSize: 17 }} /><span>{tab.title}</span><Close sx={{ fontSize: 15, opacity: .6 }} onClick={e => { e.stopPropagation(); closeTerminal(index); }} /></Stack>} />)}
            </Tabs>
            <Tooltip title="New terminal"><IconButton sx={{ mx: 1 }} onClick={addTerminal}><Add /></IconButton></Tooltip>
          </Box>

          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Box sx={{ height: 44, px: 2, display: "flex", alignItems: "center", borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}>
              <Typography variant="caption" color="text.secondary">{currentTab.path}</Typography><Box sx={{ flex: 1 }} />
              <Tooltip title="Split terminal"><IconButton><SplitScreen /></IconButton></Tooltip>
              <Tooltip title="Copy"><IconButton onClick={copyTerminal}><ContentCopy /></IconButton></Tooltip>
              <Tooltip title="Clear"><IconButton onClick={() => updateCurrentTerminal([])}><ClearAll /></IconButton></Tooltip>
              <IconButton><MoreVert /></IconButton>
            </Box>

            <Box sx={{ flex: 1, minHeight: 0, p: { xs: 1.5, md: 2.5 }, overflow: "auto", bgcolor: dark ? "#080a0d" : "#fafafa", fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace", fontSize: 14 }}>
              {currentTab.output.map((line, index) => <Box key={index} sx={{ minHeight: line ? 22 : 11, whiteSpace: "pre-wrap", color: line.startsWith("$") ? "primary.light" : "text.primary" }}>{line || "\u00A0"}</Box>)}
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography component="span" sx={{ color: "success.main", fontFamily: "inherit", fontSize: "inherit" }}>github-user@github</Typography>
                <Typography component="span" sx={{ color: "info.main", fontFamily: "inherit", fontSize: "inherit" }}>:</Typography>
                <Typography component="span" sx={{ color: "warning.main", fontFamily: "inherit", fontSize: "inherit" }}>{currentTab.path}</Typography>
                <Typography component="span" sx={{ color: "text.primary", fontFamily: "inherit", fontSize: "inherit" }}>$</Typography>
                <InputBase autoFocus value={command} onChange={e => setCommand(e.target.value)} onKeyDown={e => { if (e.key === "Enter") executeCommand(); if (e.key === "ArrowUp" && history.length) setCommand(history[0]); }} sx={{ flex: 1, color: "text.primary", fontFamily: "inherit", fontSize: "inherit", "& input": { p: 0 } }} />
              </Box>
            </Box>

            <Box sx={{ height: 34, px: 1.5, display: "flex", alignItems: "center", borderTop: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}>
              <Stack direction="row" spacing={1.5}><Typography variant="caption" color="text.secondary">bash</Typography><Typography variant="caption" color="text.secondary">UTF-8</Typography><Typography variant="caption" color="text.secondary">LF</Typography></Stack>
              <Box sx={{ flex: 1 }} /><Typography variant="caption" color="text.secondary">UI only</Typography>
            </Box>
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);

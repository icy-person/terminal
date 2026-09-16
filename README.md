# GitHub Terminal UI

A Material UI terminal interface designed to run as a static frontend on GitHub Pages.

## Current status

UI-only prototype. Terminal commands are simulated in the browser; no real shell or backend is connected yet.

## Stack

- React
- Vite
- Material UI
- MUI Icons

## Features

- Multiple terminal tabs
- Sidebar navigation
- Command history
- Simulated shell commands
- Copy and clear controls
- Fullscreen mode
- Dark/light Material theme
- Responsive layout

## Development

```bash
npm install
npm run dev
```

Build for static hosting:

```bash
npm run build
```

The generated `dist/` directory can be deployed to GitHub Pages.

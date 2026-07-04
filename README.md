# TimeLens

TimeLens is a PixiJS + Vite frontend for exploring live WinDbg extension data, with a focus on TTD navigation, memory inspection, and PE/module analysis.

## Demo

A live, browser-only demo is hosted on GitHub Pages — no WinDbg or dk server required:

**https://long123king.github.io/TimeLens/**

The hosted demo is the same single-page app you build locally (`npm run build`); on first load it fetches the bundled storyline at `/storyline-1783155058679.storyline.json` (served from `public/`) and enters **storyline replay mode**. Use the always-visible REPLAY bar to step through the recorded actions (Prev / Next / Reset, plus Space / Shift+Space).

You can replay your own traces too: in the app, use the **Request Queue → Load Storyline…** button, or drag a `.storyline.json` file onto the page.

## Current Status

This repository is actively developed and usable for day-to-day debugging workflows.

### Stable UI Tabs

- Timeline
- Command
- Function Calls
- Page Memory (SVG + decoded content)
- Memory Layout
- PE
- Strings

### Incomplete / Hidden UI Tabs

- Environment (endpoint and component exist, tab currently hidden)
- Model (endpoint and component exist, tab currently hidden)

## Features

- TTD timeline with major:minor position support
- Thread-aware timeline interactions
  - Active-thread zoom shortcut
  - Range zoom via Shift + drag
- Memory Layout with typed regions (module, stack, heap, TEB, PEB)
- One-click module jump from Memory Layout to PE (View in PE)
- Page Memory tab with SVG rendering and page stepping
- PE structure view (headers, directories, imports/exports, relationship map)
- Function call search and timeline sync
- Command execution panel for WinDbg command round-trips
- String search view with limits and paging-friendly interactions

## Tech Stack

- Vite
- PixiJS
- Vanilla JavaScript (ES modules)

## Prerequisites

- Node.js 18+
- npm
- A running WinDbg-side HTTP server that exposes the routes listed below

## Backend Server (WinDbg Extension)

TimeLens frontend relies on the server-side WinDbg extension project:

- https://github.com/long123king/dk

### Server Setup in WinDbg

1. Load a TTD trace file.
2. Load the extension DLL:

```text
.load <path>\dk.dll
```

3. Start the HTTP server:

```text
!dk serve_start
```

### Platform Support

- x64 only (currently).

## Quick Start

```bash
npm install
npm run dev
```

Dev server default URL:

```text
http://localhost:5173
```

## Production Build

```bash
npm run build
npm run preview
```

## API Routes Used by Frontend

Base URL: `/api`

### Server / Session

- `GET /server/status`
- `GET /server/stop`

### TTD Metadata

- `GET /ttd/trace-info`
- `GET /ttd/modules`
- `GET /ttd/threads`

### Timeline / Memory / Registers

- `GET /events`
- `GET /memory`
- `GET /callstack`
- `GET /registers`
- `GET /page`
- `GET /page/svg`
- `GET /memory/layout`

### Analysis Views

- `GET /function-calls`
- `GET /command/execute`
- `GET /pe` (optional `imageBase` query)
- `GET /strings` (`q`, `limit`)

### Experimental (implemented in frontend, hidden in UI)

- `GET /environment`
- `GET /model`

## Repo Layout

```text
dk_visualize/
|- src/
|  |- api/
|  |- components/
|  |- core/
|  |- renderers/
|  |- styles/
|  `- utils/
|- index.html
|- vite.config.js
`- package.json
```

## Development Notes

- If the backend is unavailable, many views will show disconnected/error state.
- API requests use retry/timeout logic in `src/api/ApiClient.js`.
- Legacy/bridge fetching paths still exist in `src/core/DataManager.js` for timeline/page/register workflows.

## Open Source Readiness Checklist

- [x] MIT license in repository
- [x] Reproducible dev/build scripts in `package.json`
- [x] UI reflects currently stable tabs
- [x] README matches current feature status

## License

MIT

## Contributing

Contributions and issue reports are welcome.

Recommended first contributions:

1. Improve endpoint schema docs with concrete JSON examples per route.
2. Re-enable Environment/Model tabs after UX hardening and API stabilization.
3. Add screenshots/GIFs for each stable tab.

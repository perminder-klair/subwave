#!/usr/bin/env node
// Plain-JS launcher. Registers the tsx loader so the JSX modules under src/
// transform at import time — this keeps `node bin/subwave-tui.js` working with
// no separate build step. The launcher itself must stay JSX-free, since the
// loader is only active for imports that happen *after* register() runs.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.jsx');

// Admin-gated settings surface. This file is only the mount table; the handlers
// live in ./settings/, one module per concern.
import express from 'express';
import { router as coreRoutes } from './settings/core.js';
import { router as llmRoutes } from './settings/llm.js';
import { router as ttsRoutes } from './settings/tts.js';
import { router as stationRoutes } from './settings/station.js';
import { router as spotifyRoutes } from './settings/spotify.js';

export const router = express.Router();

// Mounted in order, though the paths are disjoint so order is only a matter of
// readability. Each sub-router owns one concern:
//
//   core.ts     the settings read/write surface + credential writes
//   llm.ts      provider probing and model discovery (read-only)
//   tts.ts      voice preview and the voice catalogue
//   station.ts  station actions: mixer, stream, themes, search probe
//   spotify.ts  the Spotify music source: credentials, OAuth connect, probe
router.use(coreRoutes);
router.use(llmRoutes);
router.use(ttsRoutes);
router.use(stationRoutes);
router.use(spotifyRoutes);


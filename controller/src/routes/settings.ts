// Admin-gated settings surface. This file is only the mount table; the handlers
// live in ./settings/, one module per concern.
import express from 'express';
import { router as coreRoutes } from './settings/core.js';
import { router as llmRoutes } from './settings/llm.js';
import { router as ttsRoutes } from './settings/tts.js';
import { router as stationRoutes } from './settings/station.js';

export const router = express.Router();

// Paths are disjoint, so mount order is readability only.
router.use(coreRoutes);
router.use(llmRoutes);
router.use(ttsRoutes);
router.use(stationRoutes);


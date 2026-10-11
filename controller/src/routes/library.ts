// Admin-gated music-library management surface. Route order stays explicit.
import express from 'express';
import { router as browseRoutes } from './library/browse.js';
import { router as scenesRoutes } from './library/scenes.js';
import { router as observatoryRoutes } from './library/observatory.js';
import { router as maintenanceRoutes } from './library/maintenance.js';
import { router as blocklistRoutes } from './library/blocklist.js';

export const router = express.Router();
router.use(browseRoutes);
router.use(scenesRoutes);
router.use(observatoryRoutes);
router.use(maintenanceRoutes);
router.use(blocklistRoutes);

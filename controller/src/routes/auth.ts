import express from 'express';
import { requireAdminUi } from '../middleware/auth.js';

export const router = express.Router();

// The web sign-in form owns the credential prompt. This endpoint deliberately
// returns a challenge-free 401 so the browser does not replace that form with
// its native HTTP Basic Auth dialog.
router.get('/admin-auth', requireAdminUi, (_req, res) => {
  res.status(204).end();
});

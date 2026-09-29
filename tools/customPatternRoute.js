/**
 * customPatternRoute.js
 * -------------------------------------------------------------------------
 * Accepts a custom SDK pattern as an uploaded .js FILE (multipart/form-data),
 * runs the same static checks as `validate-custom-pattern.js`, and — if it
 * passes — moves it into the live SDK folder under the given filename.
 *
 * Currently NO AUTH — anyone who can reach this endpoint can add a file to
 * the SDK folder if their code passes validation. That's fine for local/dev
 * testing; before this goes anywhere public-facing, put apiKeyGuard (or
 * equivalent) back in front of it — see the commented-out lines below.
 *
 * NOT wired into app.js automatically — mount it yourself:
 *
 *   const customPatternRouter = require('../tools/customPatternRoute');
 *   app.use('/custom-pattern', customPatternRouter);
 *
 * Postman request:
 *   POST http://localhost:8080/custom-pattern
 *   Body -> form-data:
 *     file        (File)   the .js pattern file
 *     filename    (Text)   e.g. "xylium-custom.js" — what it's saved as in the SDK folder
 *     description (Text)   what this pattern captures and why
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
// const apiKeyGuard = require('../src/middleware/apiKeyGuard'); // ← re-enable before going public
const { analyze } = require('./validate-custom-pattern');

const router = express.Router();

// Where the live SDK files are served from. Point this at the folder your
// static server / CDN actually serves — adjust for your deployment.
const SDK_DIR = process.env.XYLIUM_SDK_DIR || path.join(__dirname, '..', 'sdk');

// Accept the upload in memory (it's a small .js file, not a big binary) so
// we can run static analysis on its contents before anything touches disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 }, // 256kb is generous for a single pattern file
});

// Only allow a plain filename ("xylium-custom.js"), never a path — blocks
// "../../something" or an absolute path from writing outside SDK_DIR.
function sanitizeFilename(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base !== name.trim() || !/^[\w.-]+\.js$/i.test(base)) return null;
  return base;
}

router.post(
  '/',
  // apiKeyGuard,                 // ← re-enable before going public
  upload.single('file'),
  (req, res) => {
    const { description, filename } = req.body || {};

    if (!req.file) {
      return res.status(400).json({ error: 'invalid payload', details: 'Missing "file" (multipart/form-data, field name "file").' });
    }
    if (!description) {
      return res.status(400).json({ error: 'invalid payload', details: 'Missing "description".' });
    }
    if (!filename) {
      return res.status(400).json({ error: 'invalid payload', details: 'Missing "filename" (e.g. "xylium-custom.js").' });
    }
    const safeName = sanitizeFilename(filename);
    if (!safeName) {
      return res.status(400).json({
        error: 'invalid payload',
        details: 'filename must be a plain "name.js" — no paths, no "..", letters/digits/._- only.',
      });
    }

    const code = req.file.buffer.toString('utf8');
    const violations = analyze(code);

    if (violations.length > 0) {
      return res.status(422).json({
        accepted: false,
        filename: safeName,
        violations, // [{ rule, line, message }, ...]
      });
    }

    const header =
      `/* ============================================================================\n` +
      ` * ${safeName} — Custom pattern\n` +
      ` * ----------------------------------------------------------------------------\n` +
      ` * Description: ${description}\n` +
      ` * Reviewed: ${new Date().toISOString()} — no user-data capture detected\n` +
      ` *           by validate-custom-pattern.js (static AST checks).\n` +
      ` * ==========================================================================*/\n`;

    fs.mkdirSync(SDK_DIR, { recursive: true });
    const outPath = path.join(SDK_DIR, safeName);
    fs.writeFileSync(outPath, header + code);

    res.status(200).json({ accepted: true, filename: safeName, writtenTo: outPath });
  }
);

// multer errors (e.g. file too large) land here rather than the generic 500 handler.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'upload error', details: err.message });
  }
  next(err);
});

module.exports = router;

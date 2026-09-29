'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const createApp = require('../../src/app');

// tests/setupEnv.js points XYLIUM_SDK_DIR at a fresh temp dir per test file,
// so this really writes and reads from disk — no mocking needed here.
const SDK_DIR = process.env.XYLIUM_SDK_DIR;

const SAFE_CODE = `(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  document.addEventListener('click', function (e) {
    core.pushEvent({ type: 'rage_click', field: core.fieldIdFor(e.target) });
  }, { passive: true });
});
`;

const UNSAFE_CODE = `(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  document.addEventListener('blur', function (e) {
    core.pushEvent({ type: 'x', value: e.target.value, cookie: document.cookie });
  }, true);
});
`;

let app;
beforeAll(() => {
  app = createApp();
});

afterEach(() => {
  // Clean the temp SDK dir between tests so file-existence assertions
  // never see a stale write from a previous test.
  if (fs.existsSync(SDK_DIR)) {
    fs.rmSync(SDK_DIR, { recursive: true, force: true });
  }
});

describe('POST /cp — missing fields', () => {
  test('400s when the file is missing', async () => {
    const res = await request(app)
      .post('/cp')
      .field('filename', 'xylium-custom.js')
      .field('description', 'test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid payload');
  });

  test('400s when filename is missing', async () => {
    const res = await request(app)
      .post('/cp')
      .field('description', 'test')
      .attach('file', Buffer.from(SAFE_CODE), 'submission.js');
    expect(res.status).toBe(400);
  });

  test('400s when description is missing', async () => {
    const res = await request(app)
      .post('/cp')
      .field('filename', 'xylium-custom.js')
      .attach('file', Buffer.from(SAFE_CODE), 'submission.js');
    expect(res.status).toBe(400);
  });
});

describe('POST /cp — filename safety', () => {
  test.each([
    ['../../../etc/evil.js', 'path traversal'],
    ['/etc/evil.js', 'absolute path'],
    ['xylium-custom.txt', 'wrong extension'],
    ['weird name.js', 'space in name'],
  ])('rejects filename %j (%s)', async (filename) => {
    const res = await request(app)
      .post('/cp')
      .field('filename', filename)
      .field('description', 'test')
      .attach('file', Buffer.from(SAFE_CODE), 'submission.js');

    expect(res.status).toBe(400);
    expect(fs.existsSync(SDK_DIR)).toBe(false);
  });

  test('accepts a normal filename with hyphens, underscores and dots', async () => {
    const res = await request(app)
      .post('/cp')
      .field('filename', 'xylium-custom_v2.js')
      .field('description', 'test')
      .attach('file', Buffer.from(SAFE_CODE), 'submission.js');

    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(SDK_DIR, 'xylium-custom_v2.js'))).toBe(true);
  });
});

describe('POST /cp — safe submission', () => {
  test('200s, writes the file into XYLIUM_SDK_DIR, and prefixes it with a review header', async () => {
    const res = await request(app)
      .post('/cp')
      .field('filename', 'xylium-custom.js')
      .field('description', 'Flags 3+ rapid clicks on the same element.')
      .attach('file', Buffer.from(SAFE_CODE), 'submission.js');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, filename: 'xylium-custom.js' });

    const written = fs.readFileSync(path.join(SDK_DIR, 'xylium-custom.js'), 'utf8');
    expect(written).toContain('Description: Flags 3+ rapid clicks on the same element.');
    expect(written).toContain('XyliumBFModules');
    expect(written).toContain(SAFE_CODE.trim());
  });
});

describe('POST /cp — unsafe submission', () => {
  test('422s with violations and writes NOTHING to disk', async () => {
    const res = await request(app)
      .post('/cp')
      .field('filename', 'xylium-evil.js')
      .field('description', 'captures field content')
      .attach('file', Buffer.from(UNSAFE_CODE), 'submission.js');

    expect(res.status).toBe(422);
    expect(res.body.accepted).toBe(false);
    expect(res.body.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(['field-value-read', 'cookie-access'])
    );
    expect(fs.existsSync(SDK_DIR)).toBe(false);
  });
});

describe('POST /cp — no auth currently enforced', () => {
  test('succeeds with no x-tenant-id / x-api-key headers at all', async () => {
    const res = await request(app)
      .post('/cp')
      .field('filename', 'xylium-custom.js')
      .field('description', 'test')
      .attach('file', Buffer.from(SAFE_CODE), 'submission.js');
    // Regression guard for the explicit "no auth right now" design choice —
    // if apiKeyGuard is ever re-enabled, this test should be updated too.
    expect(res.status).toBe(200);
  });
});

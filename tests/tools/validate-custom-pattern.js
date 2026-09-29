#!/usr/bin/env node
/* ============================================================================
 * validate-custom-pattern.js
 * ----------------------------------------------------------------------------
 * Gatekeeper for user-submitted "custom pattern" modules.
 *
 * The Xylium SDK's whole design principle is: capture *behavioral metadata*
 * (timing, coordinates, key codes, field IDs) — never the actual content the
 * user typed, pasted, or has stored. This tool statically analyses a
 * submitted module's source code for the JS patterns that would break that
 * rule, and only allows the module through if none are found.
 *
 * Usage:
 *   node validate-custom-pattern.js <submission.js> \
 *     --name "rage_click"  \
 *     --description "Flags 3+ rapid clicks on the same element."
 *
 * Exit code 0 + writes ../xylium-custom.js  -> pattern ACCEPTED
 * Exit code 1, writes nothing               -> pattern REJECTED (violations printed)
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

// ---------------------------------------------------------------------------
// 1. Structural check: must be a self-registering module, same shape as
//    every built-in pattern file.
// ---------------------------------------------------------------------------
const MODULE_WRAPPER_RE =
  /\(window\.XyliumBFModules\s*=\s*window\.XyliumBFModules\s*\|\|\s*\[\]\)\.push\(\s*function\s*\(\s*core\s*\)\s*\{/;

// ---------------------------------------------------------------------------
// 2. User-data-capture rules. Each rule inspects the AST and pushes a
//    violation `{ rule, line, message }` when it fires. ANY violation blocks
//    the submission — this is deliberately strict, not a "score".
// ---------------------------------------------------------------------------
const FIELD_LIKE_NAMES = /^(target|el|elem|element|field|input|node|e|ev|evt)$/i;
const XYLIUM_KEY_RE = /^xylium_/;

// Recognisable PII shapes. Presence of a matching regex literal is treated
// as strong intent to extract PII, regardless of what it's used for.
const PII_REGEX_MARKERS = [
  /\\d\{3\}.{0,3}\\d\{2\}.{0,3}\\d\{4\}/, // SSN-shaped
  /\\d\{4\}.{0,3}\\d\{4\}.{0,3}\\d\{4\}.{0,3}\\d\{4\}/, // card-shaped
  /@.*\\\./, // email-shaped
];

function analyze(sourceCode) {
  const violations = [];

  if (!MODULE_WRAPPER_RE.test(sourceCode)) {
    violations.push({
      rule: 'structure',
      line: 1,
      message:
        'Submission is not wrapped as `(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) { ... });`. ' +
        'Every pattern file must self-register this way so load order stays independent.',
    });
  }

  let ast;
  try {
    ast = acorn.parse(sourceCode, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (e) {
    violations.push({ rule: 'syntax', line: e.loc ? e.loc.line : 1, message: `Not valid JavaScript: ${e.message}` });
    return violations; // can't walk a broken AST
  }

  function lineOf(node) {
    return sourceCode.slice(0, node.start).split('\n').length;
  }

  walk.simple(ast, {
    // Rule A: reading `.value` off anything field/element/event-shaped.
    // This is exactly how you'd read what the user actually typed/selected —
    // vs. the SDK's own pattern files, which only ever read timing, key
    // codes, and coordinates off the same events.
    MemberExpression(node) {
      if (
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'value'
      ) {
        const objName =
          node.object.type === 'Identifier'
            ? node.object.name
            : node.object.type === 'MemberExpression' && node.object.property.type === 'Identifier'
            ? node.object.property.name
            : null;
        if (!objName || FIELD_LIKE_NAMES.test(objName) || /target/i.test(sourceCode.slice(node.start - 20, node.start))) {
          violations.push({
            rule: 'field-value-read',
            line: lineOf(node),
            message: `Reads ".value" off "${objName || '<expr>'}" — this captures what the user actually typed/selected, not just behavior.`,
          });
        }
      }

      // Rule B: document.cookie (read or write).
      if (
        !node.computed &&
        node.object.type === 'Identifier' &&
        node.object.name === 'document' &&
        node.property.type === 'Identifier' &&
        node.property.name === 'cookie'
      ) {
        violations.push({ rule: 'cookie-access', line: lineOf(node), message: 'Accesses document.cookie.' });
      }

      // Rule C: innerText / textContent / innerHTML — rendered page content.
      if (
        !node.computed &&
        node.property.type === 'Identifier' &&
        ['innerText', 'textContent', 'innerHTML'].includes(node.property.name)
      ) {
        violations.push({
          rule: 'content-read',
          line: lineOf(node),
          message: `Reads "${node.property.name}" — captures rendered page/element content.`,
        });
      }

      // Rule D: InputEvent.data — the actual character(s) just typed.
      if (
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'data' &&
        /^(e|ev|evt|event)$/i.test(node.object.type === 'Identifier' ? node.object.name : '')
      ) {
        violations.push({
          rule: 'input-data-read',
          line: lineOf(node),
          message: 'Reads InputEvent.data — this is the literal character(s) the user typed.',
        });
      }
    },

    // Rule E: localStorage / sessionStorage access with a non-xylium key
    // (reading/writing the host site's own stored data instead of the
    // SDK's own namespaced keys).
    CallExpression(node) {
      const callee = node.callee;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        (callee.object.name === 'localStorage' || callee.object.name === 'sessionStorage') &&
        callee.property.type === 'Identifier' &&
        ['getItem', 'setItem'].includes(callee.property.name)
      ) {
        const keyArg = node.arguments[0];
        const literalKey = keyArg && keyArg.type === 'Literal' ? String(keyArg.value) : null;
        if (!literalKey || !XYLIUM_KEY_RE.test(literalKey)) {
          violations.push({
            rule: 'storage-access',
            line: lineOf(node),
            message: `${callee.object.name}.${callee.property.name}("${literalKey || '<dynamic key>'}") touches storage outside the SDK's own "xylium_" namespace.`,
          });
        }
      }

      // Rule F: clipboard content read (getData) — vs. the built-in
      // clipboard module, which only records that a copy/paste happened.
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'getData'
      ) {
        violations.push({ rule: 'clipboard-content-read', line: lineOf(node), message: 'Calls .getData(...) — reads actual clipboard content.' });
      }

      // Rule G: any network call that bypasses core.pushEvent/pushCriticalEvent
      // (own fetch/XHR/WebSocket/sendBeacon = an independent exfiltration path).
      const NETWORK_CALLEES = new Set(['fetch', 'XMLHttpRequest', 'WebSocket']);
      if (callee.type === 'Identifier' && NETWORK_CALLEES.has(callee.name)) {
        violations.push({ rule: 'bypass-transport', line: lineOf(node), message: `Calls ${callee.name}(...) directly instead of core.pushEvent/pushCriticalEvent — bypasses the vetted transport & consent gate.` });
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'navigator' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'sendBeacon'
      ) {
        violations.push({ rule: 'bypass-transport', line: lineOf(node), message: 'Calls navigator.sendBeacon(...) directly instead of going through core\'s transport.' });
      }
    },

    // Rule G continued: `new XMLHttpRequest()` / `new WebSocket(...)` are
    // NewExpression nodes, not CallExpression — acorn-walk treats `new Foo()`
    // and `Foo()` as distinct node types, so this needs its own visitor or
    // those two constructors would silently bypass the check above.
    NewExpression(node) {
      const callee = node.callee;
      const NETWORK_CTORS = new Set(['XMLHttpRequest', 'WebSocket']);
      if (callee.type === 'Identifier' && NETWORK_CTORS.has(callee.name)) {
        violations.push({
          rule: 'bypass-transport',
          line: lineOf(node),
          message: `Uses "new ${callee.name}(...)" directly instead of core.pushEvent/pushCriticalEvent — bypasses the vetted transport & consent gate.`,
        });
      }
    },

    // Rule H: PII-shaped regex literals anywhere in the module.
    Literal(node) {
      if (node.regex) {
        const pattern = node.regex.pattern;
        if (PII_REGEX_MARKERS.some((re) => re.test(pattern))) {
          violations.push({ rule: 'pii-regex', line: lineOf(node), message: `Regex /${pattern}/ matches the shape of PII (SSN/card/email) — looks intended to extract it.` });
        }
      }
    },
  });

  return violations;
}

// ---------------------------------------------------------------------------
// 3. CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--description') out.description = argv[++i];
    else if (a === '--author') out.author = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('Usage: node validate-custom-pattern.js <submission.js> --name "<id>" --description "<text>" [--author "<name>"] [--out <path>]');
    process.exit(2);
  }
  if (!args.name) {
    console.error('Missing required --name "<pattern_id>"');
    process.exit(2);
  }
  if (!args.description) {
    console.error('Missing required --description "<what this pattern captures and why>"');
    process.exit(2);
  }

  const source = fs.readFileSync(file, 'utf8');
  const violations = analyze(source);

  console.log(`\nXylium custom-pattern review: "${args.name}"`);
  console.log('='.repeat(60));

  if (violations.length > 0) {
    console.log(`REJECTED — ${violations.length} violation(s) found:\n`);
    violations.forEach((v, i) => {
      console.log(`  ${i + 1}. [${v.rule}] line ${v.line}: ${v.message}`);
    });
    console.log('\nThis pattern appears to capture actual user data (not just behavior),');
    console.log('so it was NOT added to the SDK. Remove the flagged code and resubmit.');
    process.exit(1);
  }

  console.log('ACCEPTED — no user-data capture detected. Behavior-only signals confirmed.\n');

  const outPath = args.out || path.join(__dirname, '..', 'xylium-custom.js');
  const header =
    `/* ============================================================================\n` +
    ` * xylium-custom.js — Custom pattern: ${args.name}\n` +
    ` * ----------------------------------------------------------------------------\n` +
    ` * Description: ${args.description}\n` +
    (args.author ? ` * Submitted by: ${args.author}\n` : '') +
    ` * Reviewed: ${new Date().toISOString()} — no user-data capture detected\n` +
    ` *           by validate-custom-pattern.js (static AST checks: field .value\n` +
    ` *           reads, document.cookie, innerText/innerHTML, InputEvent.data,\n` +
    ` *           non-namespaced storage access, clipboard content reads, PII-shaped\n` +
    ` *           regexes, and any transport call that bypasses core.pushEvent).\n` +
    ` *\n` +
    ` * Load order does not matter: this file self-registers with the core, same\n` +
    ` * as every other pattern file.\n` +
    ` * ==========================================================================*/\n`;

  fs.writeFileSync(outPath, header + source);
  console.log(`Written to: ${outPath}`);
  console.log('Add <script src="xylium-custom.js"></script> after xylium-core.js to enable it.');
  process.exit(0);
}

// Only run the CLI when this file is executed directly (`node validate-custom-pattern.js ...`).
// When required from other code (e.g. an Express route), `analyze()` and
// `MODULE_WRAPPER_RE` are exported below so the same checks can run over HTTP.
if (require.main === module) {
  main();
}

module.exports = { analyze, MODULE_WRAPPER_RE };

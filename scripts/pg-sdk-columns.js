#!/usr/bin/env node
'use strict';

/**
 * Compare the fields the SDK sends with the PostgreSQL column catalog.
 *
 *   npm run pg:columns                  report new / unused fields
 *   npm run pg:columns -- --sql         also print ALTER TABLE statements
 *   npm run pg:columns -- --markdown    print a column reference (for the ML team)
 *   npm run pg:columns -- --dir path/to/sdk
 *
 * The SDK files are parsed (acorn), not executed: every object literal passed
 * to pushEvent() / pushCriticalEvent() is read, including ones built in a
 * variable first. New fields are also added automatically at runtime; this
 * script is for keeping src/database/postgres/sdk-event-columns.js (and its
 * types) up to date in code review.
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { columnNameFor, ENVELOPE_SDK_KEYS } = require('../src/database/postgres/event-flattener');
const { SDK_COLUMNS, ENVELOPE_COLUMNS, EVENT_TABLES } = require('../src/database/postgres/sdk-event-columns');

// Object-valued / array-valued fields whose columns are spelled out in the
// catalog (dynamic-key objects are covered by runtime auto-columns).
const DYNAMIC_FIELDS = new Set(['props', 'untrustedByType']);

function literalString(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/** @returns {Map<string, Set<string>>} sdk field -> event types */
function scanSdk(dir) {
  const fields = new Map();
  const add = (field, type) => {
    if (!fields.has(field)) fields.set(field, new Set());
    fields.get(field).add(type);
  };

  for (const file of fs.readdirSync(dir).filter((f) => /^xylium-.*\.js$/.test(f)).sort()) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });

    // variable name -> object literal / extra keys assigned later (evt.x = ...)
    const objVars = new Map();
    walk.full(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) {
        let init = n.init;
        if (init.type === 'CallExpression' && init.callee.type === 'Identifier') {
          // var evt = buildX();  -> follow to `function buildX() { return {...} }`
          const fnName = init.callee.name;
          walk.full(ast, (f) => {
            if (f.type === 'FunctionDeclaration' && f.id && f.id.name === fnName) {
              walk.full(f.body, (r) => { if (r.type === 'ReturnStatement' && r.argument && r.argument.type === 'ObjectExpression') init = r.argument; });
            }
          });
        }
        if (init.type === 'ObjectExpression') {
          const prev = objVars.get(n.id.name) || [];
          objVars.set(n.id.name, [...prev, { obj: init, extra: [] }]);
        }
      }
    });
    walk.full(ast, (n) => {
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'Identifier' && !n.left.computed) {
        const list = objVars.get(n.left.object.name);
        if (list) for (const v of list) v.extra.push({ key: n.left.property.name, value: n.right });
      }
    });

    // Literal arrays iterated with forEach(function (evtName) { pushEvent({ type: evtName ... }) })
    const loopTypes = new Map(); // param name -> [types]
    walk.full(ast, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'forEach' &&
          n.callee.object.type === 'ArrayExpression' && n.arguments[0] && n.arguments[0].params && n.arguments[0].params[0]) {
        const types = n.callee.object.elements.map(literalString).filter(Boolean);
        if (types.length) loopTypes.set(n.arguments[0].params[0].name, types);
      }
    });

    walk.full(ast, (n) => {
      if (n.type !== 'CallExpression') return;
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? c.property.name : null;
      if (name !== 'pushEvent' && name !== 'pushCriticalEvent') return;
      const arg = n.arguments[0];
      if (!arg) return;

      const shapes = arg.type === 'ObjectExpression'
        ? [{ obj: arg, extra: [] }]
        : arg.type === 'Identifier' ? objVars.get(arg.name) || [] : [];
      if (!shapes.length) {
        console.warn(`! ${file}: could not resolve the event object passed to ${name}()`);
        return;
      }
      for (const { obj, extra } of shapes) {
        const props = obj.properties
          .filter((p) => p.type === 'Property')
          .map((p) => ({ key: p.key.name || p.key.value, value: p.value }))
          .concat(extra);
        const typeProp = props.find((p) => p.key === 'type');
        let types = ['<unknown>'];
        if (typeProp) {
          const lit = literalString(typeProp.value);
          if (lit) types = [lit];
          else if (typeProp.value.type === 'Identifier' && loopTypes.has(typeProp.value.name)) types = loopTypes.get(typeProp.value.name);
        }
        for (const p of props) {
          if (p.key === 'type' || ENVELOPE_SDK_KEYS.has(p.key)) continue;
          for (const t of types) add(p.key, t);
        }
      }
    });
  }
  return fields;
}

function diff(dir) {
  const fields = scanSdk(dir);
  const catalogRoots = new Map(); // top-level sdk key -> columns
  for (const [col, meta] of SDK_COLUMNS) {
    const root = meta.sdkPath.split('.')[0];
    if (!catalogRoots.has(root)) catalogRoots.set(root, []);
    catalogRoots.get(root).push(col);
  }
  const missing = [];
  for (const [field, types] of fields) {
    if (DYNAMIC_FIELDS.has(field) || catalogRoots.has(field)) continue;
    missing.push({ field, column: columnNameFor([field]), events: [...types].sort() });
  }
  const unused = [...catalogRoots.keys()].filter((root) => !fields.has(root)).sort();
  return { fields, missing, unused };
}

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dir = path.resolve(dirIdx >= 0 ? args[dirIdx + 1] : path.join(__dirname, '..', 'sdk'));
  const { fields, missing, unused } = diff(dir);
  const types = new Set([...fields.values()].flatMap((s) => [...s]));

  console.log(`SDK dir: ${dir}`);
  console.log(`Event types: ${types.size}   SDK fields: ${fields.size}   catalog columns: ${SDK_COLUMNS.size}`);
  if (!missing.length) console.log('OK: every SDK field has a column in the catalog.');
  else {
    console.log(`\n${missing.length} SDK field(s) not in the catalog (they will be auto-added at runtime with an inferred type):`);
    for (const m of missing) console.log(`  ${m.field.padEnd(28)} -> ${m.column.padEnd(30)} (${m.events.join(', ')})`);
    console.log('\nAdd them to SDK_FIELDS in src/database/postgres/sdk-event-columns.js with the right type.');
  }
  if (unused.length) console.log(`\nCatalog fields no longer sent by the SDK (columns are kept, values stay NULL): ${unused.join(', ')}`);

  if (args.includes('--sql') && missing.length) {
    console.log('\n-- Review the types before running:');
    for (const t of Object.values(EVENT_TABLES)) {
      for (const m of missing) console.log(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "${m.column}" TEXT;`);
    }
  }

  if (args.includes('--markdown')) {
    console.log('\n| column | type | SDK field | sent by event types |\n|---|---|---|---|');
    for (const [n, t, d] of ENVELOPE_COLUMNS) console.log(`| \`${n}\` | ${t.split(' ')[0]} | (envelope) | ${d} |`);
    for (const [col, m] of SDK_COLUMNS) {
      console.log(`| \`${col}\` | ${m.type}${m.list ? " (list, ' \\| ' separated)" : ''} | \`${m.sdkPath}\` | ${m.events} |`);
    }
  }
  process.exitCode = missing.length && args.includes('--strict') ? 1 : 0;
}

if (require.main === module) main();

module.exports = { scanSdk, diff };

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  STATIC_CLAUDE_MODELS,
  STATIC_CURSOR_MODELS,
  SOURCE_ENV,
  SOURCE_PROBE,
  SOURCE_STATIC,
  TIER_DEFAULTS,
  TIERS,
  detectHost,
  hostEnvNames,
  normalizeTier,
  pickFromList,
  probedModels,
  readCapabilities,
  resolveHostModel,
  resolveModel,
} from './host-capabilities.mjs';

const NO_ENV = {};

const cursorEnv = {
  CURSOR_AGENT: '1',
  CURSOR_CONVERSATION_ID: 'abc',
  PATH: '/usr/bin',
  HOME: '/Users/x',
};
const claudeEnv = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_PLUGIN_ROOT: '/p',
  PATH: '/usr/bin',
};

/** Probe file that saw a verified Cursor list and the Claude CLI. */
const fullCaps = {
  host: 'cursor',
  cursor: {
    models: ['inherit', 'composer-2.5', 'composer-2.5-fast', 'gpt-5.6-sol-medium'],
    source: 'agent --list-models',
    verified: true,
  },
  claude: {
    models: ['inherit', 'haiku', 'sonnet', 'opus'],
    source: 'claude cli aliases',
    verified: true,
  },
};

/** Probe ran but the agent CLI listed nothing: static fallback. */
const staticCaps = {
  host: 'cursor',
  cursor: {
    models: [...STATIC_CURSOR_MODELS],
    source: SOURCE_STATIC,
    verified: false,
  },
  claude: {
    models: [...STATIC_CLAUDE_MODELS],
    source: SOURCE_STATIC,
    verified: false,
  },
};

// ---------------------------------------------------------------------------
// detectHost / hostEnvNames
// ---------------------------------------------------------------------------

test('hostEnvNames returns matching names only, sorted, no values', () => {
  const names = hostEnvNames({
    ...cursorEnv,
    CLAUDE_CODE_SSE_PORT: '1',
    SECRET_TOKEN: 'x',
    ZZZ_CURSOR_: 'no',
  });
  assert.deepEqual(names, [
    'CLAUDE_CODE_SSE_PORT',
    'CURSOR_AGENT',
    'CURSOR_CONVERSATION_ID',
  ]);
  for (const n of names) assert.equal(typeof n, 'string');
});

test('detectHost recognises cursor, claude, unknown', () => {
  assert.equal(detectHost(cursorEnv), 'cursor');
  assert.equal(detectHost(claudeEnv), 'claude');
  assert.equal(detectHost({ PATH: '/bin' }), 'unknown');
  assert.equal(detectHost({ CLAUDECODE: '1' }), 'claude');
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: '/p' }), 'claude');
});

test('detectHost: claude markers beat inherited CURSOR_* vars', () => {
  assert.equal(detectHost({ ...cursorEnv, ...claudeEnv }), 'claude');
});

test('detectHost honours ST_HOST override', () => {
  assert.equal(detectHost({ ...cursorEnv, ST_HOST: 'claude' }), 'claude');
  assert.equal(detectHost({ ...claudeEnv, ST_HOST: 'Cursor' }), 'cursor');
  assert.equal(detectHost({ ST_HOST: 'bogus' }), 'unknown');
});

// ---------------------------------------------------------------------------
// readCapabilities
// ---------------------------------------------------------------------------

test('readCapabilities reads the probe file via ST_STATE_DIR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-caps-'));
  const env = { ST_STATE_DIR: root };
  assert.equal(readCapabilities({ env }), null, 'missing → null');
  const file = path.join(root, 'host', 'capabilities.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.equal(readCapabilities({ env }), null, 'corrupt → null');
  fs.writeFileSync(file, JSON.stringify(fullCaps));
  assert.deepEqual(readCapabilities({ env }), fullCaps);
  assert.deepEqual(readCapabilities({ path: file }), fullCaps);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// probedModels / pickFromList
// ---------------------------------------------------------------------------

test('probedModels trusts only verified, non-empty lists', () => {
  assert.deepEqual(probedModels(fullCaps, 'cursor'), fullCaps.cursor.models);
  assert.equal(probedModels(staticCaps, 'cursor'), null);
  assert.equal(probedModels(null, 'cursor'), null);
  assert.equal(probedModels({ cursor: { models: [] } }, 'cursor'), null);
  assert.equal(
    probedModels({ cursor: { models: ['a'], verified: false } }, 'cursor'),
    null,
  );
  assert.deepEqual(
    probedModels({ cursor: { models: ['a', 'a', 7, ''] } }, 'cursor'),
    ['a'],
    'dedupes and drops non-strings; missing verified flag is trusted',
  );
});

test('normalizeTier falls back to code', () => {
  for (const t of TIERS) assert.equal(normalizeTier(t), t);
  assert.equal(normalizeTier('nope'), 'code');
  assert.equal(normalizeTier(undefined), 'code');
});

test('pickFromList: tier default when present', () => {
  const list = ['inherit', 'composer-2.5', 'composer-2.5-fast'];
  assert.equal(pickFromList('mechanical', list, 'cursor'), 'composer-2.5-fast');
  assert.equal(pickFromList('code', list, 'cursor'), 'composer-2.5');
  assert.equal(pickFromList('reasoning', list, 'cursor'), 'inherit');
});

test('pickFromList mechanical: any *-fast, then composer-2.5, then inherit', () => {
  assert.equal(
    pickFromList('mechanical', ['inherit', 'grok-4.7-high-fast', 'composer-2.5'], 'cursor'),
    'grok-4.7-high-fast',
  );
  assert.equal(
    pickFromList('mechanical', ['zeta-fast', 'alpha-fast'], 'cursor'),
    'alpha-fast',
    'deterministic: sorted first',
  );
  assert.equal(
    pickFromList('mechanical', ['inherit', 'composer-2.5'], 'cursor'),
    'composer-2.5',
  );
  assert.equal(pickFromList('mechanical', ['inherit'], 'cursor'), 'inherit');
  assert.equal(pickFromList('mechanical', [], 'cursor'), 'inherit');
});

test('pickFromList code: composer-2.5 then inherit', () => {
  assert.equal(
    pickFromList('code', ['inherit', 'composer-2.5-fast', 'composer-2.5'], 'cursor'),
    'composer-2.5',
  );
  assert.equal(
    pickFromList('code', ['inherit', 'composer-2.5-fast'], 'cursor'),
    'inherit',
    'a fast slug is not a substitute for the code tier',
  );
});

test('pickFromList claude: alias ladder', () => {
  assert.equal(pickFromList('mechanical', ['sonnet', 'opus'], 'claude'), 'sonnet');
  assert.equal(pickFromList('code', ['haiku', 'opus'], 'claude'), 'opus');
  assert.equal(pickFromList('code', ['haiku'], 'claude'), 'haiku');
  assert.equal(pickFromList('code', ['inherit'], 'claude'), 'inherit');
  assert.equal(pickFromList('reasoning', ['haiku'], 'claude'), 'inherit');
});

// ---------------------------------------------------------------------------
// resolveHostModel — tier × host × caps × env matrix
// ---------------------------------------------------------------------------

for (const tier of TIERS) {
  for (const host of ['cursor', 'claude']) {
    test(`resolveHostModel ${tier}/${host}: no caps → static default, unverified`, () => {
      const r = resolveHostModel({ tier, host, caps: null, env: NO_ENV });
      assert.equal(r.model, TIER_DEFAULTS[tier][host]);
      assert.equal(r.verified, false);
      assert.equal(r.source, SOURCE_STATIC);
    });

    test(`resolveHostModel ${tier}/${host}: static-fallback caps → unverified`, () => {
      const r = resolveHostModel({ tier, host, caps: staticCaps, env: NO_ENV });
      assert.equal(r.model, TIER_DEFAULTS[tier][host]);
      assert.equal(r.verified, false);
      assert.equal(r.source, SOURCE_STATIC);
    });

    test(`resolveHostModel ${tier}/${host}: probed caps → verified`, () => {
      const r = resolveHostModel({ tier, host, caps: fullCaps, env: NO_ENV });
      assert.equal(r.model, TIER_DEFAULTS[tier][host]);
      assert.equal(r.verified, true);
      assert.equal(r.source, SOURCE_PROBE);
    });

    test(`resolveHostModel ${tier}/${host}: ST_SHARD_MODEL_<TIER> wins`, () => {
      const key = `ST_SHARD_MODEL_${tier.toUpperCase()}${host === 'claude' ? '_CLAUDE' : ''}`;
      const r = resolveHostModel({
        tier,
        host,
        caps: fullCaps,
        env: { [key]: ' custom-slug ' },
      });
      assert.equal(r.model, 'custom-slug');
      assert.equal(r.source, SOURCE_ENV);
      assert.equal(r.verified, false, 'override not in probe list');
    });
  }
}

test('env override is verified when the probe saw it', () => {
  const r = resolveHostModel({
    tier: 'code',
    host: 'cursor',
    caps: fullCaps,
    env: { ST_SHARD_MODEL_CODE: 'gpt-5.6-sol-medium' },
  });
  assert.deepEqual(r, {
    model: 'gpt-5.6-sol-medium',
    verified: true,
    source: SOURCE_ENV,
  });
  const inherit = resolveHostModel({
    tier: 'code',
    host: 'cursor',
    caps: fullCaps,
    env: { ST_SHARD_MODEL_CODE: 'inherit' },
  });
  assert.equal(inherit.verified, true, 'inherit is always accepted');
});

test('ST_WORKER_MODEL applies to the mechanical tier only', () => {
  const env = { ST_WORKER_MODEL: 'w-cursor', ST_WORKER_MODEL_CLAUDE: 'w-claude' };
  const mech = resolveModel({ tier: 'mechanical', env, caps: null });
  assert.equal(mech.model, 'w-cursor');
  assert.equal(mech.claudeModel, 'w-claude');
  assert.equal(mech.source, SOURCE_ENV);
  const code = resolveModel({ tier: 'code', env, caps: null, host: 'cursor' });
  assert.equal(code.model, TIER_DEFAULTS.code.cursor);
  assert.equal(code.source, SOURCE_STATIC);
});

test('ST_SHARD_MODEL_MECHANICAL beats ST_WORKER_MODEL', () => {
  const r = resolveHostModel({
    tier: 'mechanical',
    host: 'cursor',
    caps: null,
    env: { ST_WORKER_MODEL: 'worker', ST_SHARD_MODEL_MECHANICAL: 'shard' },
  });
  assert.equal(r.model, 'shard');
});

test('probe list without the tier default picks the closest slug', () => {
  const caps = {
    cursor: {
      models: ['inherit', 'grok-4.7-high-fast', 'gpt-5.6-sol-medium'],
      source: 'agent --list-models',
      verified: true,
    },
  };
  const mech = resolveHostModel({ tier: 'mechanical', host: 'cursor', caps, env: NO_ENV });
  assert.deepEqual(mech, { model: 'grok-4.7-high-fast', verified: true, source: SOURCE_PROBE });
  const code = resolveHostModel({ tier: 'code', host: 'cursor', caps, env: NO_ENV });
  assert.deepEqual(code, { model: 'inherit', verified: true, source: SOURCE_PROBE });
});

// ---------------------------------------------------------------------------
// resolveModel — host selection and combined verdict
// ---------------------------------------------------------------------------

test('resolveModel: host from arg, then caps.host, then env', () => {
  assert.equal(resolveModel({ host: 'claude', caps: fullCaps, env: NO_ENV }).host, 'claude');
  assert.equal(resolveModel({ caps: fullCaps, env: claudeEnv }).host, 'cursor', 'caps.host wins');
  assert.equal(resolveModel({ caps: null, env: claudeEnv }).host, 'claude');
  assert.equal(resolveModel({ caps: null, env: NO_ENV }).host, 'unknown');
});

test('resolveModel: verified/source follow the active host', () => {
  const caps = {
    ...fullCaps,
    claude: { models: [...STATIC_CLAUDE_MODELS], source: SOURCE_STATIC, verified: false },
  };
  const onCursor = resolveModel({ tier: 'code', host: 'cursor', caps, env: NO_ENV });
  assert.equal(onCursor.verified, true);
  assert.equal(onCursor.source, SOURCE_PROBE);
  assert.equal(onCursor.model, 'composer-2.5');
  assert.equal(onCursor.claudeModel, 'sonnet');

  const onClaude = resolveModel({ tier: 'code', host: 'claude', caps, env: NO_ENV });
  assert.equal(onClaude.verified, false);
  assert.equal(onClaude.source, SOURCE_STATIC);

  const unknown = resolveModel({ tier: 'code', host: 'unknown', caps, env: NO_ENV });
  assert.equal(unknown.verified, false, 'unknown host: both must be verified');
  assert.equal(resolveModel({ tier: 'code', host: 'unknown', caps: fullCaps, env: NO_ENV }).verified, true);
});

test('resolveModel with caps undefined reads the probe file from disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-caps-'));
  const file = path.join(root, 'host', 'capabilities.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...fullCaps,
      cursor: { models: ['inherit', 'only-fast'], source: 'agent --list-models', verified: true },
    }),
  );
  const r = resolveModel({ tier: 'mechanical', env: { ST_STATE_DIR: root } });
  assert.equal(r.model, 'only-fast');
  assert.equal(r.verified, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveModel exposes both per-host results and defaults tier to code', () => {
  const r = resolveModel({ caps: fullCaps, env: NO_ENV, host: 'cursor' });
  assert.equal(r.tier, 'code');
  assert.deepEqual(r.cursor, { model: 'composer-2.5', verified: true, source: SOURCE_PROBE });
  assert.deepEqual(r.claude, { model: 'sonnet', verified: true, source: SOURCE_PROBE });
});

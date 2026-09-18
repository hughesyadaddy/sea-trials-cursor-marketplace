import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundPackageSet,
  buildPackageGraph,
  parsePubspec,
  withDirectDependents,
} from './package-graph.mjs';

/** Build an injected io over an inline {dir: pubspecText} fixture. */
function makeIo(fixture) {
  return {
    listPackageDirs: () => Object.keys(fixture),
    readPubspec: (absPath) => {
      const dir = absPath
        .replace(/^\/flutter\//, '')
        .replace(/\/pubspec\.yaml$/, '');
      return fixture[dir] ?? null;
    },
  };
}

const graphOf = (fixture) =>
  buildPackageGraph({ flutterRoot: '/flutter', io: makeIo(fixture) });

// ---------------------------------------------------------------------
// parsePubspec
// ---------------------------------------------------------------------

test('reads bare, null-valued workspace dependencies', () => {
  // THE case this module exists for. 63 packages declare siblings this
  // way; a resolver keying off `path:` would see nothing at all.
  const { name, deps } = parsePubspec(
    [
      'name: app_ui',
      'resolution: workspace',
      'dependencies:',
      '  api_client:',
      '  app_logger:',
      '  auto_size_text: ^3.0.0',
      '  flutter:',
      '    sdk: flutter',
    ].join('\n'),
  );

  assert.equal(name, 'app_ui');
  assert.deepEqual(deps.sort(), [
    'api_client',
    'app_logger',
    'auto_size_text',
    'flutter',
  ]);
});

test('does not mistake nested entry config for dependencies', () => {
  // `sdk:` and `path:` are two levels in; treating them as dependency
  // names would invent packages that do not exist.
  const { deps } = parsePubspec(
    [
      'name: x',
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
      '  sea_trials_lints:',
      '    path: ../../packages/sea_trials_lints',
    ].join('\n'),
  );

  assert.deepEqual(deps.sort(), ['flutter', 'sea_trials_lints']);
  assert.equal(deps.includes('sdk'), false);
  assert.equal(deps.includes('path'), false);
});

test('includes dev_dependencies', () => {
  // A test-only dependency still means a change upstream can break this
  // package's tests, which is exactly what the test lane must catch.
  const { deps } = parsePubspec(
    ['name: x', 'dev_dependencies:', '  mocktail: ^1.0.0', '  test_helpers:'].join(
      '\n',
    ),
  );
  assert.deepEqual(deps.sort(), ['mocktail', 'test_helpers']);
});

test('stops collecting when a new top-level section starts', () => {
  const { deps } = parsePubspec(
    ['name: x', 'dependencies:', '  a:', 'flutter:', '  assets:', '    - x.png'].join(
      '\n',
    ),
  );
  assert.deepEqual(deps, ['a']);
});

test('ignores comments and blank lines', () => {
  const { name, deps } = parsePubspec(
    ['# leading comment', '', 'name: x', 'dependencies:', '  # note', '  a:'].join(
      '\n',
    ),
  );
  assert.equal(name, 'x');
  assert.deepEqual(deps, ['a']);
});

// ---------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------

test('maps packages whose name differs from their directory', () => {
  const graph = graphOf({
    'apps/client_app': 'name: sea_trials\ndependencies:\n  app_ui:\n',
    'packages/app_ui': 'name: app_ui\n',
  });

  assert.equal(graph.dirByName.get('sea_trials'), 'apps/client_app');
  assert.equal(graph.nameByDir.get('apps/client_app'), 'sea_trials');
  assert.deepEqual([...graph.dependentsByName.get('app_ui')], ['sea_trials']);
});

test('ignores dependencies that are not workspace packages', () => {
  const graph = graphOf({
    'packages/a': 'name: a\ndependencies:\n  http: ^1.0.0\n  b:\n',
    'packages/b': 'name: b\n',
  });

  assert.equal(graph.dependentsByName.has('http'), false);
  assert.deepEqual([...graph.dependentsByName.get('b')], ['a']);
});

test('skips packages with an unreadable or nameless pubspec', () => {
  const graph = graphOf({
    'packages/a': 'name: a\n',
    'packages/broken': 'dependencies:\n  a:\n',
  });
  assert.equal(graph.nameByDir.has('packages/broken'), false);
});

// ---------------------------------------------------------------------
// Dependent resolution
// ---------------------------------------------------------------------

const CHAIN = {
  'packages/l10n': 'name: l10n\n',
  'packages/app_ui': 'name: app_ui\ndependencies:\n  l10n:\n',
  'apps/client_app': 'name: client_app\ndependencies:\n  app_ui:\n',
};

test('includes the changed package and its direct dependents', () => {
  const graph = graphOf(CHAIN);
  const dirs = withDirectDependents({
    graph,
    changedPackageDirs: ['packages/l10n'],
  });
  assert.deepEqual(dirs, ['packages/app_ui', 'packages/l10n']);
});

test('excludes transitive dependents', () => {
  // Pins the direct-only decision. l10n -> app_ui -> client_app: the app
  // must NOT be pulled in, or a change to a low-level package would drag
  // in most of the workspace and defeat the scoping.
  const graph = graphOf(CHAIN);
  const dirs = withDirectDependents({
    graph,
    changedPackageDirs: ['packages/l10n'],
  });
  assert.equal(
    dirs.includes('apps/client_app'),
    false,
    'transitive dependent must be left to the whole-tree audit',
  );
});

test('survives a dependency cycle between a package and its test helper', () => {
  const graph = graphOf({
    'packages/a': 'name: a\ndev_dependencies:\n  a_test_helpers:\n',
    'packages/a_test_helpers': 'name: a_test_helpers\ndependencies:\n  a:\n',
  });

  const dirs = withDirectDependents({
    graph,
    changedPackageDirs: ['packages/a'],
  });
  assert.deepEqual(dirs, ['packages/a', 'packages/a_test_helpers']);
});

test('a package with no dependents resolves to just itself', () => {
  const graph = graphOf(CHAIN);
  assert.deepEqual(
    withDirectDependents({ graph, changedPackageDirs: ['apps/client_app'] }),
    ['apps/client_app'],
  );
});

test('an empty changed set yields an empty result', () => {
  const graph = graphOf(CHAIN);
  assert.deepEqual(withDirectDependents({ graph, changedPackageDirs: [] }), []);
});

test('deduplicates when two changed packages share a dependent', () => {
  const graph = graphOf({
    'packages/a': 'name: a\n',
    'packages/b': 'name: b\n',
    'packages/c': 'name: c\ndependencies:\n  a:\n  b:\n',
  });

  assert.deepEqual(
    withDirectDependents({
      graph,
      changedPackageDirs: ['packages/a', 'packages/b'],
    }),
    ['packages/a', 'packages/b', 'packages/c'],
  );
});

// ---------------------------------------------------------------------
// Regression guard against the empty-set failure mode
// ---------------------------------------------------------------------

test('a realistic workspace-style fixture resolves a non-empty dependent set', () => {
  // If this ever returns only the changed package, the resolver has
  // regressed to path:/object-valued matching and the test lane would
  // silently run nothing.
  const graph = graphOf({
    'packages/api_client': 'name: api_client\n',
    'packages/app_ui': [
      'name: app_ui',
      'resolution: workspace',
      'dependencies:',
      '  api_client:',
      '  flutter:',
      '    sdk: flutter',
      'dev_dependencies:',
      '  sea_trials_lints:',
      '    path: ../../packages/sea_trials_lints',
    ].join('\n'),
  });

  const dirs = withDirectDependents({
    graph,
    changedPackageDirs: ['packages/api_client'],
  });
  assert.ok(dirs.length > 1, 'dependent set must not be empty');
  assert.ok(dirs.includes('packages/app_ui'));
});

// ---------------------------------------------------------------------
// Bounded representative sampling
// ---------------------------------------------------------------------

test('a set at or under the limit is returned whole', () => {
  const graph = graphOf(CHAIN);
  const dirs = ['packages/l10n', 'packages/app_ui'];
  assert.deepEqual(boundPackageSet({ graph, packageDirs: dirs, limit: 5 }), [
    'packages/app_ui',
    'packages/l10n',
  ]);
});

test('an oversized set is trimmed to the most depended-on packages', () => {
  // Highest blast radius first: those carry the most signal per unit of
  // budget. l10n has a dependent, the leaf apps do not.
  const graph = graphOf({
    'packages/l10n': 'name: l10n\n',
    'packages/app_ui': 'name: app_ui\ndependencies:\n  l10n:\n',
    'apps/a': 'name: a\n',
    'apps/b': 'name: b\n',
  });

  const dirs = boundPackageSet({
    graph,
    packageDirs: ['apps/a', 'apps/b', 'packages/l10n', 'packages/app_ui'],
    limit: 2,
  });

  assert.equal(dirs.length, 2);
  assert.ok(dirs.includes('packages/l10n'), 'most depended-on must survive');
});

test('selection is deterministic across calls', () => {
  // A rerun must check the same packages, or a flaky lane looks like a
  // real regression.
  const graph = graphOf({
    'packages/a': 'name: a\n',
    'packages/b': 'name: b\n',
    'packages/c': 'name: c\n',
  });
  const args = { graph, packageDirs: ['packages/c', 'packages/a', 'packages/b'], limit: 2 };
  assert.deepEqual(boundPackageSet(args), boundPackageSet(args));
});

test('the bound deduplicates before trimming', () => {
  const graph = graphOf(CHAIN);
  const dirs = boundPackageSet({
    graph,
    packageDirs: ['packages/l10n', 'packages/l10n', 'packages/app_ui'],
    limit: 10,
  });
  assert.equal(new Set(dirs).size, dirs.length);
  assert.equal(dirs.length, 2);
});

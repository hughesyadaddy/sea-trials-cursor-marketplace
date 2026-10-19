#!/usr/bin/env node
/**
 * sprint-cards: plan, check, view and sync a sprint folder of cards.
 *
 *   node cli.mjs init <sprint-dir> [--project-key KEY] [--site URL] [--cloud-id ID]
 *                                  [--board N] [--sprint-id N] [--sprint-name NAME]
 *   node cli.mjs connect <sprint-dir> [same flags]   remember site/project/board/sprint
 *   node cli.mjs new <sprint-dir> epic|story|subtask --title T [--parent ID] [--points N] [--labels a,b]
 *   node cli.mjs ids <sprint-dir> [--dry-run]        stable local ids + index.json
 *   node cli.mjs number <sprint-dir> [--dry-run]     order, User Story N, N.M
 *   node cli.mjs lint <sprint-dir> [--json]          card-format check (exit 1 on errors)
 *   node cli.mjs manifest <sprint-dir>               rebuild compare/manifest.json
 *   node cli.mjs serve <sprint-dir> [--viewer DIR] [--port N]   start sprint-plan-viewer (git submodule) on this folder
 *   node cli.mjs auth status|login --email E|logout  the optional user key
 *   node cli.mjs discover [--project-key KEY] [--board N]   (user key) list projects, boards, sprints
 *   node cli.mjs pull <sprint-dir> [--epic KEY]... [--adopt] [--no-images]   GET-only resync
 *   node cli.mjs import-jira <sprint-dir> <issues.json> [--adopt] [--story-points-field ID] [--sprint-field ID]
 *                                  Jira copies from MCP issue JSON (search or getJiraIssue)
 *   node cli.mjs push <sprint-dir> [--apply] [--keys K,..] [--only create,update,transition,upload,sprint,rank]
 *                                  [--backlog] [--mcp-plan FILE] [--json] [--skip-lint]
 *   node cli.mjs record <sprint-dir> <local_id> --key KEY [--id N]   write back a key made through MCP
 *   node cli.mjs doctor <sprint-dir>
 *
 * Push is a dry run unless --apply is given. Pull never writes to Jira.
 * Credentials are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCard, parseCard } from './lib/frontmatter.mjs';
import { assignIds } from './lib/ids.mjs';
import { renumber } from './lib/numbering.mjs';
import { lintTree } from './lib/lint.mjs';
import { buildManifest } from './lib/manifest.mjs';
import { cardsRoot, loadTree, readIndex, writeJson, writeText } from './lib/tree.mjs';
import { keychainLogin, keychainLogout, maskEmail, normalizeSite, redact, resolveUserKey } from './lib/auth.mjs';
import { createClient } from './lib/jira.mjs';
import { importIssues, pull } from './lib/pull.mjs';
import { applyPush, describeOp, mcpPlan, planPush, recordKey } from './lib/push.mjs';
import { connectFields, init, newCard } from './lib/scaffold.mjs';
import { findViewer, runViewer } from './lib/viewer.mjs';

const BOOL = new Set(['apply', 'dry-run', 'json', 'adopt', 'no-images', 'backlog', 'skip-lint', 'help', 'open', 'yes']);

export function parseArgv(argv) {
  const out = { _: [], epic: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (BOOL.has(k)) out[k] = true;
      else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        if (k === 'epic') out.epic.push(v);
        else out[k] = v;
      }
    } else out._.push(a);
  }
  return out;
}

/** The sprint dir: the argument, or the current dir when it holds compare/. */
export function sprintDirArg(arg, cwd = process.cwd()) {
  if (arg) {
    const abs = path.resolve(cwd, arg);
    if (fs.existsSync(path.join(abs, 'compare')) || path.basename(abs) === 'compare') return abs;
    const alt = path.join(cwd, 'sprint_planning', arg);
    if (fs.existsSync(path.join(alt, 'compare'))) return alt;
    return abs;
  }
  if (fs.existsSync(path.join(cwd, 'compare'))) return cwd;
  const sp = path.join(cwd, 'sprint_planning');
  const found = fs.existsSync(sp) ? fs.readdirSync(sp).filter((n) => fs.existsSync(path.join(sp, n, 'compare'))) : [];
  throw new Error(`name the sprint folder${found.length ? `; found: ${found.map((n) => `sprint_planning/${n}`).join(', ')}` : ''}`);
}

function out(o, text, json) {
  process.stdout.write(o.json ? `${JSON.stringify(json, null, 2)}\n` : `${text}\n`);
}

function needKey(dir) {
  const key = resolveUserKey({ site: undefined, indexSite: dir ? readIndex(dir)?.jira?.site : null });
  if (!key.ok) {
    const e = new Error(`${key.reason}.\nThis command needs the user key (JIRA_EMAIL + JIRA_API_TOKEN, \`auth login\`, or ~/.jira-creds) and a site.\nWithout it, use the Atlassian MCP path described in the skill (push --mcp-plan, import-jira).`);
    e.code = 3;
    throw e;
  }
  const saved = dir ? readIndex(dir)?.jira?.site : null;
  if (saved && normalizeSite(saved) !== key.site) {
    throw new Error(`the user key is set up for ${key.site} but this sprint folder is for ${normalizeSite(saved)}; set JIRA_SITE to the folder's site or fix compare/index.json`);
  }
  return key;
}

function jiraFlags(a) {
  return { site: a.site, cloudId: a['cloud-id'], projectKey: a['project-key'], boardId: a.board, sprintId: a['sprint-id'], sprintName: a['sprint-name'] };
}

async function main(argv) {
  const a = parseArgv(argv);
  const cmd = a._[0];
  if (!cmd || a.help || cmd === 'help') {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    process.stdout.write(`${/\/\*\*([\s\S]*?)\*\//.exec(src)[1].replace(/^ \* ?/gm, '').trim()}\n`);
    return 0;
  }
  switch (cmd) {
    case 'init': {
      if (!a._[1]) throw new Error('init needs a folder, e.g. sprint_planning/<sprint-slug>');
      const r = init(a._[1], jiraFlags(a));
      out(a, `Sprint folder ready: ${r.dir}\nCreated: ${r.created.join(', ') || '(nothing new)'}\nJira: ${JSON.stringify(r.jira)}`, r);
      return 0;
    }
    case 'connect': {
      const dir = sprintDirArg(a._[1]);
      const idx = readIndex(dir) ?? { version: 2, items: {} };
      idx.jira = { ...(idx.jira ?? {}), ...connectFields(jiraFlags(a)) };
      writeJson(path.join(cardsRoot(dir), 'index.json'), idx);
      out(a, `Saved in compare/index.json: ${JSON.stringify(idx.jira)}`, idx.jira);
      return 0;
    }
    case 'new': {
      const dir = sprintDirArg(a._[1]);
      const r = newCard(dir, a._[2], { title: a.title, parent: a.parent, points: a.points ? Number(a.points) : undefined, labels: a.labels ? a.labels.split(',').map((s) => s.trim()).filter(Boolean) : [] });
      out(a, `Created ${a._[2]} ${r.local_id} at compare/${r.folder}`, r);
      return 0;
    }
    case 'ids': {
      const dir = sprintDirArg(a._[1]);
      const r = assignIds(dir, { dryRun: a['dry-run'] });
      const drop = r.dropped.length ? `\nNo longer in the folder (dropped from index.json; the Jira issues are not touched): ${r.dropped.map((d) => d.jira_key ?? d.local_id).join(', ')}` : '';
      out(a, `${a['dry-run'] ? 'Would change' : 'Changed'} ${r.changed.length} card(s). ${JSON.stringify(r.index.counts)}${drop}`, { changed: r.changed, counts: r.index.counts, dropped: r.dropped });
      return 0;
    }
    case 'number': {
      const dir = sprintDirArg(a._[1]);
      const tree = loadTree(dir);
      const changed = renumber(tree);
      if (!a['dry-run']) {
        for (const c of tree.all) {
          if (!changed.includes(c.folder) || !c.hasLocal) continue;
          const { body } = parseCard(fs.readFileSync(c.localPath, 'utf8'));
          writeText(c.localPath, renderCard(c.meta, body));
        }
        assignIds(dir);
      }
      out(a, `${a['dry-run'] ? 'Would renumber' : 'Renumbered'} ${changed.length} card(s)${changed.length ? `:\n  ${changed.join('\n  ')}` : ''}`, { changed });
      return 0;
    }
    case 'lint': {
      const dir = sprintDirArg(a._[1]);
      const tree = loadTree(dir);
      const idx = readIndex(dir) ?? {};
      const { problems } = lintTree(tree, { maxPoints: a['max-points'] ? Number(a['max-points']) : undefined, sprintName: idx.jira?.sprint_name ?? undefined });
      const errors = problems.filter((p) => p.severity !== 'warn');
      const lines = problems.map((p) => `${p.severity === 'warn' ? 'warn ' : 'error'} ${p.rule.padEnd(13)} compare/${p.folder ?? ''}${p.line ? `:${p.line}` : ''}  ${p.message}`);
      out(a, `${lines.join('\n')}${lines.length ? '\n' : ''}${tree.all.length} card(s), ${errors.length} error(s), ${problems.length - errors.length} warning(s).`, { cards: tree.all.length, errors: errors.length, problems });
      return errors.length ? 1 : 0;
    }
    case 'manifest': {
      const dir = sprintDirArg(a._[1]);
      const mf = buildManifest(dir);
      writeJson(path.join(cardsRoot(dir), 'manifest.json'), mf);
      out(a, `manifest.json: ${JSON.stringify(mf.counts)} changes ${JSON.stringify(mf.change_counts)}`, { counts: mf.counts, change_counts: mf.change_counts });
      return 0;
    }
    case 'serve': {
      const dir = sprintDirArg(a._[1]);
      assignIds(dir);
      const v = findViewer(dir, { viewer: a.viewer });
      if (!v) {
        const e = new Error('sprint-plan-viewer not found. Add it to the sprint planning repo as a git submodule (git submodule add <sprint-plan-viewer repo URL> sprint-plan-viewer, then git submodule update --init), or pass --viewer DIR / set SPRINT_PLAN_VIEWER.');
        e.code = 3;
        throw e;
      }
      process.stdout.write(`Viewer: ${v.dir}\nRunning: ${v.display}\n`);
      return runViewer(v, dir, { port: a.port });
    }
    case 'auth': {
      const sub = a._[1] ?? 'status';
      if (sub === 'status') {
        let dir = null;
        try {
          dir = sprintDirArg(a._[2]);
        } catch {
          dir = null; // no sprint folder here: env, keychain and creds file only
        }
        const k = resolveUserKey({ site: a.site, indexSite: dir ? readIndex(dir)?.jira?.site : null });
        const mode = k.ok ? 'user-key' : 'mcp';
        out(a, k.ok ? `Mode: user key (direct REST, full features)\nSource: ${k.source}\nEmail: ${maskEmail(k.email)}\nSite: ${k.site}` : `Mode: Atlassian MCP (OAuth).${k.source ? ` A user key was found (${k.source}) but there is no site, so it is not used: set JIRA_SITE, pass --site, or save the site with connect.` : ` ${k.reason}.`}\nAttachments, rank and sprint moves need the user key; see the skill.`, { mode, source: k.source ?? null, email: k.ok ? maskEmail(k.email) : null, site: k.site ?? null, reason: k.ok ? null : k.reason });
        return 0;
      }
      if (sub === 'login') {
        if (!a.email) throw new Error('auth login --email you@example.com (the keychain asks for the token)');
        const ok = keychainLogin(a.email);
        out(a, ok ? 'Saved in the OS keychain (service sprint-cards-jira).' : 'Could not save to the keychain on this OS; set JIRA_EMAIL and JIRA_API_TOKEN instead.', { ok });
        return ok ? 0 : 1;
      }
      if (sub === 'logout') {
        const ok = keychainLogout();
        out(a, ok ? 'Removed from the OS keychain.' : 'Nothing removed.', { ok });
        return 0;
      }
      throw new Error('auth status|login|logout');
    }
    case 'discover': {
      const key = needKey(null);
      const c = createClient(key.auth, { readOnly: true });
      const res = {};
      if (!a['project-key']) {
        const r = await c.get('/rest/api/3/project/search', { maxResults: 100 });
        res.projects = (r?.values ?? []).map((p) => ({ key: p.key, name: p.name, style: p.style }));
      } else if (!a.board) {
        const r = await c.get('/rest/agile/1.0/board', { projectKeyOrId: a['project-key'], maxResults: 50 });
        res.boards = (r?.values ?? []).map((b) => ({ id: b.id, name: b.name, type: b.type }));
      } else {
        const r = await c.get(`/rest/agile/1.0/board/${Number(a.board)}/sprint`, { state: 'active,future', maxResults: 50 });
        res.sprints = (r?.values ?? []).map((s) => ({ id: s.id, name: s.name, state: s.state }));
      }
      out(a, JSON.stringify(res, null, 2), res);
      return 0;
    }
    case 'pull': {
      const dir = sprintDirArg(a._[1]);
      const key = needKey(dir);
      const r = await pull(dir, { auth: key.auth, epics: a.epic, adopt: a.adopt, images: !a['no-images'] });
      out(a, `Pulled ${r.fetched} issue(s) (GET only, ${r.writes} writes). Jira copies: ${r.updated_copies}. Adopted: ${r.adopted.length}. In Jira but not here: ${r.unmatched_jira.length}. Here but not found: ${r.missing_in_jira.length}.`, r);
      return 0;
    }
    case 'import-jira': {
      const dir = sprintDirArg(a._[1]);
      if (!a._[2]) throw new Error('import-jira <sprint-dir> <issues.json>');
      const r = importIssues(dir, JSON.parse(fs.readFileSync(a._[2], 'utf8')), { storyPoints: a['story-points-field'], sprint: a['sprint-field'] }, { adopt: a.adopt });
      out(a, `Jira copies written: ${r.written.length}. Adopted as new local cards: ${r.adopted.length}. Not in this folder: ${r.unmatched.join(', ') || 'none'}${r.unmatched.length ? ' (use --adopt to add them)' : ''}.`, r);
      return 0;
    }
    case 'record': {
      const dir = sprintDirArg(a._[1]);
      if (!a._[2] || !a.key) throw new Error('record <sprint-dir> <local_id> --key KEY [--id N]');
      const card = recordKey(dir, a._[2], a.key, a.id);
      assignIds(dir);
      out(a, `Recorded ${a.key} on ${card.folder}`, { key: a.key, folder: card.folder });
      return 0;
    }
    case 'push': {
      const dir = sprintDirArg(a._[1]);
      assignIds(dir);
      const tree = loadTree(dir);
      const index = readIndex(dir) ?? {};
      const plan = planPush(tree, index, { keys: a.keys ? a.keys.split(',').map((s) => s.trim()) : null, only: a.only ? a.only.split(',').map((s) => s.trim()) : null, backlog: a.backlog });
      const lint = lintTree(tree, { sprintName: index.jira?.sprint_name ?? undefined }).problems.filter((p) => p.severity !== 'warn');
      if (a['mcp-plan']) {
        const mp = mcpPlan(plan, tree, index);
        writeJson(path.resolve(a['mcp-plan']), mp);
        out(a, `Wrote ${mp.steps.length} MCP step(s) to ${a['mcp-plan']}${mp.deferred_creates ? ` (${mp.deferred_creates} child create(s) wait for their parent keys: record them, then run this again)` : ''}. ${mp.steps.filter((s) => s.needs).length} step(s) need the user key.`, mp);
        return 0;
      }
      const lines = [
        `${a.apply ? 'APPLY' : 'DRY RUN'}: ${plan.ops.length} operation(s), ${plan.skipped.length} Done card(s) skipped.`,
        ...plan.ops.map((op, i) => `  ${String(i + 1).padStart(3)}. ${describeOp(op)}`),
        ...plan.problems.map((p) => `  note: ${p.folder ? `compare/${p.folder}: ` : ''}${p.message}`),
        ...(lint.length ? [`  lint: ${lint.length} error(s); run lint and fix them${a.apply && !a['skip-lint'] ? ' (push refused)' : ''}`] : []),
      ];
      if (!a.apply) {
        out(a, `${lines.join('\n')}\nNothing was sent to Jira. Re-run with --apply to write.`, { plan, lint_errors: lint.length });
        return 0;
      }
      if (lint.length && !a['skip-lint']) {
        out(a, lines.join('\n'), { plan, lint_errors: lint.length, refused: true });
        return 1;
      }
      const key = needKey(dir);
      if (!index.jira?.project_key && plan.ops.some((o) => o.op === 'create')) throw new Error('compare/index.json has no jira.project_key; run connect --project-key KEY first');
      process.stdout.write(`${lines.join('\n')}\nWriting to ${key.site} as ${maskEmail(key.email)}...\n`);
      const r = await applyPush(dir, plan, { auth: key.auth, log: (e) => { if (!a.json && e.kind) process.stdout.write(`  ${e.kind} ${e.key ?? e.local_id ?? ''}\n`); } });
      const bad = r.verify.filter((v) => !v.ok);
      out(a, `Done. created ${r.created.length}, updated ${r.updated.length}, transitions ${r.transitioned.length}, images ${r.uploaded.length}, sprint ${r.sprint.length}, rank ${r.ranked.length}, skipped ${r.skipped.length}, failed ${r.failed.length}. Read-back: ${r.verify.length - bad.length}/${r.verify.length} match.${bad.length ? `\nMismatch: ${bad.map((b) => `${b.key} (${b.diffs.join(',')})`).join(', ')}` : ''}${r.failed.length ? `\nFailed:\n${r.failed.map((f) => `  ${f.op} ${f.key ?? f.local_id}: ${f.reason}`).join('\n')}` : ''}\nLog: ${r.log}`, r);
      return r.failed.length ? 1 : 0;
    }
    case 'doctor': {
      const dir = sprintDirArg(a._[1]);
      const idx = readIndex(dir);
      const k = resolveUserKey({ indexSite: idx?.jira?.site });
      const major = Number(process.versions.node.split('.')[0]);
      const checks = [
        [major >= 20, `Node ${process.versions.node} (needs 20 or newer)`],
        [fs.existsSync(cardsRoot(dir)), `cards folder ${cardsRoot(dir)}`],
        [Boolean(idx), 'compare/index.json'],
        [Boolean(idx?.jira?.project_key), `project key: ${idx?.jira?.project_key ?? 'not set (connect --project-key)'}`],
        [Boolean(idx?.jira?.site || idx?.jira?.cloud_id), `site: ${idx?.jira?.site ?? idx?.jira?.cloud_id ?? 'not set (connect --site)'}`],
        [true, `sprint: ${idx?.jira?.sprint_name ?? 'not set'} (${idx?.jira?.sprint_id ?? 'no id'})`],
        [true, `Jira connection: ${k.ok ? `user key from ${k.source}` : 'Atlassian MCP (no user key)'}`],
      ];
      out(a, checks.map(([ok, t]) => `${ok ? 'ok  ' : 'FAIL'} ${t}`).join('\n'), { checks: checks.map(([ok, t]) => ({ ok, t })) });
      return checks.every(([ok]) => ok) ? 0 : 1;
    }
    default:
      throw new Error(`unknown command ${cmd}; run with --help`);
  }
}

function isMain() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`sprint-cards: ${redact(err.message)}\n`);
      process.exit(err.code === 3 ? 3 : 2);
    },
  );
}

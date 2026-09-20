'use strict';

/**
 * DSH profile config guard.
 *
 * A DSH boot loads exactly the plugin bundles its profile declares, so a single
 * bad plugin can stop the whole app from starting: the kernel either exits
 * before it prints its listening address, or wedges and never prints it at all.
 * The runtime keeps no memory of what the profile looked like when it last
 * worked, so the shell keeps that memory instead:
 *
 *   <userData>/profile-guard/last-good/         config that last booted
 *   <userData>/profile-guard/backups/<stamp>/   every config a recovery replaced
 *
 * After each successful boot the guard snapshots the files that decide the
 * plugin set (see {@link configEntries}). When a boot fails it names the likely
 * culprit — from the kernel's own diagnostics when it printed any, otherwise
 * from the diff against the snapshot — then puts the snapshot back, leaving the
 * broken config behind in a timestamped backup. {@link enterSafeMode} is the
 * last resort for a profile that never booted successfully: it drops every
 * third-party bundle and empties the profile's own patch layer.
 *
 * The guard only ever touches those config files. Sessions, credentials and
 * installed plugin trees are never modified or deleted, and nothing is ever
 * discarded without first being copied into a backup.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Config files inside the profile directory, in report order. */
const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];
/** Config files inside DSH_HOME itself (the machine-wide patch layer). */
const HOME_FILES = ['cordis.patch.yml'];
/** Bundles shipped by DSH itself; everything else is an out-of-tree plugin. */
const FIRST_PARTY_SCOPE = '@deepseek-ai/';
/** What a neutralized patch layer looks like (the documented empty list). */
const EMPTY_PATCH = '[]\n';
/** Timestamped backups kept before the oldest are pruned. */
const BACKUP_LIMIT = 20;
/** Cap on the config diff reported back in one outcome. */
const REPORT_LIMIT = 8;

// ─── small file helpers ──────────────────────────────────────────────────────

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** Filesystem-safe UTC stamp, also used as the backup directory name. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function dedupe(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}

/**
 * Strip the quoting a patch layer may use around a plugin id, e.g.
 * `<@scope/name>`, `'@scope/name'`.
 */
function normalizeId(raw) {
  return String(raw)
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

/** A plausible npm package name, used to filter stack-trace noise. */
function isPlausiblePackage(value) {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(value);
}

// ─── patch layer parsing ─────────────────────────────────────────────────────

/**
 * Map every `- id: <plugin>` row of a patch layer to that row's own text.
 * Enough YAML to compare patch layers and name their plugins — the guard only
 * rewrites or restores whole files, never individual rows, so a partial parse
 * can misreport but cannot mis-edit.
 */
function parsePatchEntries(text) {
  const entries = new Map();
  let id = null;
  let block = [];
  const flush = () => {
    if (id !== null && !entries.has(id)) entries.set(id, block.join('\n').trim());
    id = null;
    block = [];
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush();
      id = normalizeId(match[1]);
      block = [line];
      continue;
    }
    if (id !== null && /^\s*-\s+\S/.test(line)) flush();
    if (id !== null) block.push(line);
  }
  flush();
  return entries;
}

function patchIdsOf(files) {
  const ids = {};
  for (const [rel, text] of Object.entries(files)) {
    if (!rel.endsWith('cordis.patch.yml')) continue;
    ids[rel] = [...parsePatchEntries(text).keys()];
  }
  return ids;
}

function allPatchIds(patchIds) {
  return Object.values(patchIds ?? {}).flat();
}

function readProfileManifest(text) {
  if (text === null) return { bundles: [], dependencies: [], parsed: null };
  try {
    const parsed = JSON.parse(text);
    return {
      bundles: Array.isArray(parsed?.dsh?.profile?.bundles)
        ? parsed.dsh.profile.bundles.filter((value) => typeof value === 'string')
        : [],
      dependencies:
        parsed?.dependencies !== null && typeof parsed?.dependencies === 'object'
          ? Object.keys(parsed.dependencies)
          : [],
      parsed,
    };
  } catch {
    return { bundles: [], dependencies: [], parsed: null };
  }
}

// ─── failure attribution ─────────────────────────────────────────────────────

/**
 * Plugin ids the kernel itself named. Covers every way dsh-app-boot reports a
 * bad plugin: unresolvable bundles, entries that never activated, plugins whose
 * module failed to load, and the stacks of fatal late rejections.
 *
 * Each pattern is scanned in full rather than up to its first match: a stack
 * trace quotes the throwing source line, so the first hit is usually the
 * template literal (`cannot resolve profile bundle ${packageName}`) and only a
 * later one is the real diagnostic. Template placeholders are not plausible
 * package names, so scanning everything costs nothing and misses nothing.
 */
function pluginsFromOutput(output) {
  const text = String(output ?? '');
  const found = [];
  const push = (value) => {
    const id = normalizeId(value).split(/[\\/]/).slice(0, 2).join('/');
    if (isPlausiblePackage(id)) found.push(id);
  };
  const collect = (pattern, split) => {
    for (const match of text.matchAll(pattern)) {
      if (split === true) for (const name of match[1].split(',')) push(name);
      else push(match[1]);
    }
  };

  collect(/plugin\(s\) failed to load:\s*([^\n;]+)/g, true);
  collect(/cannot resolve profile bundle\s+"?([^"\n;]+)"?/g, false);
  // `failed to apply loader entry <row-id> (<package>): <error>` — the shape a
  // plugin that throws during activation produces.
  collect(/failed to apply loader entry [^(]*\(([^)]+)\)/g, false);

  for (const match of text.matchAll(/(\d+)\s+entr(?:y|ies) did not activate\n([\s\S]{0,4000})/g)) {
    for (const line of match[2].split('\n')) {
      const named = /^([^\s:][^:]*):\s+\S/.exec(line.trim());
      if (named !== null) push(named[1]);
    }
  }

  for (const match of text.matchAll(/node_modules[\\/]((?:@[^\\/\s"')]+[\\/])?[^\\/\s"')]+)/g)) {
    push(match[1].replace(/\\/g, '/'));
  }
  return dedupe(found);
}

/** Config files the kernel refused to parse — never a plugin, always a layer. */
function configFilesFromOutput(output) {
  const found = [];
  // The path may contain a colon of its own (`C:\...`), so the terminator is the
  // first colon *followed by whitespace*: `<file>: YAMLException: ...`.
  for (const match of String(output ?? '').matchAll(/failed to parse (?:overlay|config)\s+(.+?):\s/g)) {
    found.push(match[1].trim());
  }
  return dedupe(found);
}

/** The kernel lines that explain the failure, for the log and the dialog. */
function evidenceFromOutput(output) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /plugin\(s\) failed to load|plugin tree failed to load|failed to apply loader entry|did not activate|cannot resolve profile bundle|fatal load failure|failed to parse|host preparation failed/.test(
        line,
      ),
    )
    // Stack traces quote the throwing source line; its `${...}` placeholders are
    // noise in a dialog, and the real diagnostic line follows anyway.
    .filter((line) => !line.includes('${') && !line.startsWith('throw '));
  return dedupe(lines).slice(0, 4).map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line));
}

/**
 * Decide which plugin to blame: the kernel's own named plugins first, then what
 * changed in the profile since the last good boot, then raw log findings.
 */
function attributeCulprits({ output, changes, current, good }) {
  const known = new Set([
    ...current.bundles,
    ...current.dependencies,
    ...allPatchIds(current.patchIds),
    ...(good?.bundles ?? []),
    ...(good?.dependencies ?? []),
  ]);
  const fromLog = pluginsFromOutput(output);
  const fromDiff = dedupe([
    ...changes.addedBundles,
    ...changes.addedDependencies,
    ...changes.addedPatchIds,
    ...changes.modifiedPatchIds,
  ]);
  const matched = fromLog.filter((id) => known.has(id));
  const culprits = dedupe([...matched, ...fromDiff, ...fromLog]).slice(0, REPORT_LIMIT);
  return {
    culprits,
    configFiles: configFilesFromOutput(output),
    evidence: evidenceFromOutput(output),
    basis: fromLog.length === 0 ? 'diff' : fromDiff.length === 0 ? 'log' : 'mixed',
  };
}

// ─── manager ─────────────────────────────────────────────────────────────────

/**
 * @param options.dshHome - resolved DSH home (`$DSH_HOME`).
 * @param options.userDataDir - Electron user data directory.
 * @param options.profileName - profile the shell boots (`dsh web` → `web`).
 * @param options.log - line logger shared with the shell.
 */
function createProfileGuard({ dshHome, userDataDir, profileName = 'web', log = () => {} }) {
  const root = path.join(userDataDir, 'profile-guard');
  const goodDir = path.join(root, 'last-good');
  const backupsDir = path.join(root, 'backups');
  const manifestFile = path.join(goodDir, 'manifest.json');
  const filesDir = path.join(goodDir, 'files');

  const profileRel = path.posix.join('profiles', profileName);

  /** Every config file the guard owns, newest-first in report order. */
  function configEntries() {
    const entries = HOME_FILES.map((name) => ({
      rel: name,
      abs: path.join(dshHome, name),
      // A patch layer added since the snapshot is a prime boot-breaker, so
      // restoring may remove it. package.json/lockfiles are never removed.
      removable: true,
    }));
    for (const name of PROFILE_FILES) {
      entries.push({
        rel: path.posix.join(profileRel, name),
        abs: path.join(dshHome, profileRel, name),
        removable: name === 'cordis.patch.yml',
      });
    }
    return entries;
  }

  const profilePackageRel = path.posix.join(profileRel, 'package.json');
  const profilePatchRel = path.posix.join(profileRel, 'cordis.patch.yml');

  function entryFor(rel) {
    return configEntries().find((entry) => entry.rel === rel) ?? null;
  }

  /** Current on-disk config, as `{ rel: text }` for the files that exist. */
  function describeCurrent() {
    const files = {};
    for (const entry of configEntries()) {
      const text = readText(entry.abs);
      if (text !== null) files[entry.rel] = text;
    }
    const manifest = readProfileManifest(files[profilePackageRel] ?? null);
    return {
      files,
      bundles: manifest.bundles,
      dependencies: manifest.dependencies,
      patchIds: patchIdsOf(files),
    };
  }

  function readManifest() {
    const text = readText(manifestFile);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed?.files) ? parsed : null;
    } catch {
      return null;
    }
  }

  function readGoodText(rel) {
    return readText(path.join(filesDir, rel));
  }

  function hasSnapshot() {
    return readManifest() !== null;
  }

  /** Human-readable snapshot summary for the menu. */
  function describeSnapshot() {
    const manifest = readManifest();
    if (manifest === null) return '上次可用配置：（无）';
    const when = new Date(manifest.savedAt);
    return `上次可用配置 · ${Number.isNaN(when.getTime()) ? manifest.savedAt : when.toLocaleString()} · ${manifest.files.length} 个文件`;
  }

  function backupRoot() {
    return backupsDir;
  }

  /**
   * Copy every config file that exists right now into a timestamped backup.
   * Called before any recovery, so a recovery never destroys the state the user
   * was actually running with.
   */
  function backupCurrent(reason, detail) {
    const dir = path.join(backupsDir, stamp());
    const current = describeCurrent();
    for (const [rel, text] of Object.entries(current.files)) {
      writeText(path.join(dir, 'files', rel), text);
    }
    writeText(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          reason,
          detail,
          dshHome,
          profile: profileName,
          files: Object.keys(current.files),
          bundles: current.bundles,
          dependencies: current.dependencies,
          patchIds: current.patchIds,
        },
        null,
        2,
      )}\n`,
    );
    pruneBackups();
    return dir;
  }

  function pruneBackups() {
    try {
      const dirs = fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const name of dirs.slice(0, Math.max(0, dirs.length - BACKUP_LIMIT))) {
        fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
      }
    } catch {
      /* pruning is best effort */
    }
  }

  /** Compare the live config against the snapshot, plugin-level. */
  function diff() {
    const good = readManifest();
    if (good === null) return null;
    const current = describeCurrent();
    const changed = [];
    for (const rel of new Set([...good.files, ...Object.keys(current.files)])) {
      const before = readGoodText(rel);
      const after = current.files[rel] ?? null;
      if (before === after) continue;
      changed.push({ rel, before: before !== null, after: after !== null });
    }

    const addedPatchIds = [];
    const removedPatchIds = [];
    const modifiedPatchIds = [];
    for (const rel of Object.keys({ ...good.patchIds, ...current.patchIds })) {
      const before = parsePatchEntries(readGoodText(rel) ?? '');
      const after = parsePatchEntries(current.files[rel] ?? '');
      for (const [id, block] of after) {
        if (!before.has(id)) addedPatchIds.push(id);
        else if (before.get(id) !== block) modifiedPatchIds.push(id);
      }
      for (const id of before.keys()) if (!after.has(id)) removedPatchIds.push(id);
    }

    return {
      good,
      current,
      changed,
      addedBundles: current.bundles.filter((id) => !good.bundles.includes(id)),
      removedBundles: good.bundles.filter((id) => !current.bundles.includes(id)),
      addedDependencies: current.dependencies.filter((id) => !good.dependencies.includes(id)),
      removedDependencies: good.dependencies.filter((id) => !current.dependencies.includes(id)),
      addedPatchIds: dedupe(addedPatchIds),
      removedPatchIds: dedupe(removedPatchIds),
      modifiedPatchIds: dedupe(modifiedPatchIds),
    };
  }

  /** Write `files` into `dir` as a self-consistent snapshot. */
  function writeSnapshot(dir, files, manifest) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      writeText(path.join(tmp, 'files', rel), text);
    }
    writeText(path.join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(tmp, dir);
  }

  /**
   * Remember the config that just booted. Called on every successful boot, but
   * only writes when something actually changed, so `savedAt` keeps pointing at
   * the moment this exact config first worked.
   * @param options.keepExisting - never overwrite a snapshot (safe mode must not
   *   replace a richer known-good config with a reduced one).
   */
  function snapshot({ keepExisting = false } = {}) {
    const current = describeCurrent();
    const rels = Object.keys(current.files);
    if (rels.length === 0) return { saved: false, reason: 'no-config' };
    const existing = readManifest();
    if (keepExisting && existing !== null) return { saved: false, reason: 'kept' };
    if (existing !== null && existing.files.length === rels.length && rels.every((rel) => readGoodText(rel) === current.files[rel])) {
      return { saved: false, reason: 'unchanged', savedAt: existing.savedAt };
    }
    const savedAt = new Date().toISOString();
    writeSnapshot(goodDir, current.files, {
      savedAt,
      dshHome,
      profile: profileName,
      files: rels,
      bundles: current.bundles,
      dependencies: current.dependencies,
      patchIds: current.patchIds,
    });
    log(`profile-guard: snapshot saved (${rels.length} files, ${current.bundles.length} bundles)`);
    return { saved: true, savedAt, files: rels };
  }

  function outcomeBase(extra) {
    return { recovered: false, restored: [], removed: [], kept: [], ...extra };
  }

  /**
   * Restore the last known-good config over the live one.
   * @returns an outcome; `recovered: false` with a `reason` when there is
   *   nothing to restore (no snapshot, or a config identical to it).
   */
  function restoreLastGood({ output = '', detail = '' } = {}) {
    const changes = diff();
    if (changes === null) return outcomeBase({ reason: 'no-snapshot' });
    if (changes.changed.length === 0) return outcomeBase({ reason: 'unchanged' });

    const attribution = attributeCulprits({
      output,
      changes,
      current: changes.current,
      good: changes.good,
    });
    const backupDir = backupCurrent('restore-last-good', detail);

    const restored = [];
    const removed = [];
    const kept = [];
    for (const entry of configEntries()) {
      const before = readGoodText(entry.rel);
      const after = changes.current.files[entry.rel] ?? null;
      if (before === after) continue;
      if (before !== null) {
        writeText(entry.abs, before);
        restored.push(entry.rel);
      } else if (entry.removable) {
        fs.rmSync(entry.abs, { force: true });
        removed.push(entry.rel);
      } else {
        kept.push(entry.rel);
      }
    }

    log(
      `profile-guard: restored ${[...restored, ...removed].join(', ') || '(nothing)'} from snapshot ${changes.good.savedAt}`,
    );
    return {
      recovered: true,
      mode: 'snapshot',
      savedAt: changes.good.savedAt,
      backupDir,
      restored,
      removed,
      kept,
      changes,
      ...attribution,
    };
  }

  /**
   * Last resort for a profile that never booted successfully: keep only the
   * bundles DSH itself ships and empty the profile's own patch layer, so no
   * out-of-tree plugin can keep the app from starting.
   */
  function enterSafeMode({ output = '', detail = '' } = {}) {
    const current = describeCurrent();
    const manifest = readProfileManifest(current.files[profilePackageRel] ?? null);
    if (manifest.parsed === null) return outcomeBase({ reason: 'no-profile-manifest' });

    const keep = manifest.bundles.filter((id) => id.startsWith(FIRST_PARTY_SCOPE));
    const dropped = manifest.bundles.filter((id) => !id.startsWith(FIRST_PARTY_SCOPE));
    const patch = current.files[profilePatchRel] ?? null;
    const patchHasRows = parsePatchEntries(patch ?? '').size > 0;
    if (dropped.length === 0 && !patchHasRows) return outcomeBase({ reason: 'nothing-to-disable' });

    const backupDir = backupCurrent('safe-mode', detail);

    const restored = [];
    const removed = [];
    if (dropped.length > 0) {
      const next = {
        ...manifest.parsed,
        dsh: {
          ...manifest.parsed.dsh,
          profile: { ...manifest.parsed.dsh?.profile, bundles: keep },
        },
      };
      writeText(entryFor(profilePackageRel).abs, `${JSON.stringify(next, null, 2)}\n`);
      restored.push(profilePackageRel);
    }
    if (patchHasRows) {
      writeText(entryFor(profilePatchRel).abs, EMPTY_PATCH);
      restored.push(profilePatchRel);
    }

    log(`profile-guard: safe mode, disabled ${dropped.join(', ') || '(no bundles)'}; patch layer emptied=${patchHasRows}`);
    return {
      recovered: true,
      mode: 'safe-mode',
      backupDir,
      restored,
      removed,
      kept: [],
      disabled: dropped,
      configFiles: configFilesFromOutput(output),
      evidence: evidenceFromOutput(output),
      culprits: dropped.slice(0, REPORT_LIMIT),
      basis: dropped.length > 0 ? 'diff' : 'log',
    };
  }

  return {
    snapshot,
    diff,
    hasSnapshot,
    describeSnapshot,
    describeCurrent,
    restoreLastGood,
    enterSafeMode,
    backupRoot,
    root,
  };
}

module.exports = { createProfileGuard, parsePatchEntries, pluginsFromOutput, configFilesFromOutput };

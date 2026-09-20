/**
 * Tests for electron/profile-guard.js.
 *
 * Part 1 drives the guard directly against a throwaway DSH_HOME (nothing
 * outside .test-profile-guard/ is touched): snapshot, diff, rollback, safe mode,
 * and the backup guarantee.
 *
 * Part 2 boots the real DSH kernel against a deliberately broken isolated
 * profile and feeds its actual output back through the guard's attribution, so
 * the culprit patterns are checked against what the kernel really prints rather
 * than against what its source suggests it should print. Child output is
 * captured through a file descriptor, never a pipe.
 *
 *   node scripts/test-profile-guard.mjs [--offline]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProfileGuard, pluginsFromOutput } = require('../electron/profile-guard.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const sandbox = path.join(projectRoot, '.test-profile-guard');
const profileDir = path.join(sandbox, 'home', 'profiles', 'web');
const userDataDir = path.join(sandbox, 'userdata');

const OFFLINE = process.argv.includes('--offline');
const MISSING_BUNDLE = '@test-org/dsh-missing-plugin';
const BROKEN_BUNDLE = '@test-org/dsh-broken-plugin';

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function header(text) {
  console.log(`\n=== ${text} ===`);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const GOOD_PACKAGE = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: { '@anionex/dsh-vision-toolkit': '^0.1.45' },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@anionex/dsh-vision-toolkit'],
      patchReload: 'live',
    },
  },
};

function writeGoodProfile() {
  write(path.join(profileDir, 'package.json'), `${JSON.stringify(GOOD_PACKAGE, null, 2)}\n`);
  write(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
}

/** The shape a user's profile takes when they enable another plugin. */
function breakProfile() {
  const manifest = JSON.parse(JSON.stringify(GOOD_PACKAGE));
  manifest.dependencies[BROKEN_BUNDLE] = '^0.0.1';
  manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, BROKEN_BUNDLE];
  write(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  write(
    path.join(profileDir, 'cordis.patch.yml'),
    `# enabled by hand\n- id: <${BROKEN_BUNDLE}>\n  disabled: false\n`,
  );
}

function newGuard() {
  return createProfileGuard({
    dshHome: path.join(sandbox, 'home'),
    userDataDir,
    profileName: 'web',
    log: () => {},
  });
}

// ─── part 0: realistic kernel output ─────────────────────────────────────────

/**
 * Capture what the real kernel prints for two broken profiles. Returns the raw
 * output per case so the offline assertions run against real text.
 */
async function captureKernelOutput() {
  const nodeExe = path.join(projectRoot, 'runtime', 'node', 'node.exe');
  const dshBin = path.join(projectRoot, 'runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(nodeExe) || !fs.existsSync(dshBin)) {
    console.log('  skip runtime not present (run npm run prepare:runtime)');
    return { missing: null, broken: null };
  }

  async function run(label, prepare) {
    const home = path.join(sandbox, `boot-${label}`);
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    prepare(path.join(home, 'profiles', 'web'));
    const outFile = path.join(sandbox, `kernel-${label}.log`);
    const fd = fs.openSync(outFile, 'w');
    const child = spawn(nodeExe, [dshBin, 'web', '--port', '0', '--no-open'], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home },
      windowsHide: true,
      // A file descriptor, not a pipe: captured output without named pipes.
      stdio: ['ignore', fd, fd],
    });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
      }, 90000);
      child.on('exit', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    fs.closeSync(fd);
    const output = read(outFile) ?? '';
    console.log(`  ${label}: exit=${code} output=${output.length}B`);
    return output;
  }

  const missing = await run('missing', (dir) => {
    write(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', MISSING_BUNDLE] } } },
        null,
        2,
      )}\n`,
    );
    write(path.join(dir, 'cordis.patch.yml'), '[]\n');
  });

  const broken = await run('broken', (dir) => {
    // A bundle that is installed and loadable, but whose plugin throws while it
    // initializes — the shape of the vision-toolkit failure.
    const bundleDir = path.join(dir, 'node_modules', ...BROKEN_BUNDLE.split('/'));
    write(
      path.join(bundleDir, 'package.json'),
      `${JSON.stringify(
        {
          name: BROKEN_BUNDLE,
          version: '0.0.1',
          type: 'module',
          main: 'lib/index.js',
          exports: { './probe': './lib/probe.js', './package.json': './package.json' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        },
        null,
        2,
      )}\n`,
    );
    write(path.join(bundleDir, 'cordis.patch.yml'), `- insert:\n    - id: broken-probe\n      name: '${BROKEN_BUNDLE}/probe'\n`);
    write(
      path.join(bundleDir, 'lib', 'index.js'),
      `export default { name: 'broken-probe-bundle', apply() {} };\n`,
    );
    write(
      path.join(bundleDir, 'lib', 'probe.js'),
      `export default { name: 'broken-probe', apply() { throw new Error('probe: deliberate init failure'); } };\n`,
    );
    write(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-web',
          private: true,
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BROKEN_BUNDLE] } },
        },
        null,
        2,
      )}\n`,
    );
    write(path.join(dir, 'cordis.patch.yml'), '[]\n');
  });

  return { missing, broken };
}

// ─── main ────────────────────────────────────────────────────────────────────

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });
writeGoodProfile();

header('part 1 · snapshot of the config that booted');
const guard = newGuard();
check('no snapshot before the first boot', guard.hasSnapshot() === false);
const first = guard.snapshot();
check('snapshot written after a successful boot', first.saved === true, JSON.stringify(first));
check('snapshot counts the profile config', (first.files ?? []).length === 2, JSON.stringify(first.files));
const again = guard.snapshot();
check('unchanged config is not re-snapshotted', again.saved === false && again.reason === 'unchanged', JSON.stringify(again));
const savedAt = guard.diff().good.savedAt;
check('snapshot time is stable across boots', typeof savedAt === 'string' && savedAt.length > 0);

header('part 2 · a plugin added by hand');
breakProfile();
const brokenDiff = guard.diff();
check('package.json shows up as changed', brokenDiff.changed.some((e) => e.rel.endsWith('package.json')));
check('the new bundle is reported', brokenDiff.addedBundles.includes(BROKEN_BUNDLE), JSON.stringify(brokenDiff.addedBundles));
check('the new patch row is reported', brokenDiff.addedPatchIds.includes(BROKEN_BUNDLE), JSON.stringify(brokenDiff.addedPatchIds));

header('part 3 · rollback with real kernel output');
const real = await captureKernelOutput();
const realOutput = real.broken ?? '';
if (realOutput !== '') {
  check(
    'kernel names the broken plugin',
    pluginsFromOutput(realOutput).includes(BROKEN_BUNDLE),
    JSON.stringify(pluginsFromOutput(realOutput)),
  );
}

const outcome = guard.restoreLastGood({ output: realOutput, detail: 'test boot failure' });
check('rollback happened', outcome.recovered === true, JSON.stringify(outcome.reason));
check('package.json restored to the booted config', read(path.join(profileDir, 'package.json')) === `${JSON.stringify(GOOD_PACKAGE, null, 2)}\n`);
check('the added patch layer was removed', read(path.join(profileDir, 'cordis.patch.yml')) === '[]\n');
check('rollback names the culprit', outcome.culprits.includes(BROKEN_BUNDLE), JSON.stringify(outcome.culprits));
check('backup directory was created', fs.existsSync(outcome.backupDir));
check(
  'backup keeps the broken package.json',
  (read(path.join(outcome.backupDir, 'files', 'profiles', 'web', 'package.json')) ?? '').includes(BROKEN_BUNDLE),
);
check('nothing left to roll back afterwards', guard.diff().changed.length === 0);

const evidenceLines = outcome.evidence ?? [];
if (realOutput !== '') {
  check('evidence quotes the kernel, not its source line', evidenceLines.length > 0 && evidenceLines.every((line) => !line.includes('${')), JSON.stringify(evidenceLines));
}

header('part 4 · a wedged kernel prints nothing (diff-only attribution)');
breakProfile();
const silent = guard.restoreLastGood({ output: '', detail: '内核在 180 秒内没有报告监听地址' });
check('rollback happened without kernel output', silent.recovered === true);
check('attribution falls back to the diff', silent.basis === 'diff' && silent.culprits.includes(BROKEN_BUNDLE), JSON.stringify(silent.culprits));
check('profile is healthy again', guard.diff().changed.length === 0);

header('part 5 · a config file that no longer parses');
write(path.join(profileDir, 'cordis.patch.yml'), '[]\n- id: @anionex/dsh-vision-toolkit\n  disabled: true\n');
const parseOutcome = guard.restoreLastGood({
  output: "Error: dsh: failed to parse overlay C:\\home\\profiles\\web\\cordis.patch.yml: YAMLException: end of the stream",
  detail: 'kernel exited 1',
});
check('rollback happened for a parse error', parseOutcome.recovered === true);
check('the broken layer is named', parseOutcome.configFiles.some((f) => f.endsWith('cordis.patch.yml')), JSON.stringify(parseOutcome.configFiles));
check('patch layer restored', read(path.join(profileDir, 'cordis.patch.yml')) === '[]\n');

header('part 6 · safe mode when no snapshot exists');
const freshHome = path.join(sandbox, 'fresh');
write(
  path.join(freshHome, 'profiles', 'web', 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@anionex/dsh-vision-toolkit': '^0.1.45' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@anionex/dsh-vision-toolkit'] } },
    },
    null,
    2,
  )}\n`,
);
write(path.join(freshHome, 'profiles', 'web', 'cordis.patch.yml'), `- id: <@anionex/dsh-vision-toolkit>\n  disabled: false\n`);
const fresh = createProfileGuard({
  dshHome: freshHome,
  // Its own state directory: a guard must never see another home's snapshot.
  userDataDir: path.join(sandbox, 'fresh-userdata'),
  profileName: 'web',
  log: () => {},
});
check('no snapshot in a fresh home', fresh.hasSnapshot() === false);
check('plain rollback refuses without a snapshot', fresh.restoreLastGood({}).reason === 'no-snapshot');
const safe = fresh.enterSafeMode({ output: '', detail: 'boot timeout' });
check('safe mode engaged', safe.recovered === true && safe.mode === 'safe-mode', JSON.stringify(safe.reason));
check('third-party bundle disabled', safe.disabled.includes('@anionex/dsh-vision-toolkit'));
const safeManifest = JSON.parse(read(path.join(freshHome, 'profiles', 'web', 'package.json')));
check(
  'first-party bundles kept',
  JSON.stringify(safeManifest.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']),
  JSON.stringify(safeManifest.dsh.profile.bundles),
);
check('patch layer emptied', read(path.join(freshHome, 'profiles', 'web', 'cordis.patch.yml')) === '[]\n');
check(
  'safe mode backs the original up',
  (read(path.join(safe.backupDir, 'files', 'profiles', 'web', 'package.json')) ?? '').includes('@anionex/dsh-vision-toolkit'),
);
check('safe mode is idempotent-safe', fresh.enterSafeMode({}).reason === 'nothing-to-disable');

header('part 7 · backup retention');
const backupRoot = path.join(userDataDir, 'profile-guard', 'backups');
const backupDirs = fs.readdirSync(backupRoot);
check('every recovery left a backup', backupDirs.length === 3, `${backupDirs.length} backups`);
check(
  'backups record why they were taken',
  backupDirs.every((name) => (read(path.join(backupRoot, name, 'manifest.json')) ?? '').includes('"reason"')),
);

header('part 8 · real kernel: unresolvable bundle');
if (OFFLINE) {
  console.log('  skip --offline');
} else if (real.missing === null) {
  console.log('  skip runtime unavailable');
} else {
  check(
    'kernel names the unresolvable bundle',
    pluginsFromOutput(real.missing).includes(MISSING_BUNDLE),
    JSON.stringify(pluginsFromOutput(real.missing)),
  );
  check('kernel reports it as a bundle resolution failure', /cannot resolve profile bundle/.test(real.missing));
}

header('part 9 · real kernel: plugin that throws while loading');
if (OFFLINE) {
  console.log('  skip --offline');
} else if (real.broken === null) {
  console.log('  skip runtime unavailable');
} else {
  check(
    'kernel names the failing plugin in its diagnostics',
    pluginsFromOutput(real.broken).includes(BROKEN_BUNDLE),
    JSON.stringify(pluginsFromOutput(real.broken)),
  );
  check(
    'kernel says the entry did not activate (or failed to load)',
    /did not activate|failed to load|failed to apply loader entry|deliberate init failure/.test(real.broken),
  );
  check(
    'the dialog can quote the kernel reason',
    evidenceLines.some((line) => /plugin tree failed to load/.test(line)),
    JSON.stringify(evidenceLines),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (!process.argv.includes('--keep')) fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

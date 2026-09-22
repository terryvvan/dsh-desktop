'use strict';

/**
 * Renderer logic for the update progress window.
 *
 * Talks to the main process only through what `update-preload.js` exposes on
 * `window.dshUpdate`: one snapshot request, one action channel, and the state
 * and log pushes. The window owns no install state of its own — every number it
 * shows came from an `onProgress` event in the main process, so what is on
 * screen is what npm actually did.
 *
 * @module desktop/update-ui
 */

const api = window.dshUpdate;

const els = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  percent: document.getElementById('percent'),
  phaseLabel: document.getElementById('phaseLabel'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('barFill'),
  stats: document.getElementById('stats'),
  currentFile: document.getElementById('currentFile'),
  error: document.getElementById('error'),
  info: document.getElementById('info'),
  steps: document.getElementById('steps'),
  mirror: document.getElementById('mirror'),
  speedTest: document.getElementById('speedTest'),
  speedResults: document.getElementById('speedResults'),
  mirrorHint: document.getElementById('mirrorHint'),
  log: document.getElementById('log'),
  pause: document.getElementById('pause'),
  cancel: document.getElementById('cancel'),
  retry: document.getElementById('retry'),
  restart: document.getElementById('restart'),
  later: document.getElementById('later'),
  openLog: document.getElementById('openLog'),
  hint: document.getElementById('hint'),
  close: document.getElementById('close'),
};

let current = null;
let logLines = 0;

// ── formatting ──────────────────────────────────────────────────────────────

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond) {
  const speed = Number(bytesPerSecond);
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return `${formatBytes(speed)}/s`;
}

function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return null;
  if (total < 60) return `${Math.max(1, Math.round(total))} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = Math.round(total % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function formatElapsed(startedAt, endedAt) {
  if (startedAt === null || startedAt === undefined) return '';
  const end = endedAt === null || endedAt === undefined ? Date.now() : endedAt;
  const seconds = Math.max(0, (end - startedAt) / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

const STEP_LABELS = {
  resolve: '解析依赖树',
  plan: '探测下载体积',
  download: '下载 tarball',
  seed: '写入 npm 缓存',
  install: '离线安装',
  verify: '校验安装结果',
  activate: '切换到新版本',
};

// ── rendering ───────────────────────────────────────────────────────────────

function show(element, visible) {
  element.classList.toggle('hidden', !visible);
}

function renderSteps(steps) {
  // Rebuild only when the shape changes; otherwise just patch classes so the
  // elapsed-time column keeps ticking without the list flickering.
  if (els.steps.childElementCount !== steps.length) {
    els.steps.textContent = '';
    for (const step of steps) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = step.label ?? STEP_LABELS[step.phase] ?? step.phase;
      const when = document.createElement('span');
      when.className = 'when';
      li.append(dot, label, when);
      els.steps.append(li);
    }
  }
  steps.forEach((step, index) => {
    const li = els.steps.children[index];
    if (li === undefined) return;
    li.className = step.status ?? 'pending';
    const when = li.querySelector('.when');
    if (when !== null) when.textContent = formatElapsed(step.startedAt, step.endedAt);
  });
}

function renderStats(state) {
  const parts = [];
  if (state.phase === 'download' || state.bytes > 0) {
    const total = state.totalBytes > 0 ? formatBytes(state.totalBytes) : null;
    parts.push(total === null ? `已下载 ${formatBytes(state.bytes)}` : `${formatBytes(state.bytes)} / ${total}`);
  }
  if (state.totalFiles > 0) parts.push(`${state.files} / ${state.totalFiles} 个包`);
  const speed = formatSpeed(state.speed);
  if (speed !== null) parts.push(speed);
  const eta = formatDuration(state.etaSeconds);
  if (eta !== null && state.busy) parts.push(`剩余约 ${eta}`);
  const elapsed = formatDuration(state.elapsedSeconds);
  if (elapsed !== null && state.elapsedSeconds > 0) parts.push(`已用 ${elapsed}`);
  if (state.failed > 0) parts.push(`${state.failed} 个包重试中`);
  els.stats.textContent = parts.join(' · ');
}

function renderProgress(state) {
  const percent = Number(state.percent);
  const determinate =
    state.phase === 'download' && Number.isFinite(percent) && percent !== null && state.totalBytes > 0;
  els.bar.classList.toggle('indeterminate', state.busy && !determinate);
  if (determinate) {
    els.barFill.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
    els.percent.textContent = `${percent.toFixed(1)}%`;
  } else if (state.finished && state.ready) {
    els.bar.classList.remove('indeterminate');
    els.barFill.style.width = '100%';
    els.percent.textContent = '完成';
  } else {
    els.percent.textContent = state.busy ? '…' : '—';
  }
  els.phaseLabel.textContent = state.phaseLabel ?? '准备中';
  els.currentFile.textContent = state.current === null || state.current === undefined ? '' : state.current;
  els.currentFile.title = els.currentFile.textContent;
}

function renderButtons(state) {
  show(els.pause, state.busy);
  els.pause.textContent = state.paused ? '继续' : '暂停';
  show(els.cancel, state.busy);
  show(els.retry, state.finished && !state.ready);
  show(els.restart, state.finished && state.ready);
  show(els.later, state.finished && state.ready);
  show(els.openLog, state.finished && !state.ready);
  els.speedTest.disabled = state.speedTest?.running === true;

  if (state.busy) {
    els.hint.textContent = state.paused ? '已暂停；已下载的部分不会丢失。' : '可最小化窗口，安装会继续。';
  } else if (state.ready) {
    els.hint.textContent = '重启内核后新版本生效。';
  } else if (state.finished) {
    els.hint.textContent = '重试会用到已下载的内容，不会从头开始。';
  } else {
    els.hint.textContent = '';
  }
}

function renderNotices(state) {
  if (state.error !== null && state.error !== undefined && state.error !== '') {
    els.error.textContent = state.error;
    show(els.error, true);
  } else {
    show(els.error, false);
  }
  if (state.finished && state.ready) {
    els.info.textContent = `DSH ${state.version ?? ''} 已下载并校验完成，重启内核后生效。`;
    show(els.info, true);
  } else if (state.cancelled === true && state.finished) {
    els.info.textContent = '已取消。已下载的内容保留在本机，点「重试」会从断点继续。';
    show(els.info, true);
  } else {
    show(els.info, false);
  }
  els.title.textContent = state.version === null ? 'DSH 更新' : `正在更新到 DSH ${state.version}`;
  const bits = [];
  if (state.channel !== null && state.channel !== undefined) bits.push(`通道 ${state.channel}`);
  if (state.registry !== null && state.registry !== undefined) bits.push(`镜像 ${state.registry}`);
  else if (state.registryId !== null && state.registryId !== undefined) bits.push(`镜像 ${state.registryId}`);
  if (state.finished && state.ready) bits.push('已完成');
  els.subtitle.textContent = bits.length === 0 ? '准备中…' : bits.join(' · ');
}

function renderMirrors(state) {
  const mirrors = Array.isArray(state.mirrors) ? state.mirrors : [];
  if (els.mirror.options.length !== mirrors.length) {
    els.mirror.textContent = '';
    for (const mirror of mirrors) {
      const option = document.createElement('option');
      option.value = mirror.id;
      option.textContent = mirror.hint === undefined ? mirror.label : `${mirror.label} — ${mirror.hint}`;
      els.mirror.append(option);
    }
  }
  if (state.registryId !== null && state.registryId !== undefined) els.mirror.value = state.registryId;
  els.mirror.disabled = state.busy === true;
  els.mirrorHint.textContent = state.busy
    ? '当前任务正在使用启动时选定的镜像；切换会在下一次重试或检查更新时生效。'
    : '国内镜像通常比官方源快数倍；切换后检查更新与下载都会走该镜像。';
}

function renderSpeedTest(state) {
  const test = state.speedTest;
  if (test === null || test === undefined) {
    els.speedResults.textContent = '';
    return;
  }
  if (test.running === true) {
    els.speedResults.textContent = '正在测速…';
    return;
  }
  const results = Array.isArray(test.results) ? test.results : [];
  if (results.length === 0) {
    els.speedResults.textContent = test.error ?? '';
    return;
  }
  const table = document.createElement('table');
  table.className = 'speed';
  const head = document.createElement('tr');
  for (const title of ['镜像', '延迟', '速度']) {
    const th = document.createElement('th');
    th.textContent = title;
    head.append(th);
  }
  table.append(head);
  let best = null;
  for (const result of results) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = result.label ?? result.id;
    const latency = document.createElement('td');
    latency.className = 'num';
    latency.textContent = result.ok === true ? `${Math.round((result.latencyMs ?? 0))} ms` : '失败';
    const speed = document.createElement('td');
    speed.className = 'num';
    speed.textContent = result.ok === true ? (formatSpeed(result.bytesPerSecond) ?? '—') : (result.error ?? '');
    row.append(name, latency, speed);
    if (best === null && result.ok === true) best = result;
    if (best !== null && result === best) row.className = 'best';
    table.append(row);
  }
  els.speedResults.textContent = '';
  els.speedResults.append(table);
}

function render(state) {
  if (state === null || state === undefined) return;
  current = state;
  renderProgress(state);
  renderStats(state);
  renderSteps(state.steps ?? []);
  renderButtons(state);
  renderNotices(state);
  renderMirrors(state);
  renderSpeedTest(state);
}

// ── log ─────────────────────────────────────────────────────────────────────

function appendLog(line) {
  els.log.textContent += `${line}\n`;
  logLines += 1;
  els.log.scrollTop = els.log.scrollHeight;
}

function renderLog(lines) {
  els.log.textContent = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  logLines = lines.length;
  els.log.scrollTop = els.log.scrollHeight;
}

// ── events ──────────────────────────────────────────────────────────────────

els.pause.addEventListener('click', () => {
  void api.action(current?.paused === true ? 'resume' : 'pause');
});
els.cancel.addEventListener('click', () => {
  void api.action('cancel');
});
els.retry.addEventListener('click', () => {
  void api.action('retry');
});
els.restart.addEventListener('click', () => {
  void api.action('restart');
});
els.later.addEventListener('click', () => {
  void api.action('close');
});
els.openLog.addEventListener('click', () => {
  void api.action('open-log');
});
els.close.addEventListener('click', () => {
  void api.action('close');
});
els.mirror.addEventListener('change', () => {
  void api.action('mirror', els.mirror.value);
});
els.speedTest.addEventListener('click', () => {
  void api.action('speedtest');
});

api.onLog((line) => appendLog(line));
api.onState((state) => {
  // A reopen replays the log tail in the snapshot; a live update sends only the
  // new line, so only rebuild when the snapshot is longer than what is shown.
  const lines = state.log ?? [];
  if (lines.length > logLines) renderLog(lines);
  render(state);
});

// The elapsed column is derived from timestamps, so it has to be repainted even
// when no new event arrives.
setInterval(() => {
  if (current !== null && current.busy === true) {
    renderSteps(current.steps ?? []);
    renderStats(current);
  }
}, 1000);

void api.get().then((state) => {
  renderLog(state.log ?? []);
  render(state);
});

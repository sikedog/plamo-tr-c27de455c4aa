import { Wllama } from './vendor/wllama/index.js';
import { buildPrompt, cleanOutput, parseGlossary, STOP_STRINGS } from './pfml3.js';

const $ = (id) => document.getElementById(id);

// ---------- model sources ----------
const MODEL_REPO = 'pfnet/plamo-3-translate-0.8b-GGUF';
const MODEL_FILES = [
  { id: 'q4km', file: 'plamo-3-translate-0.8b-Q4_K_M.gguf', label: 'Q4_K_M（約0.57GB・おすすめ）' },
  { id: 'q40', file: 'plamo-3-translate-0.8b-Q4_0.gguf', label: 'Q4_0（約0.55GB）' },
  { id: 'bf16', file: 'plamo-3-translate-0.8b-BF16.gguf', label: 'BF16（約1.8GB・高精度）' },
];

const LANGS = [
  ['ja', '日本語'], ['en', 'English'], ['zh-hans', '中文（简体）'], ['zh-hant', '中文（繁體）'],
  ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'],
  ['ru', 'Русский'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Indonesia'], ['nl', 'Nederlands'],
  ['pl', 'Polski'], ['hi', 'हिन्दी'], ['ar', 'العربية'],
];

// ---------- settings ----------
const DEFAULTS = {
  modelId: 'q4km', customUrl: '', mode: 'raw', backend: 'cpu',
  form: '', context: '', glossary: '', target: 'ja',
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('plamo.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('plamo.settings', JSON.stringify(settings)); } catch { /* private mode */ }
}
const settings = loadSettings();

function modelUrl() {
  const custom = settings.customUrl.trim();
  if (custom) return custom;
  const f = MODEL_FILES.find((m) => m.id === settings.modelId) || MODEL_FILES[0];
  return `https://huggingface.co/${MODEL_REPO}/resolve/main/${f.file}`;
}

// ---------- UI helpers ----------
function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'chip' + (kind ? ' ' + kind : '');
}
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
const fmtMB = (b) => (b / 1048576).toFixed(b > 1e9 ? 0 : 1);

function setProgress(loaded, total) {
  show('dlWrap', true);
  const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  $('dlBar').style.width = pct + '%';
  $('dlText').textContent = total
    ? `${pct}%（${fmtMB(loaded)} / ${fmtMB(total)} MB）`
    : `${fmtMB(loaded)} MB`;
}

// ---------- stage log (kept in localStorage so it survives a force-quit) ----------
let stageT0 = 0;
function stage(name) {
  const sec = stageT0 ? ((performance.now() - stageT0) / 1000).toFixed(1) : '0.0';
  const line = `[${sec}s] ${name}`;
  try {
    const prev = JSON.parse(localStorage.getItem('plamo.stages') || '[]');
    if (!stageT0) prev.length = 0;
    prev.push(line);
    localStorage.setItem('plamo.stages', JSON.stringify(prev.slice(-45)));
  } catch { /* ignore */ }
  updateDiag().catch(() => {});
}
function savedStages() {
  try { return JSON.parse(localStorage.getItem('plamo.stages') || '[]'); } catch { return []; }
}
// ring buffer of the last native (llama.cpp) log lines, to see why a load aborts
const logRing = [];
function pushLog(level, args) {
  const t = args.map((x) => (typeof x === 'string' ? x : (x && x.message) || String(x))).join(' ').replace(/\s+/g, ' ').slice(0, 220);
  logRing.push(`${level}: ${t}`);
  if (logRing.length > 14) logRing.shift();
  try { (level === 'E' ? console.error : console.log)(...args); } catch { /* ignore */ }
}
const diagLogger = {
  debug() {},
  log: (...a) => pushLog('I', a),
  warn: (...a) => pushLog('W', a),
  error: (...a) => pushLog('E', a),
};
function dumpLogs(reason) {
  stage(`native log (${reason}):`);
  logRing.splice(0).forEach((l) => stage(l));
}
window.addEventListener('error', (e) => stage(`window error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  stage(`unhandled rejection: ${e.reason && (e.reason.message || e.reason)}`);
  setTimeout(() => dumpLogs('after rejection'), 800);
});

// ---------- wllama ----------
let wllama = null;
let modelReady = false;
let compatMode = null;

function abs(path) { return new URL(path, location.href).href; }

function createWllama() {
  const w = new Wllama(
    { default: abs('./vendor/wllama/wllama.wasm') },
    { allowOffline: true, logger: diagLogger }
  );
  // self-hosted compat build (used automatically on Safari / iOS)
  w.setCompat({ wasm: abs('./vendor/compat/wllama.wasm'), worker: abs('./vendor/compat/wllama.js') });
  return w;
}

async function isModelCached(w, url) {
  try {
    const name = await w.cacheManager.getNameFromURL(url);
    const list = await w.cacheManager.list();
    return list.some((e) => e.name === name && e.size > 0 && e.size >= (e.metadata?.originalSize || 0));
  } catch { return false; }
}

async function loadModel() {
  if (wllama) { try { await wllama.exit(); } catch { /* ignore */ } }
  modelReady = false;
  wllama = createWllama();
  const url = modelUrl();
  show('main', false);
  show('settings', true);
  show('setup', true);
  $('btnDownload').disabled = true;
  setStatus('モデル読み込み中...', 'warn');

  const t0 = performance.now();
  stageT0 = t0;
  let progressDone = false;
  stage('start');
  const params = {
    n_ctx: 1024,
    n_parallel: 1,
    useCache: true,
    n_gpu_layers: settings.backend === 'webgpu' ? 99999 : 0,
    progressCallback: ({ loaded, total }) => {
      setProgress(loaded, total);
      if (total && loaded >= total) {
        if (!progressDone) { progressDone = true; stage('download 100%'); }
        setStatus('保存・読み込み中...（数分かかります）', 'warn');
      } else {
        setStatus(total ? `ダウンロード ${Math.round((loaded / total) * 100)}%` : 'ダウンロード中...', 'warn');
      }
    },
  };
  if (settings.mode === 'chat') params.jinja = true;

  try {
    const model = await wllama.modelManager.getModelOrDownload({ url }, params);
    stage('downloaded / cache ready');
    const blobs = await model.open();
    const hangTimer = setTimeout(() => dumpLogs('20s after open, still loading'), 20000);
    stage(`model opened (${blobs.length} file, ${fmtMB(blobs.reduce((a, b) => a + b.size, 0))} MB)`);
    await wllama.loadModel(blobs, params);
    clearTimeout(hangTimer);
    stage('model loaded into wasm');
  } catch (err) {
    console.error(err);
    stage(`ERROR: ${err && (err.message || err)}`);
    dumpLogs('after error');
    const offline = !navigator.onLine;
    setStatus('読み込み失敗', 'err');
    $('btnDownload').disabled = false;
    show('dlWrap', false);
    toast(offline ? 'オフラインです。初回はネット接続が必要です' : '読み込みに失敗しました。診断情報を確認してください');
    await updateDiag(`load error: ${err && (err.message || err)}\nURL: ${url}`);
    return false;
  }
  modelReady = true;
  compatMode = (() => { try { return wllama.getWorkerResources().compat; } catch { return null; } })();
  show('setup', false);
  show('main', true);
  setStatus(navigator.onLine ? '準備OK' : '準備OK（オフライン）', 'ok');
  await updateDiag(`loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

// ---------- diagnostics ----------
async function updateDiag(extra = '') {
  const lines = [];
  try { lines.push(`libllama: ${Wllama.getLibllamaVersion()}`); } catch { /* ignore */ }
  lines.push(`mode: ${settings.mode} / backend: ${settings.backend}`);
  if (modelReady && wllama) {
    try {
      lines.push(`compat(wasm32): ${compatMode}`);
      lines.push(`threads: ${wllama.getNumThreads()} (multithread: ${wllama.isMultithread()})`);
      const info = wllama.getLoadedContextInfo();
      lines.push(`n_ctx: ${info.n_ctx}, n_vocab: ${info.n_vocab}`);
      lines.push(`arch: ${info.metadata?.['general.architecture'] ?? '?'}`);
    } catch { /* ignore */ }
  }
  lines.push(`secure context: ${window.isSecureContext}, crossOriginIsolated: ${window.crossOriginIsolated}`);
  lines.push(`OPFS: ${!!(navigator.storage && navigator.storage.getDirectory)}, WebGPU: ${!!navigator.gpu}`);
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      lines.push(`storage: ${fmtMB(e.usage || 0)} / ${fmtMB(e.quota || 0)} MB`);
    }
    if (navigator.storage?.persisted) lines.push(`persisted: ${await navigator.storage.persisted()}`);
  } catch { /* ignore */ }
  lines.push(`model url: ${modelUrl()}`);
  if (extra) lines.push(extra);
  const st = savedStages();
  if (st.length) lines.push('--- last load stages ---', ...st);
  $('diag').textContent = lines.join('\n');
}

// ---------- translate ----------
let abortCtl = null;

function setOutput(text) {
  const el = $('output');
  if (text) { el.textContent = text; el.classList.remove('empty'); }
  else { el.textContent = 'ここに結果が表示されます'; el.classList.add('empty'); }
  $('btnCopy').disabled = !text;
}

async function translate() {
  const text = $('input').value.trim();
  if (!text) { toast('文章を入力してください'); return; }
  if (!modelReady || !wllama) { toast('モデルがまだ準備できていません'); return; }

  settings.target = $('target').value;
  saveSettings();

  abortCtl = new AbortController();
  $('btnTranslate').disabled = true;
  show('btnStop', true);
  setStatus('翻訳中...', 'warn');
  setOutput('');
  $('stats').textContent = '';

  const glossary = parseGlossary(settings.glossary);
  const form = settings.target === 'ja' ? settings.form : '';
  let acc = '';
  let chunks = 0;
  const t0 = performance.now();
  let tFirst = 0;

  const onText = (t) => {
    if (!t) return;
    if (!tFirst) tFirst = performance.now();
    chunks += 1;
    acc += t;
    const shown = cleanOutput(acc);
    if (shown) setOutput(shown);
  };

  try {
    if (settings.mode === 'chat') {
      const kwargs = { target_lang: settings.target };
      if (form) kwargs.form = form;
      if (settings.context.trim()) kwargs.context = settings.context.trim();
      if (glossary.length) kwargs.glossary = glossary;
      await wllama.createChatCompletion({
        messages: [{ role: 'user', content: text }],
        max_tokens: 1024,
        temperature: 0,
        stream: true,
        chat_template_kwargs: kwargs,
        abortSignal: abortCtl.signal,
        onData: (chunk) => onText(chunk?.choices?.[0]?.delta?.content ?? ''),
      });
    } else {
      const prompt = buildPrompt({
        text, target: settings.target, form,
        context: settings.context, glossary,
      });
      await wllama.createCompletion({
        prompt,
        max_tokens: 1024,
        temperature: 0,
        stop: STOP_STRINGS,
        stream: true,
        abortSignal: abortCtl.signal,
        onData: (chunk) => onText(chunk?.choices?.[0]?.text ?? ''),
      });
    }
    const sec = (performance.now() - t0) / 1000;
    const gen = tFirst ? (performance.now() - tFirst) / 1000 : 0;
    $('stats').textContent = `${sec.toFixed(1)}秒` + (gen > 0 && chunks > 1 ? `（約${(chunks / gen).toFixed(1)} 単位/秒）` : '');
    if (!cleanOutput(acc)) {
      setOutput('');
      toast('結果が空でした。設定でプロンプト方式を切り替えてみてください');
    }
    await updateDiag(`raw output: ${JSON.stringify(acc).slice(0, 400)}`);
    setStatus(navigator.onLine ? '準備OK' : '準備OK（オフライン）', 'ok');
  } catch (err) {
    if (err && (err.name === 'WllamaAbortError' || err.name === 'AbortError')) {
      setStatus('停止しました', 'warn');
    } else {
      console.error(err);
      setStatus('翻訳エラー', 'err');
      toast('翻訳に失敗しました');
      await updateDiag(`translate error: ${err && (err.message || err)}`);
    }
  } finally {
    abortCtl = null;
    $('btnTranslate').disabled = false;
    show('btnStop', false);
  }
}

// ---------- wiring ----------
function fillSelects() {
  const t = $('target');
  t.innerHTML = LANGS.map(([v, l]) => `<option value="${v}">${l} へ翻訳</option>`).join('');
  t.value = settings.target;
  $('modelSel').innerHTML = MODEL_FILES.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  $('modelSel').value = settings.modelId;
  $('mode').value = settings.mode;
  $('form').value = settings.form;
  $('context').value = settings.context;
  $('glossary').value = settings.glossary;
  $('customUrl').value = settings.customUrl;
}

function readSettingsFromUi() {
  settings.modelId = $('modelSel').value;
  settings.customUrl = $('customUrl').value;
  settings.mode = $('mode').value;
  settings.form = $('form').value;
  settings.context = $('context').value;
  settings.glossary = $('glossary').value;
  settings.target = $('target').value;
  saveSettings();
}

async function wipeModel() {
  if (!confirm('保存したモデルを削除します。よろしいですか？（再利用にはもう一度ダウンロードが必要です）')) return;
  try {
    const w = wllama || createWllama();
    await w.cacheManager.clear();
    toast('削除しました');
  } catch (err) {
    console.error(err);
    toast('削除に失敗しました');
  }
  if (wllama) { try { await wllama.exit(); } catch { /* ignore */ } }
  modelReady = false;
  show('main', false);
  show('setup', true);
  $('btnDownload').disabled = false;
  show('dlWrap', false);
  setStatus('モデル未保存', 'warn');
  await updateDiag();
}

function wire() {
  $('btnDownload').addEventListener('click', async () => {
    readSettingsFromUi();
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
    await loadModel();
  });
  $('btnTranslate').addEventListener('click', translate);
  $('btnStop').addEventListener('click', () => abortCtl && abortCtl.abort());
  $('btnCopy').addEventListener('click', async () => {
    const t = $('output').textContent;
    try { await navigator.clipboard.writeText(t); toast('コピーしました'); }
    catch { toast('コピーできませんでした'); }
  });
  $('btnClear').addEventListener('click', () => { $('input').value = ''; setOutput(''); $('stats').textContent = ''; });
  $('btnApply').addEventListener('click', async () => { readSettingsFromUi(); await loadModel(); });
  $('btnWipe').addEventListener('click', wipeModel);
  $('input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') translate();
  });
  window.addEventListener('online', () => modelReady && setStatus('準備OK', 'ok'));
  window.addEventListener('offline', () => modelReady && setStatus('準備OK（オフライン）', 'ok'));
}

async function init() {
  fillSelects();
  wire();
  // backend selector is added in JS to keep the HTML simple
  const backendWrap = document.createElement('div');
  backendWrap.innerHTML = `
    <label for="backend">処理方式</label>
    <select id="backend">
      <option value="cpu">CPU（安定・標準）</option>
      <option value="webgpu">WebGPU（実験的・速くなる可能性）</option>
    </select>`;
  $('mode').insertAdjacentElement('afterend', backendWrap);
  $('backend').value = settings.backend;
  $('backend').addEventListener('change', () => { settings.backend = $('backend').value; saveSettings(); });

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isIOS && !navigator.standalone) show('iosHint', true);

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('SW register failed', e); }
  }

  show('settings', true);
  const probe = createWllama();
  const cached = await isModelCached(probe, modelUrl());
  if (cached) {
    wllama = probe;
    await loadModel();
  } else {
    wllama = probe;
    show('setup', true);
    setStatus('モデル未保存', 'warn');
    await updateDiag();
  }
}

init();

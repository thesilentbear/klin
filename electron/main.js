const { app, BrowserWindow, ipcMain, shell, nativeTheme, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

// System UI font, resolved through fontconfig (the same source `omarchy font`
// uses). Mic-monospace "Nerd Font" names are the Omarchy UI font; the sans
// fallback keeps the app legible if the font is unavailable.
function resolveSystemFont() {
  let family = '';
  try {
    const out = execFileSync('fc-match', ['-f', '%{family}\\n', 'monospace'], { encoding: 'utf8', timeout: 3000 });
    family = (out.split('\n')[0] || '').split(',')[0].trim();
  } catch (e) { /* no fontconfig */ }
  if (!family) return { font: '', mono: '' };
  return {
    font: `${family}, "Inter", "Segoe UI", Roboto, "Noto Sans", system-ui, sans-serif`,
    mono: `${family}, "JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace`,
  };
}

app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform');
app.commandLine.appendSwitch('ozone-platform-hint', 'wayland');

// Resolved Omarchy theme palette (~/.local/state/omarchy/current/theme/colors.toml).
// This reflects the *currently applied* theme (stock or custom, incl. overlays).
function readOmarchyTheme() {
  const p = path.join(os.homedir(), '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml');
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const out = { mode: 'dark', accent: '', background: '', darker_background: '', lighter_background: '', foreground: '', muted: '', selection: '' };
    for (const line of txt.split('\n')) {
      const m = line.trim().match(/^([a-z_]+)\s*=\s*"([^"]+)"/);
      if (!m) continue;
      if (m[1] === 'mode') out.mode = /light/i.test(m[2]) ? 'light' : 'dark';
      else if (/^#[0-9a-fA-F]{6}$/.test(m[2])) out[m[1]] = m[2];
    }
    return out.background ? out : null;
  } catch (e) { return null; /* not an Omarchy system, or theme not resolved yet */ }
}

let omarchyTimer = null;
function watchOmarchyTheme() {
  const dir = path.join(os.homedir(), '.local', 'state', 'omarchy', 'current', 'theme');
  try {
    fs.watch(dir, { persistent: false }, () => {
      clearTimeout(omarchyTimer);
      omarchyTimer = setTimeout(sendTheme, 200); // debounce: theme writes multiple files
    });
  } catch (e) { /* dir not present on non-Omarchy systems */ }
}

/* native system theming: dark/light + accent colour (Win / macOS / Linux),
   overridden by the Omarchy palette when one is active. */
function systemTheme() {
  const { font, mono } = resolveSystemFont();
  const omarchy = readOmarchyTheme();
  if (omarchy) {
    return { dark: omarchy.mode !== 'light', accent: '', platform: process.platform, omarchy, font, mono };
  }
  let accent = '';
  try {
    accent = systemPreferences.getAccentColor() || ''; // #RRGGBBAA or ''
  } catch (e) { /* not supported on this platform */ }
  return {
    dark: nativeTheme.shouldUseDarkColors,
    accent: accent && /^#[0-9a-fA-F]{6,8}$/.test(accent) ? accent.slice(0, 7) : '',
    platform: process.platform,
    omarchy: null,
    font,
    mono,
  };
}

function sendTheme() {
  if (win && !win.isDestroyed()) win.webContents.send('theme:changed', systemTheme());
}

const { chatStream } = require('../lib/llama');
const { runAgent } = require('../lib/agent');
const { search } = require('../lib/search');
const { getVideoData } = require('../lib/youtube');
const { countTokens } = require('../lib/context');

const settingsPath = () => {
  const p = process.env.APP_DATA || path.join(app.getPath('userData'), 'settings.json');
  return p;
};

const sessionsPath = () => path.join(process.env.APP_DATA || app.getPath('userData'), 'sessions');

let settings = null;

const DEFAULTS = {
  llamaUrl: 'http://127.0.0.1:8080',
  searxngUrl: 'http://127.0.0.1:8888',
  model: '',
  temp: 0.7,
  maxTokens: 4096,
  compactNudge: 0.75,
  compactAuto: 0.9,
  researchResults: 5,
  searchBackend: 'ddg',
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {};
  } catch (e) { /* no saved settings yet */ }
  settings = { ...DEFAULTS, ...saved };
  saveSettings();
  return settings;
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) { console.error('saveSettings', e); }
}

let win;
function createWindow() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const sf = display.scaleFactor || 1;
  const sw = display.workAreaSize.width;
  const sh = display.workAreaSize.height;
  const w = Math.round(sw * 0.86);
  const h = Math.round(sh * 0.9);
  try {
    fs.writeFileSync('/tmp/opencode/scale_report.txt',
      `screen=${sw}x${sh} sf=${sf} dpr=${display.scaleFactor}\nwindow=${w}x${h} bounds=${JSON.stringify(display.bounds)} workArea=${JSON.stringify(display.workArea)}`);
  } catch (e) {}
  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: Math.round(620 * sf),
    minHeight: Math.round(420 * sf),
    useContentSize: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const x11 = process.env.XDG_SESSION_TYPE === 'x11';
  const gdk = parseFloat(process.env.GDK_SCALE || '1') || 1;
  if (x11 && (gdk > 1 || sf > 1)) win.setZoomFactor(Math.max(gdk, sf));
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});

ipcMain.handle('theme:get', () => systemTheme());
nativeTheme.on('updated', sendTheme);
systemPreferences.on('accent-color-changed', sendTheme);
watchOmarchyTheme();
// re-resolve + push the font when the system font config changes (e.g. `omarchy font set`)
try {
  const fc = path.join(os.homedir(), '.config', 'fontconfig', 'fonts.conf');
  fs.watch(path.dirname(fc), { persistent: false }, () => {
    clearTimeout(omarchyTimer);
    omarchyTimer = setTimeout(sendTheme, 200);
  });
} catch (e) { /* no fontconfig dir */ }

ipcMain.handle('probe', async () => {
  const out = { llama: false, searxng: false, model: '', capabilities: [] };
  try {
    const r = await fetch(settings.llamaUrl + '/v1/models', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      out.llama = true;
      const list = (j.data || []).filter(m => m.id);
      if (list.length) {
        out.model = settings.model || list[0].id;
        out.capabilities = list[0].capabilities || [];
      }
    }
  } catch (e) { /* offline */ }
  try {
    const r = await fetch(settings.searxngUrl + '/', { signal: AbortSignal.timeout(4000) });
    out.searxng = r.ok;
  } catch (e) { /* offline */ }
  return out;
});

const controllers = new Map();

ipcMain.on('chat:start', (e, { id, payload: messages }) => {
  const controller = new AbortController();
  controllers.set(id, controller);
  const emit = (ev, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(ev, id, payload);
  };
  runAgent({
    url: settings.llamaUrl,
    model: settings.model,
    messages,
    temp: settings.temp,
    maxTokens: settings.maxTokens,
    settings,
    signal: controller.signal,
    onReasoning: t => emit('chat:reasoning', t),
    onChunk: t => emit('chat:chunk', t),
    onTool: t => emit('chat:tool', t),
    onDone: (d) => {
      controllers.delete(id);
      emit('chat:done', d);
    },
  }).catch(err => {
    controllers.delete(id);
    emit('chat:done', { error: String((err && err.message) || err), partial: controllers.get(id)?.partial });
  });
});

ipcMain.on('chat:stop', (_e, id) => {
  const c = controllers.get(id);
  if (c) c.abort();
});

ipcMain.handle('search', async (_e, q) => {
  return search(q, {
    backend: settings.searchBackend || 'ddg',
    searxngUrl: settings.searxngUrl,
    max: settings.researchResults,
  });
});

ipcMain.handle('youtube', async (_e, url) => {
  return getVideoData(url);
});

ipcMain.handle('count-tokens', async (_e, text) => {
  return countTokens(text, settings.llamaUrl);
});

ipcMain.handle('sessions:list', async () => {
  try {
    const files = fs.readdirSync(sessionsPath()).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(sessionsPath(), f), 'utf8'));
        return { id: d.id, title: d.title || 'Untitled', updated: d.updated || 0, created: d.created || 0 };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated - a.updated);
  } catch { return []; }
});

ipcMain.handle('sessions:load', async (_e, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsPath(), id + '.json'), 'utf8'));
  } catch { return null; }
});

ipcMain.handle('sessions:save', async (_e, data) => {
  fs.mkdirSync(sessionsPath(), { recursive: true });
  data.updated = Date.now();
  fs.writeFileSync(path.join(sessionsPath(), data.id + '.json'), JSON.stringify(data));
  return true;
});

ipcMain.handle('sessions:delete', async (_e, id) => {
  try { fs.unlinkSync(path.join(sessionsPath(), id + '.json')); } catch { /* ignore */ }
  return true;
});

loadSettings();
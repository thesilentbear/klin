const { contextBridge, ipcRenderer } = require('electron');

let seq = 0;
const buses = new Map();

contextBridge.exposeInMainWorld('api', {
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  probe: () => ipcRenderer.invoke('probe'),
  search: (q) => ipcRenderer.invoke('search', q),
  youtube: (url) => ipcRenderer.invoke('youtube', url),
  countTokens: (text) => ipcRenderer.invoke('count-tokens', text),
  sessionsList: () => ipcRenderer.invoke('sessions:list'),
  sessionsLoad: (id) => ipcRenderer.invoke('sessions:load', id),
  sessionsSave: (data) => ipcRenderer.invoke('sessions:save', data),
  sessionsDelete: (id) => ipcRenderer.invoke('sessions:delete', id),

  themeGet: () => ipcRenderer.invoke('theme:get'),
  onThemeChange(cb) {
    ipcRenderer.on('theme:changed', (_e, t) => cb(t));
  },

  chat(payload, { onReasoning, onChunk, onTool, onDone }) {
    const id = ++seq;
    const acc = { reasoning: '', chunk: '', tools: [], done: null };
    const bus = { onReasoning, onChunk, onTool, onDone };
    buses.set(id, bus);

    const h = (ev) => (e, rid, data) => {
      if (rid !== id) return;
      const b = buses.get(id);
      if (!b) return;
      if (ev === 'reasoning') { acc.reasoning += data; b.onReasoning && b.onReasoning(data); }
      else if (ev === 'chunk') { acc.chunk += data; b.onChunk && b.onChunk(data); }
      else if (ev === 'tool') { acc.tools.push(data); b.onTool && b.onTool(data); }
      else if (ev === 'done') {
        acc.done = data;
        buses.delete(id);
        b.onDone && b.onDone(data);
      }
    };
    ipcRenderer.on('chat:reasoning', h('reasoning'));
    ipcRenderer.on('chat:chunk', h('chunk'));
    ipcRenderer.on('chat:tool', h('tool'));
    ipcRenderer.on('chat:done', h('done'));

    ipcRenderer.send('chat:start', { id, payload });
    return { id, state: () => undefined, stop() { ipcRenderer.send('chat:stop', id); } };
  },
});
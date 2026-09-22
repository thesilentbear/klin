const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klin-'));

function yt(el, timeoutMs) {
  return new Promise((res, rej) => {
    let done = false;
    const finish = (err) => { if (!done) { done = true; err ? rej(err) : res(0); } };
    const t = setTimeout(() => { el.kill('SIGKILL'); finish(new Error('yt-dlp timed out')); }, timeoutMs);
    el.on('close', c => { clearTimeout(t); finish(c === 0 ? null : new Error(`yt-dlp exit ${c}`)); });
    el.on('error', e => { clearTimeout(t); finish(e); });
  });
}

async function getVideoData(url) {
  const safe = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
  const base = path.join(TMP, safe);
  const out = { url, title: '', transcript: '', comments: [], error: null };
  try {
    const meta = spawn('yt-dlp', ['--skip-download', '--write-comments', '--write-auto-subs', '--write-subs',
      '--sub-langs', 'en', '--sub-format', 'json3', '--no-playlist',
      '--extractor-args', 'youtube:max_comments=60,60,20',
      '-o', base + '.%(ext)s', url]);
    await yt(meta, 90000);
  } catch (e) { out.error = String(e.message || e); }

  for (const f of fs.readdirSync(TMP)) {
    if (f.startsWith(safe + '.') && f.endsWith('.json')) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8'));
        out.title = d.title || out.title;
        if (d.comments && d.comments.length) {
          out.comments = (d.comments || []).slice(0, 40).map(c => ({
            author: c.author || '',
            text: (c.text || "").slice(0, 500),
            likes: c.like_count || 0,
          }));
        }
      } catch { /* skip */ }
    }
  }
  const subFiles = fs.readdirSync(TMP).filter(f => f.startsWith(safe + '.') && f.endsWith('.json3'));
  if (subFiles.length) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(TMP, subFiles[0]), 'utf8'));
      // Build a clean, flow-readable transcript: strip per-line timestamps,
      // join utterances, and chunk into paragraphs. Timestamped walls make the
      // model skim; natural prose makes it actually read the content.
      const paragraphs = [];
      let para = [];
      let paraStartMs = 0;
      const flush = () => {
        if (!para.length) return;
        const t0 = Math.floor(paraStartMs / 1000);
        const head = `${Math.floor(t0 / 60)}:${String(t0 % 60).padStart(2, '0')} — `;
        paragraphs.push(head + para.join(' ').replace(/\s+/g, ' '));
        para = [];
      };
      let lastTs = -1;
      for (const e of s.events || []) {
        if (!e.segs || !e.segs.length) continue;
        const text = e.segs.map(x => x.utf8 || '').join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (para.length === 0) paraStartMs = e.tStartMs || 0;
        if (para.length && typeof e.tStartMs === 'number' && lastTs >= 0 && e.tStartMs - lastTs > 12000) {
          flush();
          paraStartMs = e.tStartMs;
        }
        para.push(text);
        lastTs = typeof e.tStartMs === 'number' ? e.tStartMs : lastTs;
        if (para.length >= 18) flush();
      }
      flush();
      out.transcript = paragraphs.join('\n\n').slice(0, 200000);
    } catch { /* skip */ }
  }
  if (!out.comments.length) out.comments = [];
  return out;
}

module.exports = { getVideoData };
async function countTokens(text, llamaUrl) {
  if (!text) return 0;
  try {
    const r = await fetch(llamaUrl + '/tokenize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(text), add_special: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.tokens)) return j.tokens.length;
    }
  } catch { /* fall through to estimate */ }
  // rough fallback estimate (~4 chars/token for mixed text)
  return Math.ceil(String(text).length / 4);
}

module.exports = { countTokens };
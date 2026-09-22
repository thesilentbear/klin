async function chatStream({ url, model, messages, temp = 0.7, maxTokens = 4096, signal, thinking = true, reasoningBudget, onReasoning, onChunk, onTool, onDone }) {
  const body = {
    model: model || 'default',
    messages,
    temperature: temp,
    max_tokens: maxTokens,
    stream: true,
    cache_prompt: true,
  };
  if (thinking === false) body.chat_template_kwargs = { enable_thinking: false };
  if (reasoningBudget) body.reasoning_budget = reasoningBudget;
  const r = await fetch(url + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.stringify((await r.json()).error || {}); } catch { detail = await r.text().catch(() => ''); }
    throw new Error(`llama.cpp HTTP ${r.status}: ${detail || 'stream failed'}`);
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reasoning = '';
  let content = '';
  const tools = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') { reader.cancel().catch(() => {}); const out = { content, reasoning, tools: tools.filter(t => t.function && t.function.name) }; onDone && onDone(out); return out; }
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) continue;
      if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning && onReasoning(delta.reasoning_content); }
      if (delta.content) { content += delta.content; onChunk && onChunk(delta.content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          tools[idx] = tools[idx] || { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
          if (tc.id) tools[idx].id = tc.id;
          if (tc.function) {
            if (tc.function.name) tools[idx].function.name += tc.function.name;
            if (tc.function.arguments) tools[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }
  onTool && onTool(tools.filter(t => t.function && t.function.name));
  const out = { content, reasoning, tools: tools.filter(t => t.function && t.function.name) };
  onDone && onDone(out);
  return out;
}

module.exports = { chatStream };
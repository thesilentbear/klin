const { chatStream } = require('./llama');
const { search } = require('./search');
const { getVideoData } = require('./youtube');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web for current, up-to-date or verifiable information: recent news, prices, events, dates, people, facts, rumors.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Concise search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_youtube_transcript',
      description: 'Get the transcript and top comments of a YouTube video.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'YouTube video URL' } },
        required: ['url'],
      },
    },
  },
];

const VALID_TOOLS = new Set(TOOLS.map(t => t.function.name));

const PROTOCOL = [
  'You have tools. To use one, output a single line exactly like one of these (nothing else on that line):',
  'SEARCH("concise search query")',
  'YOUTUBE("<youtube url>")',
  'Only one tool result will be delivered for the query you request; when its results arrive in the conversation, immediately write the final answer grounded in those results, citing URLs when relevant. Never output SEARCH or YOUTUBE more than once for the same question.',
  'Only call a tool when information needs to be current, verified, from the web, or from a specific video. Do not call tools for general knowledge you are confident about.',
].join('\n');

const MARKER_RE = /(SEARCH|YOUTUBE)\(\s*(["'])(.*?)\2\s*\)/gs;

// Filter chunks for display: drop marker lines; buffer trailing output
// so a still-streaming marker line can't flash half-rendered.
function makeChunkFilter() {
  let buf = '';
  return (chunk, flush = false) => {
    buf += chunk;
    let out = '';
    const lines = buf.split('\n');
    buf = lines.pop();
    if (buf && flush) { lines.push(buf); buf = ''; }
    for (const ln of lines) {
      const t = ln.trim();
      if (t.startsWith('SEARCH(') || t.startsWith('YOUTUBE(')) {
        if (/^(SEARCH|YOUTUBE)\(\s*(["']).*?\2\s*\)$/.test(t)) continue; // complete marker, drop
      }
      out += ln + '\n';
    }
    return out;
  };
}

// Extract complete markers from accumulated raw output.
function extractMarkers(raw) {
  const found = [];
  raw.replace(MARKER_RE, (m, name, q, arg) => {
    found.push({ name: name === 'SEARCH' ? 'search_web' : 'get_youtube_transcript', arg });
    return '';
  });
  return found;
}

function stripMarkers(text) {
  return (text || '').replace(MARKER_RE, ' ');
}

async function runAgent({
  url, model, messages, temp = 0.7, maxTokens = 4096,
  settings = {}, signal, maxSteps = 4, zen = false, zenApiKey = '',
  onReasoning, onChunk, onTool, onDone,
}) {
  const acc = { reasoning: '', content: '', tools: [], sources: [] };
  const history = messages.slice();
  const sysIdx = history.findIndex(m => m.role === 'system');
  if (sysIdx === -1) {
    history.unshift({ role: 'system', content: 'Assistant with web tools.\n\n' + PROTOCOL });
  } else {
    // Fold the marker protocol into the system prompt. Appending it as a
    // trailing user message makes the model re-litigate tool policy for every
    // query ("wait, the prompt says I have tools..."), which bloats reasoning
    // on trivial questions. In-system it is read once and barely rehashed.
    history[sysIdx] = { role: 'system', content: history[sysIdx].content + '\n\n' + PROTOCOL };
  }
  let step = 0;
  const filter = makeChunkFilter();
  const flushFilter = () => filter('', true);
  try {
    while (step < maxSteps) {
      let raw = '';
      // Tools are available only before any tool has run. After a tool result,
      // the model has all the context it needs — removing the tool schemas
      // guarantees it cannot keep re-calling SEARCH/YOUTUBE and instead must
      // produce the final answer. This is what was causing the "no answer"
      // spiral: the answer step kept re-triggering tools until maxSteps.
      const toolsOpen = !acc.tools.length;
      // Step 0 thinks freely to pick a tool. A synthesis step may also reason
      // (it needs to actually read a long transcript) but is bounded.
      const reasoningBudget = step === 0 ? undefined : 800;
      const stepMessages = history.slice();
      if (!toolsOpen) {
        stepMessages.push({ role: 'user', content: 'Tools are DISABLED now. Do not output SEARCH(...) or YOUTUBE(...) or any tool call. Write the final answer now, in detail, based on the information provided above.' });
      }
      const res = await chatStream({
        url, model, temp, maxTokens, signal, tools: toolsOpen ? TOOLS : [],
        thinking: true,
        reasoningBudget,
        zen,
        zenApiKey,
        messages: stepMessages,
        onReasoning: t => { acc.reasoning += t; onReasoning && onReasoning(t); },
        onChunk: t => {
          raw += t;
          const show = filter(t);
          if (show) { acc.content += show; onChunk && onChunk(show); }
        },
        onTool: () => {},
      });
      if (process.env.DEBUG_AGENT) {
        console.error('AGENT step', step, 'content:', (res.content||'').slice(0,50), 'tools:', JSON.stringify(res.tools||[]), 'toolsOpen', toolsOpen);
        console.error('AGENT history lens:', JSON.stringify(history.map(m => (m.role + ':' + (typeof m.content === 'string' ? m.content.length : 'obj')))));
      }

      // After-gen flush then native tool calls
      const rest = flushFilter();
      if (rest) { raw += rest; acc.content += rest; onChunk && onChunk(rest); }
      const calls = toolsOpen ? (res.tools || []).filter(t => t.function && t.function.name && VALID_TOOLS.has(t.function.name)) : [];
      const markers = toolsOpen ? extractMarkers(raw) : [];
      // Emptiness is judged on the *filtered* content: the model may emit only
      // a marker line (even when tools are closed), which the filter strips,
      // leaving a real-but-invisible empty answer.
      const contentSoFar = acc.content.trim();

      // Robustness: if a step returned nothing at all, nudge once and retry.
      if (!calls.length && !markers.length && !contentSoFar && step < maxSteps - 1) {
        const asstNudge = { role: 'assistant', content: contentSoFar ? contentSoFar : '(thinking quietly)' };
        history.push(asstNudge);
        history.push({ role: 'user', content: 'If you need current or verified information, call the appropriate tool now; otherwise give your final answer directly. Start with your output on the next line.' });
        step++;
        continue;
      }

      if (!calls.length && !markers.length) {
        if (!contentSoFar) {
          // nothing came out (markers-only or empty) and tools are closed — force an answer
          history.push({ role: 'user', content: 'Answer now, directly, in detail, based on what you already have. Do not call any tool.' });
          step++;
          continue;
        }
        break;
      }
      // markers already stripped from acc.content by filter; remove any stragglers
      acc.content = stripMarkers(acc.content).replace(/\s+/g, ' ').trim();

      const asstMsg = { role: 'assistant', content: (raw && raw.trim()) ? raw.trim() : ((acc.content && acc.content.trim()) || '(tool requested)') };
      if (calls.length) {
        asstMsg.tool_calls = calls.map((t, i) => ({
          id: t.id || ('call_' + step + '_' + i),
          type: 'function',
          function: { name: t.function.name, arguments: t.function.arguments || '{}' },
        }));
      }
      history.push(asstMsg);
      if (!calls.length && !markers.length) break;

      for (const rc of calls) {
        await runTool(rc.function.name, rc.function.arguments, history, asstMsg, acc, onTool, settings);
      }
      for (const mk of markers) {
        const tokArgs = mk.name === 'search_web' ? JSON.stringify({ query: mk.arg }) : JSON.stringify({ url: mk.arg });
        await runTool(mk.name, tokArgs, history, asstMsg, acc, onTool, settings);
      }
      step++;
    }
    onDone && onDone({ content: acc.content.trim(), reasoning: acc.reasoning, tools: acc.tools, sources: acc.sources });
  } catch (e) {
    onDone && onDone({ error: String((e && e.message) || e), content: acc.content, reasoning: acc.reasoning, tools: acc.tools, sources: acc.sources });
  }
}

async function runTool(name, argsJson, history, asstMsg, acc, onTool, settings) {
  let args = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* keep {} */ }
  onTool && onTool({ name, args });
  let output;
  try {
    if (name === 'search_web') {
      const q = String(args.query || '').slice(0, 300);
      const r = await search(q, {
        backend: settings.searchBackend || 'ddg',
        searxngUrl: settings.searxngUrl,
        max: settings.researchResults || 5,
      });
      if (r.error) {
        output = 'Search failed: ' + r.error;
      } else {
        r.results.forEach(x => {
          acc.sources.push({ title: x.title || '(untitled)', url: x.url || '', snippet: x.text || x.snippet || '' });
        });
        output = 'SEARCH RESULTS for "' + q + '":\n\n' + r.results.map(x =>
            '- ' + x.title + ' | ' + x.url + '\n' + (x.text || x.snippet || '').slice(0, 1800)
          ).join('\n\n');
      }
    } else {
      const r = await getVideoData(String(args.url || '').trim());
      if (r.error) {
        output = 'COULD NOT RETRIEVE THIS VIDEO: ' + r.error
          + '\nThe video link is dead, the video is private/unavailable, or retrieval failed. '
          + 'State clearly to the user that the video could not be accessed (and give the real reason if known). '
          + 'Do NOT guess, summarize, or make up anything about the video\'s content.';
      } else if (!(r.transcript || '').trim()) {
        output = 'VIDEO FOUND BUT NO TRANSCRIPT AVAILABLE:\nYouTube: ' + r.title + '\nURL: ' + r.url
          + '\nThe video could not be transcribed (no captions/subtitles). '
          + 'State clearly to the user that the video has no accessible transcript, so its content cannot be summarized from it.';
      } else {
        output = 'YouTube: ' + r.title + '\nURL: ' + r.url + '\n\nTRANSCRIPT:\n'
          + r.transcript.slice(0, 60000)
          + (r.comments && r.comments.length ? '\n\nTOP COMMENTS:\n' + r.comments.slice(0, 12).map(c => '- ' + c.author + ': ' + c.text).join('\n') : '');
      }
    }
  } catch (e) {
    output = 'Tool error: ' + String((e && e.message) || e);
  }
  const id = asstMsg.tool_calls && asstMsg.tool_calls.find(c => c.function.name === name);
  const label = name === 'search_web' ? 'SEARCH' : 'YOUTUBE';
  const brief = name === 'search_web'
    ? 'use these as final context — now answer the user\'s question directly from these results'
    : /^COULD NOT RETRIEVE|^VIDEO FOUND BUT NO TRANSCRIPT/.test(output)
      ? 'follow the explicit instruction in the result — report the video\'s status honestly and do NOT invent content'
      : 'Read this transcript ENTIRELY and carefully — it can be long; do not rely on just the opening lines, the title, or the URL. Answer the user\'s question thoroughly from the actual spoken content, summarizing key points and quoting specific facts, timestamps or examples where relevant';
  history.push({ role: 'user', content: label + ' RESULTS for your request (' + brief + ', and do NOT output ' + label + ' again):\n' + String(output) });
  acc.tools.push(name);
  onTool && onTool({ name, args, done: true });
}

module.exports = { runAgent, TOOLS };
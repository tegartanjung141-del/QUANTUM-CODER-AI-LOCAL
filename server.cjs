#!/usr/bin/env node
'use strict';
/**
 * Quantum server — serves the chat UI, runs code blocks, and orchestrates the
 * generate -> execute -> fix loop against local models.
 *
 *   GET  /             -> chat UI (public/index.html)
 *   GET  /models       -> list of configured models {name, port, default}
 *   POST /run          -> execute one code block, return real stdout/stderr
 *   POST /chat (SSE)   -> stream tokens; auto-run generated code; if it fails,
 *                         feed the error back to the model and retry (<=3x)
 *
 * The differentiator: the model only GUESSES code; the CPU is the judge.
 */
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const vm   = require('vm');
const { execSync } = require('child_process');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const HOST = (CONFIG.server && CONFIG.server.host) || '127.0.0.1';
const PORT = (CONFIG.server && CONFIG.server.port) || 8090;
const HTML = path.join(__dirname, 'public', 'index.html');
const TMP_PY = path.join(os.tmpdir(), '_quantum_run.py');

// ── Execute JavaScript as a script, capturing console output (5s timeout) ──
function runJS(code) {
  const logs = [];
  const push = (...a) => logs.push(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));
  const sandbox = {
    console: { log: push, error: push, warn: push, info: push },
    JSON, Math, Number, String, Array, Object, Boolean, Date, Map, Set, Symbol,
    parseInt, parseFloat, isNaN, isFinite, RegExp, Error, TypeError, RangeError,
    setTimeout: (f) => f && f(), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {},
  };
  try {
    vm.runInContext(code, vm.createContext(sandbox), { timeout: 5000 });
    return { ok: true, output: logs.join('\n') };
  } catch (e) {
    return { ok: false, output: logs.join('\n'), error: e.constructor.name + ': ' + e.message };
  }
}

// ── Execute Python as a script via subprocess (8s timeout) ──
function runPy(code) {
  fs.writeFileSync(TMP_PY, code, 'utf8');
  try {
    const out = execSync(`python "${TMP_PY}"`, { timeout: 8000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: (e.stdout || '').toString(), error: ((e.stderr || '') + '').trim() || e.message };
  }
}

function detectLang(lang, code) {
  const l = (lang || '').toLowerCase();
  if (['py', 'python'].includes(l)) return 'python';
  if (['js', 'javascript', 'node', 'ts', 'typescript'].includes(l)) return 'javascript';
  if (/(^|\n)\s*(def |import |print\(|class \w+:|elif )/.test(code)) return 'python';
  return 'javascript';
}

// ── Model client + orchestration ──
const SYS = 'You are a helpful, precise coding assistant. Answer concisely. Use fenced code blocks for code.';
function buildPrompt(hist) {
  let p = `<|im_start|>system\n${SYS}<|im_end|>\n`;
  for (const t of hist) p += `<|im_start|>${t.role}\n${t.content}<|im_end|>\n`;
  return p + `<|im_start|>assistant\n`;
}
function extractCode(text) {
  const m = text.match(/```(\w*)\s*\n([\s\S]*?)```/);
  return m ? { lang: m[1], code: m[2].trim() } : null;
}
// Streaming model call; forwards each token via onToken. reg() exposes the
// request so the caller can destroy() it on cancel.
function askModelStream(port, prompt, onToken, reg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ prompt, n_predict: 1024, temperature: 0.3, top_p: 0.9,
      repeat_penalty: 1.2, stop: ['<|im_end|>', '<|endoftext|>'], stream: true });
    const r = http.request({ hostname: '127.0.0.1', port, path: '/completion', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 600000 },
      s => {
        let acc = '', buf = '';
        s.on('data', chunk => {
          buf += chunk.toString(); const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            const m = line.match(/^data:\s*(.*)$/); if (!m) continue;
            try { const j = JSON.parse(m[1]); if (j.content) { acc += j.content; onToken(j.content); } } catch {}
          }
        });
        s.on('end', () => resolve(acc));
      });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('model timeout')); });
    if (reg) reg(r);
    r.write(body); r.end();
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // List configured models (UI builds the dropdown from this)
  if (req.method === 'GET' && req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(CONFIG.models.map(m => ({ name: m.name, port: m.port, default: !!m.default }))));
  }

  // Chat: stream tokens + auto run/fix loop (SSE)
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    let cancelled = false, curReq = null;
    res.on('close', () => { if (!res.writableFinished) { cancelled = true; if (curReq) { try { curReq.destroy(); } catch (_) {} } } });
    req.on('data', c => body += c);
    req.on('end', async () => {
      let history, port;
      try { ({ history, port } = JSON.parse(body)); } catch (e) { res.writeHead(400); return res.end('bad json'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const ev = o => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
      const work = (history || []).slice();
      let reply = '', run = null, attempts = 0;
      try {
        for (let i = 1; i <= 3; i++) {
          if (cancelled) break;
          attempts = i;
          if (i > 1) ev({ t: 'retry', n: i });
          reply = await askModelStream(port || CONFIG.models[0].port, buildPrompt(work), tok => ev({ t: 'tok', c: tok }), r => { curReq = r; });
          if (cancelled) break;
          const cb = extractCode(reply);
          if (!cb) { run = null; break; }
          const lang = detectLang(cb.lang, cb.code);
          run = (lang === 'python') ? runPy(cb.code) : runJS(cb.code);
          run.language = lang;
          ev({ t: 'run', run });
          if (run.ok) break;
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content: `The code failed when run:\n${(run.error || '').slice(0, 400)}\nFix it. Output only the corrected code block.` });
        }
        if (!cancelled) ev({ t: 'done', reply, run, attempts });
      } catch (e) { if (!cancelled) ev({ t: 'err', m: e.message }); }
      if (!res.writableEnded) res.end();
    });
    return;
  }

  // Run one code block manually
  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let r;
      try {
        const { language, code } = JSON.parse(body);
        const lang = detectLang(language, code || '');
        r = lang === 'python' ? runPy(code) : runJS(code);
        r.language = lang;
      } catch (e) { r = { ok: false, error: 'bad request: ' + e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }

  // Serve the chat UI
  fs.readFile(HTML, (e, data) => {
    if (e) { res.writeHead(404); return res.end('public/index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Quantum  ->  http://${HOST}:${PORT}\n  (serves chat, executes code, verifies by running)\n`);
});

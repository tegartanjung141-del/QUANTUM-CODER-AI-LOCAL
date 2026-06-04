# ⚛️ Quantum

**A local AI coding chat that doesn't just *generate* code — it *runs* it to prove it works.**

Every other local-LLM chat hands you text and trusts it. Quantum treats the model as an
untrusted guesser and the **CPU as the judge**: generated code is executed automatically,
and if it fails, the error is fed back to the model to fix — looping until it actually runs.

```
You: write a python function is_prime(n) with a couple of asserts

⚛️ Quantum
  def is_prime(n):
      if n < 2: return False
      for d in range(2, int(n**0.5)+1):
          if n % d == 0: return False
      return True
  assert is_prime(7) and not is_prime(8)
  print("ok")
  ──────────────────────────────────────
  ▶ Run   ⧉ Copy code        python
  ✓ ran (exit 0) • python
  ok
                                    ✓ verified (1x)
```

The model only **guesses** code (it can be wrong — that's how LLMs work). The terminal,
wired straight to the CPU, is the only thing that knows what the code **actually does**.
Quantum puts the two together.

---

## Why this matters

An LLM predicts the next token. For prose, "plausible" is good enough. For **code**,
plausible ≠ correct — and the model has no way to know the difference, because it has no
CPU inside it. Quantum closes that gap:

```
model  ──►  generated code  ──►  CPU runs it  ──►  pass / fail (real)
 guess        (untrusted)         (ground truth)     │
   ▲                                                 │ if fail, feed error back
   └─────────────────────────────────────────────────┘  and retry
```

You don't get a smarter model — you get **output you can trust**, because it was proven by
execution, not by appearance.

## Features

- 🧠 **Multiple local models** — pick by speed/quality from a dropdown (configurable).
- ⚡ **Streaming** — tokens appear live.
- ▶️ **Run button** on every code block — real stdout/stderr, no sandboxed pretending.
- 🔁 **Auto-verify loop** — generated code is run; on error, the model fixes it (≤3x), silently.
- ⧉ **Copy** code or output in one click.
- ⏹ **Cancel** — the Send button becomes Cancel mid-generation; stops instantly.
- 🔒 **100% local** — no API keys, no data leaves your machine.

Runs **JavaScript** (via Node `vm`) and **Python** (via subprocess) today; the executor is
easy to extend to other languages.

## Requirements

- **[Node.js](https://nodejs.org) 18+**
- **[Python](https://python.org)** (for running Python code blocks)
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** `llama-server` (the setup script fetches a Windows build for you)
- ~4 GB disk for the models, ~4 GB RAM. CPU-only is fine (no GPU needed).

## Quickstart (Windows)

```powershell
git clone https://github.com/<you>/quantum && cd quantum
npm install                       # (no deps yet, but standard)
powershell scripts/setup.ps1      # downloads llama.cpp + models (~4 GB, one time)
powershell scripts/start-models.ps1   # launch the model servers
npm start                         # http://127.0.0.1:8090
```

Open **http://127.0.0.1:8090** and ask for code.

### Linux / macOS

Install `llama.cpp` (so `llama-server` is on your PATH), set `modelDir` in `config.json`
to a local path, then:

```bash
bash scripts/setup.sh           # downloads the models
bash scripts/start-models.sh    # launch model servers
npm start
```

## Configuration — `config.json`

Everything is driven by one file. Add/remove models, change ports, paths, threads:

```json
{
  "server": { "host": "127.0.0.1", "port": 8090 },
  "modelDir": "C:/llama-cpp",
  "llama": { "threads": 4, "ctxSize": 2048 },
  "models": [
    { "name": "Quantum 3B (smart)", "file": "...q4_k_m.gguf", "url": "https://...", "port": 8083, "default": true }
  ]
}
```

The UI builds its model dropdown from this list automatically.

## How it works

| Layer | Role | In Quantum |
|-------|------|------------|
| **Generator** (untrusted) | guesses code | local model via `llama-server` |
| **Bridge** | run generated code, feed results back | `server.cjs` (`/chat` loop) |
| **Judge** (ground truth) | says what the code actually does | the CPU (`vm` / subprocess) |

`server.cjs` streams tokens from the model, extracts the code block, runs it, and — if it
crashes — sends the error back to the model and retries. You only ever see the final,
execution-checked result.

## Honest limits

- The model is still a small local model — it can be wrong; verification is what catches it.
- **"Runs" ≠ "logically correct."** Auto-verify catches crashes/errors. To check *correctness*,
  ask the model to include `assert`s (a spec). The CPU tells you *what happened*; your spec
  defines *what should happen*.
- Code execution happens on your machine (it's a local dev tool, like running a file yourself).
- Complex code with external dependencies/IO needs more setup than a self-contained snippet.

## License

MIT — see [LICENSE](LICENSE).

---

*Models guess. CPUs prove. Quantum bridges the two.*

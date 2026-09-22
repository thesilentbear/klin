# Klin

![License](https://img.shields.io/badge/license-MIT-blue)

Private, local AI chat on your own [llama.cpp](https://github.com/ggml-org/llama.cpp) server — with web research, YouTube transcripts, image paste, and context compaction. Built with Electron, keeps everything on your machine.

## Features

- **Fully local** — talks to llama.cpp over HTTP; no cloud, no account, no telemetry
- **Web research** — grounded answers with cited sources via DuckDuckGo (standalone) or your self-hosted SearXNG
- **YouTube transcripts** — drop in a video URL and get a grounded summary
- **Image paste** — attach or paste screenshots, photos, charts, documents for vision-capable models
- **Context compaction** — nudges at `compactNudge`% and auto-compacts at `compactAuto%` of context usage, so long conversations keep flowing
- **Streaming with reasoning** — live streaming output including the model's thinking block
- **Conversation sessions** — multiple chats, saved locally, persisted across restarts
- **Following desktop theme** — automatically adopts your Omarchy color scheme and system fonts

## Requirements

- Node.js 18+ (npm)
- A llama.cpp server running with the OpenAI-compatible HTTP endpoint, e.g.:

  ```bash
  llama-server -m your-model.gguf --port 8080
  ```

- Optional: a SearXNG instance for the SearXNG backend (DuckDuckGo works out of the box)

## Install

```bash
git clone https://github.com/thesilentbear/klin.git
cd klin
npm install
```

## Run

```bash
npm start
```

For a detached launch (terminal returns immediately):

```bash
npm run launch
```

## Configuration

Open **Settings** (gear icon in the sidebar, top-right):

| Setting | Default | Notes |
| --- | --- | --- |
| llama.cpp URL | `http://127.0.0.1:8080` | OpenAI-compatible endpoint |
| SearXNG URL | `http://127.0.0.1:8888` | Only used with the SearXNG backend |
| Model ID | *(empty)* | Leave empty to use the first model on your server |
| Temperature | `0.7` | |
| Compaction — nudge at | `75%` | Prompts you as the conversation approaches this |
| Compaction — auto at | `90%` | Compacts automatically past this point |
| Web research results | `5` | Sources fetched per search |
| Search backend | `DuckDuckGo` | Or your self-hosted SearXNG |

Settings are saved to `settings.json` in your Electron user-data directory (override with `APP_DATA`).

## Tools

Klin gives the model two tools, invoked autonomously from its output:

- `SEARCH("query")` — web search; results are returned along with source URLs
- `YOUTUBE("<url>")` — fetches a video's transcript for grounded summarization

Once a tool result arrives, tool calls are disabled so the model writes a single grounded final answer instead of re-calling tools.

## Project structure

```
electron/   main process (passive), preload bridge
lib/        llama streaming, agent loop, web search, YouTube, token counting
scripts/    launcher scripts
src/        renderer: UI, theming, settings modal
```

## License

MIT. Your data never leaves your machine.
# IUB CLI

> Autonomous BYOK terminal coding agent for Bangla, Banglish, and English, with BUILD and PLAN modes, local-first configuration, and resilient free-model failover.

[![npm version](https://img.shields.io/npm/v/iubcli.svg?style=flat-square&color=00A3FF)](https://www.npmjs.com/package/iubcli)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](license)
[![BYOK](https://img.shields.io/badge/BYOK-100%25%20Serverless-blue.svg?style=flat-square)](#bring-your-own-key-byok)

```
  ██╗ ██╗   ██╗ ██████╗   ██████╗ ██╗      ██╗
  ██║ ██║   ██║ ██╔══██╗ ██╔════╝ ██║      ██║
  ██║ ██║   ██║ ██████╔╝ ██║      ██║      ██║
  ██║ ██║   ██║ ██╔══██╗ ██║      ██║      ██║
  ██║ ╚██████╔╝ ██████╔╝ ╚██████╗ ███████╗ ██║
  ╚═╝  ╚═════╝  ╚═════╝   ╚═════╝ ╚══════╝ ╚═╝
```

---

## Overview

**IUB CLI** (`iubcli`) is an open-source, serverless terminal coding assistant for developers who think, speak, and code in **Bangla**, **Banglish**, or **English**.

It combines a local terminal UI with provider-backed model calls, giving you an agent that can inspect a workspace, plan changes, edit files, run commands, fetch documentation, and coordinate with other local CLI instances.

Core design points:

- **BUILD Mode:** autonomous coding with file reads/writes, edits, shell commands, web search, image input, and project inspection.
- **PLAN Mode:** read-only architecture and planning mode for senior-engineer style analysis.
- **BYOK:** bring your own Gemini, OpenRouter, DeepSeek, Groq, Cerebras, Ollama, or custom OpenAI-compatible endpoint.
- **Auto-cascade:** rotates through available free models when quotas or rate limits are hit.
- **Local-first:** configuration is stored on your machine through `conf`; there is no hosted middleman.
- **Zero-key fallback:** if no provider is configured in a non-interactive run, IUB CLI can start with a built-in free starter endpoint or detect local Ollama.

---

## Features

### Agent Modes

- `BUILD Mode` is the default. It can use workspace tools, modify files, install dependencies, run tests, and execute shell commands.
- `PLAN Mode` is read-only. It analyzes the codebase and produces structured implementation plans without changing files.
- Switch modes inside chat with `/mode`, `/plan`, `/build`, or at launch with `-M plan` / `-M build`.

### Providers and Models

Supported provider paths:

- **Google Gemini:** `gemini`, configured through Google AI Studio.
- **OpenRouter:** `openrouter`, including free `:free` model routes.
- **Custom OpenAI-compatible:** DeepSeek, Groq, Cerebras, Ollama, local servers, and other compatible APIs.
- **Zero-key starter:** built-in Pollinations-backed fallback for quick non-interactive use.

Useful commands:

```bash
iubcli config     # interactive provider/key/model setup
iubcli guide      # free API key and model guide
iubcli limits     # token, context, and rate-limit reference
iubcli agent      # model selector
iubcli doctor     # environment diagnostics
```

### Resilience

- Automatic model cascade on rate limits, quota exhaustion, provider errors, or unavailable models.
- Model explorer can scan candidates for active free tokens.
- Rolling cooldown keeps long-running tasks alive instead of dropping immediately.
- Escape key aborts generation and cleans up terminal state.

### Workspace Intelligence

The agent has 12 built-in tools:

- `list_files`
- `read_file`
- `write_file`
- `edit_file`
- `run_command`
- `grep_search`
- `find_files`
- `fetch_url`
- `web_search`
- `list_peers`
- `peer_call_tool`
- `peer_send_message`

It also includes project detection for framework, package manager, TypeScript/Tailwind usage, scripts, and workspace structure.

### Terminal UX

- Sticky terminal header with provider, model, mode, mesh role, and workspace path.
- Markdown rendering for model output.
- Interactive selects, masked inputs, bracketed-paste protection, `@file` mentions, image paste, and URL ingestion.
- Status commands for session stats, git state, directory tree, diffs, undo, and token renewal countdown.

### Cross-Instance Mesh

Multiple IUB CLI instances can discover each other on localhost and exchange structured messages or remote tool calls. This is useful for separate frontend/backend workspaces.

---

## Quick Start

### Installation

Install globally:

```bash
npm install -g iubcli
```

Or run without installing:

```bash
npx iubcli
```

### First Run

Start the interactive CLI:

```bash
iubcli
```

On first use, the setup wizard walks you through provider selection, API key entry, model choice, and endpoint configuration.

Recommended free providers:

1. **Google Gemini** - [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. **OpenRouter** - [openrouter.ai/keys](https://openrouter.ai/keys)
3. **Groq** - [console.groq.com/keys](https://console.groq.com/keys)
4. **DeepSeek** - [platform.deepseek.com](https://platform.deepseek.com)
5. **Ollama local** - [ollama.com](https://ollama.com), then use `http://localhost:11434/v1`

For non-interactive or single-prompt runs, IUB CLI can auto-detect local Ollama or fall back to the built-in zero-key starter model.

### Common Launches

Interactive mode:

```bash
iubcli
```

Start in PLAN mode:

```bash
iubcli -M plan
```

Auto-approve file writes and shell commands:

```bash
iubcli -y
```

Run one prompt and exit:

```bash
iubcli -p "Build a small Express REST API with JWT auth" -y
```

Start a mesh peer:

```bash
iubcli --role frontend
iubcli --role backend
```

---

## CLI Usage

```text
Usage: iubcli [options] [command]

Options:
  -v, --version          Output current version
  -m, --model <model>    Override model for this session
  -M, --mode <mode>      Execution mode: "build" (default) or "plan"
  -p, --prompt <prompt>  Run a single prompt and exit
  -y, --yes              Auto-approve all file writes and shell commands
  -r, --role <role>      Instance role for cross-instance mesh
      --mesh-port <port> Local port for mesh broker (default: 49152)
      --mesh-token <token> Shared authentication token for mesh
      --no-mesh          Disable cross-instance mesh networking
  -h, --help             Display help for command

Commands:
  config                 Run interactive setup wizard
  guide, keys            Display free API keys and models guide
  limits, limit, tokens, quota, quotas
                         Display token limits and rate-limit reference
  agent, model           OpenCode-style agent and model selector
  mode                   Display BUILD and PLAN mode guide
  about, developer       Display creator, GitHub, and project details
  renewal, countdown     Display token renewal countdown and schedules
  doctor, check          Run environment diagnostics
  stats, cost            Display session stats view
  peers, mesh            Discover connected mesh peers
```

---

## Slash Commands

Inside interactive chat:

| Command | Description |
| --- | --- |
| `/mode` | Toggle or select BUILD/PLAN mode |
| `/plan` | Switch to PLAN mode |
| `/build` | Switch to BUILD mode |
| `/agent`, `/model`, `/models`, `/m` | Open model/agent selector or switch model |
| `/provider` | Change provider configuration |
| `/config` | Run the full setup wizard |
| `/explore`, `/find-model`, `/scan`, `/free` | Scan models for active free tokens |
| `/image`, `/screenshot`, `/pic`, `/paste-image` | Stage clipboard or file image input |
| `/task`, `/urgent`, `/priority` | Dispatch a priority task |
| `/limits`, `/limit`, `/tokens`, `/quota` | Show token limits and quotas |
| `/guide`, `/keys` | Show free API key guide |
| `/renewal`, `/countdown`, `/renew` | Show quota renewal countdown |
| `/doctor`, `/check` | Run diagnostics |
| `/stats`, `/cost` | Show live session stats |
| `/diff`, `/changes` | Show session file changes |
| `/undo` | Revert the latest agent file change |
| `/git` | Show git branch, changes, and recent commits |
| `/tree` | Show workspace directory tree |
| `/detect`, `/stack` | Show detected project stack |
| `/compact` | Compact conversation history |
| `/session`, `/status` | Show active session status |
| `/peers`, `/mesh` | Show connected mesh peers |
| `/role` | View or change mesh role |
| `/send`, `/msg` | Send a message to a mesh peer |
| `/about`, `/developer`, `/creator` | Show project and developer info |
| `/clear`, `/cls`, `/reset` | Clear conversation history |
| `/exit`, `/quit` | Exit IUB CLI |
| `/help` | Show slash-command help |

---

## Bring Your Own Key (BYOK)

IUB CLI does not require a subscription. You can connect free or paid provider keys depending on your needs.

### Google Gemini

- Key URL: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Good for: fast general coding, large context, tool calling.
- Setup: choose Google Gemini in `iubcli config` or `/config`.

### OpenRouter

- Key URL: [openrouter.ai/keys](https://openrouter.ai/keys)
- Good for: many free `:free` models and easy provider switching.
- Examples: `openrouter/free`, `particle-ai/particle-1:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free`.

### DeepSeek

- Key URL: [platform.deepseek.com](https://platform.deepseek.com)
- Setup: choose Custom OpenAI-Compatible and use `https://api.deepseek.com/v1`.
- Models: `deepseek-chat`, `deepseek-reasoner`, and related DeepSeek endpoints.

### Groq

- Key URL: [console.groq.com/keys](https://console.groq.com/keys)
- Setup: choose Custom OpenAI-Compatible and use `https://api.groq.com/openai/v1`.
- Good for: very fast inference on supported open models.

### Cerebras

- Key URL: [cloud.cerebras.ai](https://cloud.cerebras.ai)
- Setup: choose Custom OpenAI-Compatible and use `https://api.cerebras.ai/v1`.
- Good for: low-latency inference on supported models.

### Ollama / Local Models

- Download: [ollama.com](https://ollama.com)
- Example:

```bash
ollama run qwen2.5-coder
ollama run deepseek-r1
```

- IUB CLI setup: Custom OpenAI-Compatible, base URL `http://localhost:11434/v1`, API key can be any string such as `ollama`.
- Benefit: local, private, and not dependent on hosted rate limits.

### Zero-Key Fallback

For quick non-interactive use, IUB CLI can start with a built-in free starter endpoint when no key is configured. For serious coding work, configure Gemini, OpenRouter, DeepSeek, Groq, Cerebras, or Ollama for better tool calling and quotas.

---

## Safety Model

In BUILD mode, file writes, edits, and shell commands can require confirmation before execution. Use `-y` or the auto-approve option only in trusted directories.

PLAN mode blocks mutation tools entirely, making it safer for architecture review and planning.

---

## Project Architecture

```text
iubcli/
├── src/
│   ├── index.ts       # CLI entry point, commander commands, interactive loop
│   ├── agent.ts       # model orchestration, cascade, retries, tool loop
│   ├── tools.ts       # workspace tools and safety confirmations
│   ├── prompt.ts      # terminal input, sticky UI, selects, paste handling
│   ├── ui.ts          # banner, markdown rendering, reports, help
│   ├── config.ts      # local config, provider defaults, verification
│   ├── models.ts      # model presets and interactive selector
│   ├── explorer.ts    # free-model discovery
│   ├── detector.ts    # project stack detection
│   ├── image.ts       # clipboard/file image payload loading
│   └── mesh.ts        # cross-instance peer networking
├── scripts/
│   ├── test-tools.ts
│   ├── test-image.ts
│   ├── test-box.ts
│   └── test-gemini-tools.ts
├── public/
│   └── index.html     # project landing page
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Development

Clone the repository:

```bash
git clone https://github.com/Ifaz2611/iubcli.git
cd iubcli
npm install
```

Run checks:

```bash
npm run typecheck
npm test
npm run build
```

Link locally for manual testing:

```bash
npm link
iubcli --help
```

Package scripts:

- `npm run build` - bundle with `tsup`
- `npm run dev` - watch-mode bundling
- `npm run typecheck` - TypeScript check
- `npm test` - run local tool/image/box test scripts
- `npm start` - run the built CLI
- `npm run prepublishOnly` - typecheck, test, and build before publish

---

## License

[MIT](license)

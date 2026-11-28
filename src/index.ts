#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  getAppVersion,
  getConfig,
  promptConfig,
  switchProviderInteractive,
  saveConfig,
  hasSavedConfig,
  createZeroKeyConfig,
  detectLocalOllamaModels,
  formatProviderLabel,
  isKeylessConfig,
  POLLINATIONS_FREE_API_KEY,
  IUBCLIConfig,
} from './config.js';
import { IUBAgent } from './agent.js';
import {
  printBanner,
  renderMarkdown,
  showHelp,
  showFreeApiKeyGuide,
  showTokenLimitsGuide,
  renderStatusBar,
  renderPriorityTaskBanner,
  renderInterruptedNotice,
  renderDoctorReport,
  renderSessionStats,
  renderGitStatus,
  renderDirectoryTree,
  showAbout,
  renderAllTokensExhaustedReport,
} from './ui.js';
import { safetySession, getSessionChanges, undoLastChange, setActiveMeshNode, getActiveMeshNode, executeTool } from './tools.js';
import { selectAgentModelInteractive, findModelByQuery, applyModelDirect } from './models.js';
import {
  readOpenCodePrompt,
  expandOpenCodeMentions,
  restoreTerminalViewport,
  updateFixedBottomStatus,
  deactivateFixedDock,
  updateDockedModel,
  prepareInteractiveArea,
  interactiveSelect,
  isInteractivePromptActive,
  isDockedPromptWaiting,
} from './prompt.js';
import { detectProjectContext } from './detector.js';
import { MeshNode } from './mesh.js';
import { captureClipboardImage, loadImagePayload, isImageFile, type ImagePayload } from './image.js';
import { exploreAndSelectFreeModel } from './explorer.js';

// Ensure terminal viewport & mesh connections are cleanly restored on process exit
function gracefulExit(code = 0): void {
  process.exitCode = code;
  try {
    getActiveMeshNode()?.stop();
    deactivateFixedDock();
    restoreTerminalViewport();
    process.stdin.pause();
    (process.stdin as any).unref?.();
  } catch {}
  setTimeout(() => process.exit(code), 40);
}

async function runDoctorDiagnostics(config: IUBCLIConfig): Promise<void> {
  const checks: { name: string; status: 'ok' | 'warn' | 'error'; detail: string }[] = [];

  const nodeVer = process.version;
  const major = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
  checks.push({
    name: 'Node.js Runtime',
    status: major >= 18 ? 'ok' : 'error',
    detail: `${nodeVer} (Node 18+ required for modern async streams)`,
  });

  const hasKey = isKeylessConfig(config) || Boolean(config.apiKey && config.apiKey.trim().length > 5);
  checks.push({
    name: 'AI Provider & Key',
    status: hasKey ? 'ok' : 'error',
    detail: `${formatProviderLabel(config)} with model "${config.model}" (${
      isKeylessConfig(config) ? 'Zero-Key Active' : hasKey ? 'Configured' : 'Missing API Key'
    })`,
  });

  try {
    const testFile = path.resolve(process.cwd(), '.iubcli_check.tmp');
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    checks.push({
      name: 'Workspace Read/Write',
      status: 'ok',
      detail: `${process.cwd()} (Read/Write verified)`,
    });
  } catch (e: any) {
    checks.push({
      name: 'Workspace Read/Write',
      status: 'error',
      detail: `Cannot write to ${process.cwd()}: ${e.message}`,
    });
  }

  try {
    const gitVer = execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    checks.push({
      name: 'Git CLI',
      status: 'ok',
      detail: gitVer || 'Available',
    });
  } catch {
    checks.push({
      name: 'Git CLI',
      status: 'warn',
      detail: 'git not found in PATH (/git command disabled)',
    });
  }

  const ollamaModels = await detectLocalOllamaModels(400);
  checks.push({
    name: 'Local Ollama',
    status: ollamaModels.length > 0 ? 'ok' : 'warn',
    detail:
      ollamaModels.length > 0
        ? `Running on localhost:11434 (${ollamaModels.length} model(s): ${ollamaModels.slice(0, 3).join(', ')})`
        : 'Not detected on localhost:11434 (optional offline fallback)',
  });

  checks.push({
    name: 'OS & Execution Shell',
    status: 'ok',
    detail: `${process.platform} (${process.arch}) with non-interactive child process safety`,
  });

  renderDoctorReport(checks);
}

process.on('exit', () => {
  getActiveMeshNode()?.stop();
  deactivateFixedDock();
  restoreTerminalViewport();
});
process.on('SIGINT', () => {
  getActiveMeshNode()?.stop();
  deactivateFixedDock();
  restoreTerminalViewport();
  process.exit(0);
});
process.on('SIGTERM', () => {
  getActiveMeshNode()?.stop();
  deactivateFixedDock();
  restoreTerminalViewport();
  process.exit(0);
});

/**
 * Real-time Escape key listener during agent thinking / tool execution.
 * When user presses Escape, invokes onEscape() to abort cleanly.
 */
function attachEscapeListener(onEscape: () => void): () => void {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {}

  let triggered = false;
  const triggerEscape = () => {
    if (triggered) return;
    triggered = true;
    onEscape();
  };

  const onData = (chunk: Buffer | string) => {
    if (isInteractivePromptActive()) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Escape key is single byte 0x1B (ESC)
    if (buf.length === 1 && buf[0] === 0x1b) {
      triggerEscape();
    } else if (buf.length === 1 && buf[0] === 0x03) {
      // Ctrl+C
      process.exit(0);
    }
  };

  const keypressHandler = (str: string, key: any) => {
    if (isInteractivePromptActive()) return;
    if (
      (key && key.name === 'escape') ||
      str === '\x1b' ||
      str === '\u001b' ||
      (key && key.sequence === '\x1b')
    ) {
      triggerEscape();
    } else if (key && key.ctrl && key.name === 'c') {
      process.exit(0);
    }
  };

  process.stdin.on('data', onData);
  process.stdin.on('keypress', keypressHandler);

  return () => {
    process.stdin.removeListener('data', onData);
    process.stdin.removeListener('keypress', keypressHandler);
    try {
      if (!wasRaw && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {}
  };
}

const program = new Command();

program
  .name('iubcli')
  .description('IUB CLI — Next-Gen Autonomous BYOK terminal coding agent.')
  .version(getAppVersion(), '-v, --version', 'Output the current version')
  .option('-m, --model <model>', 'Override model for this session')
  .option('-M, --mode <mode>', 'Execution mode: "build" (default) or "plan"', 'build')
  .option('-p, --prompt <prompt>', 'Run a single prompt and exit')
  .option('-y, --yes', 'Auto-approve all file writes and shell commands')
  .option('-r, --role <role>', 'Instance role for cross-instance mesh (e.g. "frontend", "backend")')
  .option('--mesh-port <port>', 'Local port for mesh broker', '49152')
  .option('--mesh-token <token>', 'Shared authentication token for mesh')
  .option('--no-mesh', 'Disable cross-instance mesh networking')
  .action(async (options) => {
    const rawMode = String(options.mode || 'build').toLowerCase().trim();
    if (rawMode !== 'build' && rawMode !== 'plan') {
      console.error(chalk.red(`\nInvalid --mode "${options.mode}". Expected "build" or "plan".\n`));
      process.exit(1);
    }

    let parsedMeshPort: number | undefined;
    if (options.meshPort !== undefined) {
      const p = Number(options.meshPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        console.error(chalk.red(`\nInvalid --mesh-port "${options.meshPort}". Expected an integer between 1 and 65535.\n`));
        process.exit(1);
      }
      parsedMeshPort = p;
    }

    if (options.yes) {
      safetySession.autoApproveAll = true;
    }

    // Check for existing configuration (also hydrates .env / .env.local keys)
    let config = getConfig();

    if (!config) {
      if (!process.stdin.isTTY || options.prompt) {
        const localOllama = await detectLocalOllamaModels(600);
        if (localOllama.length > 0) {
          config = {
            provider: 'custom',
            apiKey: 'ollama',
            model: localOllama[0],
            baseURL: 'http://localhost:11434/v1',
          };
          console.log(chalk.cyan(` Auto-detected Local Ollama (${localOllama[0]}).`));
        } else {
          config = createZeroKeyConfig();
          console.log(
            chalk.cyan(
              ' No API key configured — starting with Free Zero-Key AI. Run "iubcli config" anytime to add a free Gemini key.'
            )
          );
        }
      } else {
        const prompted = await promptConfig(true);
        if (!prompted) {
          console.log(chalk.yellow('\nSetup cancelled. Exiting.\n'));
          process.exit(0);
        }
        config = prompted;
      }
    }

    if (options.model) {
      config.model = options.model;
    }

    const initialMode: 'build' | 'plan' = rawMode === 'plan' ? 'plan' : 'build';
    const agent = new IUBAgent(config, initialMode);

    // Initialize Cross-Instance Mesh Node
    let meshNode: MeshNode | null = null;
    if (options.mesh !== false) {
      meshNode = new MeshNode({
        role: options.role,
        port: parsedMeshPort,
        token: options.meshToken,
        mode: initialMode,
        model: config.model,
        provider: config.provider,
        workspace: process.cwd(),
        onRemoteToolExecution: async (tool, args, fromRole) => {
          console.log(chalk.cyan(`\n[Mesh RPC from ${chalk.bold(fromRole)}] Executing tool: ${chalk.bold(tool)}`));
          updateFixedBottomStatus(`[Mesh: ${fromRole}] Executing ${tool}...`, {
            mode: agent.getMode(),
            model: config?.model || 'unknown',
          });
          const result = await executeTool(tool, args, agent.getMode());
          updateFixedBottomStatus('', { mode: agent.getMode(), model: config?.model || 'unknown' });
          return result;
        },
        onPeerMessage: (message, fromRole) => {
          console.log(
            chalk.bgHex('#002B5C').hex('#00A3FF').bold(`\n [Mesh Message from ${fromRole}]: `) +
              chalk.white(message) + '\n'
          );
        },
        onPeerConnect: (peer) => {
          if (isDockedPromptWaiting()) {
            updateDockedModel(
              formatProviderLabel(config),
              config?.model || 'gemini-3.5-flash-lite',
              agent.getMode()
            );
            return;
          }
          console.log(
            chalk.green(`\n[Mesh] Connected to peer [${chalk.bold(peer.role)}] (${peer.workspace})\n`)
          );
          updateFixedBottomStatus(`Peer connected: ${peer.role}`, {
            mode: agent.getMode(),
            model: config?.model || 'unknown',
          });
        },
        onPeerDisconnect: (peer) => {
          if (isDockedPromptWaiting()) {
            updateDockedModel(
              formatProviderLabel(config),
              config?.model || 'gemini-3.5-flash-lite',
              agent.getMode()
            );
            return;
          }
          console.log(
            chalk.yellow(`\n[Mesh] Peer disconnected: [${chalk.bold(peer.role)}] (${peer.workspace})\n`)
          );
        },
      });

      await meshNode.start();
      setActiveMeshNode(meshNode);
    }

    // Sync session config when agent auto-cascades to another model.
    // Use the agent's live config snapshot so key/baseURL always match the active
    // provider (especially for the keyless Pollinations fallback, which shares the
    // `custom` slot with any real user endpoint).
    agent.setOnModelChange((newModel, newProvider, activeConfig) => {
      if (activeConfig) {
        // Keep the exact live object so the agent and interactive loop stay in sync.
        config = activeConfig;
      } else if (config) {
        config.model = newModel;
        if (newProvider) {
          config.provider = newProvider as any;
          if (config.provider === 'gemini') {
            delete (config as any).baseURL;
          } else if (config.provider === 'openrouter') {
            config.baseURL = 'https://openrouter.ai/api/v1';
          }
        }
      }
      if (config) {
        if (hasSavedConfig() || config.apiKey !== POLLINATIONS_FREE_API_KEY) {
          saveConfig(config);
        }
        meshNode?.updateState({ model: newModel });
        updateDockedModel(
          formatProviderLabel(config),
          config.model,
          agent.getMode()
        );
      }
    });

    // If single prompt mode is active (-p / --prompt)
    if (options.prompt) {
      console.log(
        chalk.cyan(
          `\nRunning single prompt with ${formatProviderLabel(config)} (${config.model}) in [${initialMode.toUpperCase()} MODE]:`
        )
      );
      console.log(chalk.white(options.prompt) + '\n');
      const abortController = new AbortController();
      let hasAborted = false;
      const detachEscape = attachEscapeListener(() => {
        if (hasAborted) return;
        hasAborted = true;
        abortController.abort();
        renderInterruptedNotice();
      });
      try {
        const { expandedPrompt, attachedImages } = await expandOpenCodeMentions(options.prompt);
        const reply = await agent.chat(expandedPrompt, {
          signal: abortController.signal,
          images: attachedImages,
        });
        if (abortController.signal.aborted) {
          renderInterruptedNotice();
        } else {
          console.log('\n' + renderMarkdown(reply) + '\n');
        }
      } catch (err: any) {
        if (abortController.signal.aborted) {
          renderInterruptedNotice();
        } else {
          console.error(chalk.red(`\nError: ${err.message}\n`));
          process.exitCode = 1;
        }
      } finally {
        detachEscape();
        updateFixedBottomStatus('', { mode: agent.getMode(), model: config.model });
        meshNode?.stop();
      }
      gracefulExit(process.exitCode ? Number(process.exitCode) : 0);
      return;
    }

    // Show banner ONCE at startup (never pinned, never repeated)
    printBanner(formatProviderLabel(config), config.model, process.cwd());

    let running = true;
    let stagedImages: ImagePayload[] = [];
    while (running) {
      // OpenCode & Antigravity Interactive Boxed Prompt
      // Features: Terminal Bottom Framed Box with Mode & Model badges,
      // Bracketed paste protection, multiline Shift+Enter, Esc to abort.
      const input = await readOpenCodePrompt({
        mode: agent.getMode(),
        model: config.model,
        provider: config.provider,
      });

      if (input === null) {
        console.log(chalk.yellow('\nGoodbye! Exiting IUB CLI.\n'));
        gracefulExit(0);
        return;
      }

      let trimmed = input.trim();
      if (trimmed.length === 0) {
        continue;
      }
      // Strip accidental leading prompt arrows when followed by a slash command (e.g. "> /agent", "❯ /exit")
      if (/^[>❯$#\s]+\//.test(trimmed)) {
        trimmed = trimmed.replace(/^[>❯$#\s]+/, '').trim();
      }

      // Case-insensitive normalized command
      const lowerCmd = trimmed.toLowerCase();

      // Handle Slash Commands
      if (lowerCmd === '/exit' || lowerCmd === '/quit') {
        console.log(chalk.hex('#00A3FF')('\nThanks for using IUB CLI. Happy coding! \n'));
        gracefulExit(0);
        return;
      }

      if (lowerCmd === '/help') {
        showHelp();
        continue;
      }

      if (
        lowerCmd === '/explore' ||
        lowerCmd === '/find-model' ||
        lowerCmd === '/scan' ||
        lowerCmd === '/free-tokens' ||
        lowerCmd === '/free'
      ) {
        const found = await exploreAndSelectFreeModel(config);
        if (found) {
          agent.updateConfig(config);
          meshNode?.updateState({ model: config.model });
          updateDockedModel(
            formatProviderLabel(config),
            config.model,
            agent.getMode()
          );
        } else {
          console.log(chalk.yellow('\nAll free models currently have zero available quota across all providers.\n'));
        }
        continue;
      }

      if (
        lowerCmd === '/image' ||
        lowerCmd.startsWith('/image ') ||
        lowerCmd === '/screenshot' ||
        lowerCmd.startsWith('/screenshot ') ||
        lowerCmd === '/pic' ||
        lowerCmd.startsWith('/pic ') ||
        lowerCmd === '/paste-image' ||
        lowerCmd.startsWith('/paste-image ')
      ) {
        const rawArg = trimmed.replace(/^\/(image|screenshot|pic|paste-image)\s*/i, '').trim();
        let capturedPath: string | null = null;

        if (rawArg.length > 0) {
          const cleanArg = rawArg.replace(/^["']|["']$/g, '').trim();
          const resolved = path.isAbsolute(cleanArg) ? cleanArg : path.resolve(process.cwd(), cleanArg);
          if (fs.existsSync(resolved) && isImageFile(resolved)) {
            capturedPath = resolved;
          } else {
            console.log(chalk.red(`\nCould not find image file at: ${cleanArg}\n`));
            continue;
          }
        } else {
          process.stdout.write(chalk.cyan('\nChecking system clipboard for screenshot / image...\n'));
          capturedPath = captureClipboardImage();
        }

        if (capturedPath) {
          const payload = loadImagePayload(capturedPath);
          if (payload) {
            stagedImages.push(payload);
            const kb = (payload.size / 1024).toFixed(1);
            console.log(
              '\n' +
                chalk.bgHex('#002B5C').hex('#00A3FF').bold('  IMAGE STAGED SUCCESSFULLY ') +
                '\n' +
                `  ${chalk.gray('File:')} ${chalk.white(path.basename(payload.path))}\n` +
                `  ${chalk.gray('Format:')} ${chalk.cyan(payload.mimeType)} (${kb} KB)\n` +
                `  ${chalk.gray('Saved to:')} ${chalk.dim(payload.path)}\n\n` +
                chalk.green.bold('Ready!') +
                chalk.white(' Type your question or prompt (e.g. "Explain this error" or "Code this UI") and press Enter.\n')
            );
          } else {
            console.log(chalk.yellow('\nCould not read image payload (file might be damaged or larger than 15MB).\n'));
          }
        } else {
          console.log(
            '\n' +
              chalk.bgHex('#FF9900').black.bold('  NO IMAGE FOUND IN CLIPBOARD ') +
              '\n' +
              chalk.white('No image data was found in your clipboard.\n\n') +
              chalk.yellow('How to paste a screenshot:') +
              '\n' +
              `  1. Take a screenshot: ${chalk.bold('Win + Shift + S')} on Windows, or ${chalk.bold('Cmd + Shift + 4')} on macOS\n` +
              `  2. Return here and run ${chalk.cyan.bold('/image')}\n` +
              `  3. Or mention an image file: ${chalk.cyan.bold('@screenshot.png')} or drag-and-drop the image path into prompt.\n`
          );
        }
        continue;
      }

      if (lowerCmd === '/about' || lowerCmd === '/developer' || lowerCmd === '/creator') {
        showAbout();
        continue;
      }

      if (lowerCmd === '/renewal' || lowerCmd === '/countdown' || lowerCmd === '/renew') {
        renderAllTokensExhaustedReport();
        continue;
      }

      // Mode Switching (OpenCode Style)
      if (lowerCmd === '/mode') {
        prepareInteractiveArea(
          formatProviderLabel(config),
          config.model,
          agent.getMode()
        );
        const modeChoice = await interactiveSelect<'build' | 'plan'>({
          message: 'Select Agent Mode (OpenCode Style):',
          initialValue: agent.getMode(),
          options: [
            {
              value: 'build',
              label: 'BUILD Mode (Autonomous Full-Stack Coding)',
              hint: 'Full tool access: inspect, create/update files & run terminal commands',
            },
            {
              value: 'plan',
              label: 'PLAN Mode (Senior Architect & Planning)',
              hint: 'Read-only: inspect files, explore architecture & design step-by-step plans',
            },
          ],
        });

        if (modeChoice) {
          agent.setMode(modeChoice);
          meshNode?.updateState({ mode: modeChoice });
          updateDockedModel(formatProviderLabel(config), config.model, modeChoice);
          console.log(chalk.green(`\nAgent mode switched to: ${modeChoice === 'build' ? 'BUILD Mode' : 'PLAN Mode'}\n`));
        }
        continue;
      }

      if (
        lowerCmd === '/plan' ||
        lowerCmd === '/mode plan' ||
        lowerCmd === 'plan mode' ||
        lowerCmd === 'switch to plan mode' ||
        lowerCmd === 'switch plan'
      ) {
        agent.setMode('plan');
        meshNode?.updateState({ mode: 'plan' });
        updateDockedModel(
          formatProviderLabel(config),
          config.model,
          'plan'
        );
        console.log(chalk.hex('#FFB300')('\nActive mode switched to PLAN MODE (Senior Architect & Read-Only Planning).\n'));
        continue;
      }

      if (
        lowerCmd === '/build' ||
        lowerCmd === '/mode build' ||
        lowerCmd === 'build mode' ||
        lowerCmd === 'switch to build mode' ||
        lowerCmd === 'switch build'
      ) {
        agent.setMode('build');
        meshNode?.updateState({ mode: 'build' });
        updateDockedModel(
          formatProviderLabel(config),
          config.model,
          'build'
        );
        console.log(chalk.hex('#00A3FF')('\nActive mode switched to BUILD MODE (Autonomous Full-Stack Coding & Execution Enabled).\n'));
        continue;
      }

      if (lowerCmd.includes('you are in build mode') && agent.getMode() !== 'build') {
        agent.setMode('build');
        meshNode?.updateState({ mode: 'build' });
        updateDockedModel(
          formatProviderLabel(config),
          config.model,
          'build'
        );
      }

      if (lowerCmd === '/guide' || lowerCmd === '/keys') {
        showFreeApiKeyGuide();
        continue;
      }

      const cleanCmd = lowerCmd.replace(/[\s\-_]+/g, '');
      if (
        cleanCmd === '/limits' ||
        cleanCmd === '/limit' ||
        cleanCmd === '/tokens' ||
        cleanCmd === '/token' ||
        cleanCmd === '/quota' ||
        cleanCmd === '/quotas' ||
        lowerCmd.startsWith('/limits') ||
        lowerCmd.startsWith('/limit') ||
        lowerCmd.startsWith('/ limits') ||
        lowerCmd.startsWith('/ limit')
      ) {
        showTokenLimitsGuide();
        continue;
      }

      if (lowerCmd === '/stats' || lowerCmd === '/cost') {
        const metrics = agent.getSessionMetrics();
        const changes = getSessionChanges();
        renderSessionStats({
          model: config.model,
          provider: formatProviderLabel(config),
          mode: agent.getMode(),
          totalTokens: metrics.totalTokens,
          promptTokens: metrics.promptTokens,
          completionTokens: metrics.completionTokens,
          totalRequests: metrics.totalRequests,
          estimatedCostSavedUsd: metrics.estimatedCostSavedUsd,
          filesTouched: changes.length,
        });
        continue;
      }

      if (lowerCmd === '/doctor' || lowerCmd === '/check') {
        await runDoctorDiagnostics(config);
        continue;
      }

      if (lowerCmd === '/diff' || lowerCmd === '/changes') {
        const changes = getSessionChanges();
        if (changes.length === 0) {
          console.log(chalk.yellow('\n No file modifications or creations recorded in this session.\n'));
        } else {
          console.log('\n' + chalk.bold.hex('#00A3FF')('Files Modified / Created in this Session:'));
          console.log(chalk.dim('─'.repeat(60)));
          changes.forEach((c, idx) => {
            const status = c.isNew ? chalk.green('[NEW]') : chalk.yellow('[MODIFIED]');
            const lineCount = c.newContent.split('\n').length;
            console.log(`  ${idx + 1}. ${status} ${chalk.cyan.bold(c.filePath)} ${chalk.dim(`(${lineCount} lines, ${c.newContent.length} bytes)`)}`);
          });
          console.log(chalk.dim('─'.repeat(60)) + '\n');
        }
        continue;
      }

      if (lowerCmd === '/undo') {
        const result = undoLastChange();
        if (result.success) {
          console.log(chalk.green(`\n${result.message}\n`));
        } else {
          console.log(chalk.yellow(`\n ${result.message}\n`));
        }
        continue;
      }

      if (lowerCmd === '/git') {
        renderGitStatus();
        continue;
      }

      if (lowerCmd === '/tree' || lowerCmd.startsWith('/tree ')) {
        const treeArgs = trimmed.slice(5).trim();
        if (!treeArgs) {
          renderDirectoryTree();
        } else {
          const parts = treeArgs.split(/\s+/);
          const maybeDepth = Number(parts[0]);
          if (parts.length === 1 && Number.isInteger(maybeDepth) && maybeDepth > 0 && maybeDepth <= 6) {
            renderDirectoryTree('.', maybeDepth);
          } else {
            const targetDir = parts[0];
            const depth = parts[1] && Number.isInteger(Number(parts[1])) ? Math.min(6, Math.max(1, Number(parts[1]))) : 2;
            renderDirectoryTree(targetDir, depth);
          }
        }
        continue;
      }

      if (lowerCmd === '/detect' || lowerCmd === '/stack') {
        const ctx = detectProjectContext();
        console.log('\n' + chalk.bold.hex('#00A3FF')('Detected Workspace Environment'));
        console.log(chalk.dim('─'.repeat(60)));
        console.log(ctx.summary.split('\n').slice(1).map(l => '  ' + l).join('\n'));
        console.log(chalk.dim('─'.repeat(60)) + '\n');
        continue;
      }

      if (lowerCmd === '/compact') {
        const result = agent.compactHistory();
        console.log(
          chalk.green(
            `\nConversation history compacted!\n` +
              `Turns before: ${chalk.yellow(result.turnsBefore)} -> Turns after: ${chalk.green(result.turnsAfter)}\n` +
              `Context window optimized for faster responses and lower token load.\n`
          )
        );
        continue;
      }

      if (lowerCmd === '/session' || lowerCmd === '/status') {
        const changes = getSessionChanges();
        const mem = agent.getHistoryStats();
        console.log('\n' + chalk.bold.hex('#00A3FF')('Active Session Status (OpenCode Style)'));
        console.log(chalk.dim('─'.repeat(60)));
        console.log(`  ${chalk.gray('Provider:')}       ${chalk.bold(formatProviderLabel(config))}`);
        console.log(`  ${chalk.gray('Active Model:')}   ${chalk.cyan.bold(config.model)}`);
        console.log(`  ${chalk.gray('Active Mode:')}    ${agent.getMode() === 'build' ? chalk.green.bold('BUILD') : chalk.yellow.bold('PLAN')}`);
        console.log(`  ${chalk.gray('Working Dir:')}    ${chalk.white(process.cwd())}`);
        console.log(`  ${chalk.gray('Files Touched:')}  ${chalk.yellow(changes.length)} files`);
        console.log(`  ${chalk.gray('Auto-Approve:')}   ${safetySession.autoApproveAll ? chalk.green('Enabled (-y)') : chalk.gray('Confirm per action')}`);
        console.log(`  ${chalk.gray('Memory Turns:')}   ${chalk.cyan(mem.openAIMessageCount + mem.geminiTurnCount)} turns`);
        console.log(chalk.dim('─'.repeat(60)) + '\n');
        continue;
      }

      if (lowerCmd === '/peers' || lowerCmd === '/mesh') {
        const mesh = getActiveMeshNode();
        if (!mesh) {
          console.log(chalk.yellow('\nCross-instance mesh is disabled on this instance (--no-mesh).\n'));
        } else {
          const allPeers = mesh.listPeers();
          const remotePeers = allPeers.filter((p) => p.nodeId !== mesh.nodeId);
          console.log('\n' + chalk.bold.hex('#00A3FF')('Cross-Instance Workspace Mesh (Multi-Agent Sync)'));
          console.log(chalk.dim('─'.repeat(70)));
          console.log(`  ${chalk.bold('This Instance:')}  [${chalk.cyan.bold(mesh.role.toUpperCase())}] (Node: ${chalk.gray(mesh.nodeId)})`);
          console.log(`  ${chalk.gray('Workspace:')}      ${mesh.workspace}`);
          console.log(`  ${chalk.gray('Mesh Status:')}    ${mesh['isHost'] ? chalk.green('Broker Host') : chalk.blue('Peer Client')} on 127.0.0.1:${mesh.port}`);
          console.log(`  ${chalk.gray('Active Mode:')}   ${mesh.mode === 'build' ? chalk.green('BUILD') : chalk.yellow('PLAN')}`);
          console.log(chalk.dim('─'.repeat(70)));
          if (remotePeers.length === 0) {
            console.log(chalk.yellow(`  No other IUB CLI instances connected yet.`));
            console.log(chalk.gray(`  Tip: Open another terminal in your backend/frontend repo and run "iubcli --role backend"!\n`));
          } else {
            console.log(chalk.bold(`  Connected Peers (${remotePeers.length}):`));
            remotePeers.forEach((p, idx) => {
              const roleBadge = chalk.bold.hex('#00A3FF')(`[${p.role.toUpperCase()}]`);
              const modeBadge = p.mode === 'build' ? chalk.green('BUILD') : chalk.yellow('PLAN');
              console.log(`  ${idx + 1}. ${roleBadge} (nodeId: ${chalk.gray(p.nodeId)})`);
              console.log(`     Workspace: ${chalk.white(p.workspace)}`);
              console.log(`     Mode: ${modeBadge}  •  Model: ${chalk.cyan(p.model)} (${p.provider})`);
            });
            console.log(chalk.dim('─'.repeat(70)) + '\n');
          }
        }
        continue;
      }

      if (lowerCmd === '/role' || lowerCmd.startsWith('/role ')) {
        const parts = trimmed.split(/\s+/);
        const mesh = getActiveMeshNode();
        if (!mesh) {
          console.log(chalk.yellow('\nMesh is not active on this instance.\n'));
          continue;
        }
        if (parts.length > 1) {
          const newRole = parts.slice(1).join('-').trim();
          mesh.updateState({ role: newRole });
          console.log(chalk.green(`\nInstance role updated to: [${chalk.bold(newRole)}]\n`));
        } else {
          console.log(chalk.cyan(`\nCurrent instance role: [${chalk.bold(mesh.role)}] (Usage: /role <frontend|backend|name>)\n`));
        }
        continue;
      }

      if (lowerCmd === '/send' || lowerCmd === '/msg' || lowerCmd.startsWith('/send ') || lowerCmd.startsWith('/msg ')) {
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) {
          console.log(chalk.yellow('\nUsage: /send <role|nodeId> <message>\nExample: /send backend Please implement /api/users route.\n'));
          continue;
        }
        const target = parts[1];
        const msg = parts.slice(2).join(' ');
        const mesh = getActiveMeshNode();
        if (!mesh) {
          console.log(chalk.yellow('\nMesh is not active on this instance.\n'));
          continue;
        }
        const result = await mesh.sendMessage(target, msg);
        console.log(chalk.green(`\n${result}\n`));
        continue;
      }

      if (lowerCmd === '/clear' || lowerCmd === '/cls' || lowerCmd === '/reset') {
        agent.resetHistory();
        console.log(chalk.green('Conversation history cleared! Session memory reset.\n'));
        continue;
      }

      if (lowerCmd === '/provider' || lowerCmd === '/providers') {
        prepareInteractiveArea(
          formatProviderLabel(config),
          config.model,
          agent.getMode()
        );
        const newConfig = await switchProviderInteractive(config);
        if (newConfig) {
          config = newConfig;
          agent.updateConfig(newConfig);
          meshNode?.updateState({ model: config.model });
          updateDockedModel(formatProviderLabel(config), config.model, agent.getMode());
          console.log(chalk.green(`\nProvider updated to: ${formatProviderLabel(config)} (${config.model})\n`));
        }
        continue;
      }

      if (lowerCmd === '/config') {
        prepareInteractiveArea(
          formatProviderLabel(config),
          config.model,
          agent.getMode()
        );
        const newConfig = await promptConfig(false, config);
        if (newConfig) {
          config = newConfig;
          agent.updateConfig(newConfig);
          meshNode?.updateState({ model: config.model });
          updateDockedModel(formatProviderLabel(config), config.model, agent.getMode());
          console.log(chalk.green(`\nConfiguration updated: ${formatProviderLabel(config)} (${config.model})\n`));
        }
        continue;
      }

      // Quick Category Direct Shortcuts
      const directCategoryShortcuts: Record<string, string> = {
        '/gemini': 'gemini',
        '/deepseek': 'deepseek',
        '/groq': 'groq',
        '/free': 'free',
        '/openrouter': 'free',
        '/flagship': 'flagship',
        '/local': 'local',
        '/ollama': 'local',
      };

      if (directCategoryShortcuts[lowerCmd]) {
        const targetCategory = directCategoryShortcuts[lowerCmd];
        const newConfig = await selectAgentModelInteractive(config, agent.getMode(), targetCategory);
        if (newConfig) {
          config = newConfig;
          agent.updateConfig(newConfig);
          meshNode?.updateState({ model: config.model });
          updateDockedModel(formatProviderLabel(config), config.model, agent.getMode());
          console.log(chalk.green(`\nActive model updated to: ${config.model} [${config.provider.toUpperCase()}]\n`));
        }
        continue;
      }

      const isModelCommand =
        lowerCmd === '/model' ||
        lowerCmd === '/models' ||
        lowerCmd === '/agent' ||
        lowerCmd === '/agents' ||
        lowerCmd === '/m' ||
        lowerCmd === '/select-model' ||
        lowerCmd === '/choose-model' ||
        lowerCmd.startsWith('/model ') ||
        lowerCmd.startsWith('/models ') ||
        lowerCmd.startsWith('/agent ') ||
        lowerCmd.startsWith('/agents ') ||
        lowerCmd.startsWith('/m ');

      if (isModelCommand) {
        const parts = trimmed.split(/\s+/);
        const query = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';

        if (query.length > 0) {
          const match = findModelByQuery(query);
          if (match) {
            const directConfig: IUBCLIConfig | null = await applyModelDirect(match, config);
            if (directConfig) {
              config = directConfig;
              agent.updateConfig(directConfig);
              meshNode?.updateState({ model: config.model });
              updateDockedModel(
                formatProviderLabel(config),
                config.model,
                agent.getMode()
              );
              console.log(chalk.green(`\nActive model updated to: ${config.model} [${config.provider.toUpperCase()}]\n`));
            }
            continue;
          } else if (query.includes('/') || query.startsWith('gemini-') || query.startsWith('gemma-') || query.startsWith('gpt-')) {
            // Apply custom model slug cleanly with provider detection
            const inferredProvider =
              query.startsWith('gemini-') || query.startsWith('gemma-')
                ? ('gemini' as const)
                : query.includes('/')
                ? ('openrouter' as const)
                : config.provider;
            const inferredConfig = await applyModelDirect(
              {
                id: query,
                name: query,
                provider: inferredProvider,
                category: inferredProvider === 'gemini' ? 'gemini' : 'free',
                description: 'Direct model slug',
                badge: 'Direct',
                baseURL: inferredProvider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined,
              },
              config
            );
            if (inferredConfig) {
              config = inferredConfig;
              agent.updateConfig(inferredConfig);
              meshNode?.updateState({ model: config.model });
              updateDockedModel(
                formatProviderLabel(config),
                config.model,
                agent.getMode()
              );
              console.log(chalk.green(`\nActive model updated to: ${config.model} [${config.provider.toUpperCase()}]\n`));
            }
            continue;
          }
        }

        const newConfig = await selectAgentModelInteractive(config, agent.getMode());
        if (newConfig) {
          config = newConfig;
          agent.updateConfig(newConfig);
          meshNode?.updateState({ model: config.model });
          updateDockedModel(formatProviderLabel(config), config.model, agent.getMode());
          console.log(chalk.green(`\nActive model updated to: ${config.model} [${config.provider.toUpperCase()}]\n`));
        }
        continue;
      }

      // Antigravity-style Priority Task Dispatch
      // User can execute a specific task first using /task, /urgent, /priority, or "urgent: <task>"
      let isPriorityTask = false;
      let taskPrompt = trimmed;

      if (lowerCmd === '/task' || lowerCmd === '/urgent' || lowerCmd === '/priority') {
        console.log(chalk.yellow('\nUsage: /task <description>\nExample: /task Fix login form validation\n'));
        continue;
      }

      if (lowerCmd.startsWith('/task ') || lowerCmd.startsWith('/urgent ') || lowerCmd.startsWith('/priority ')) {
        isPriorityTask = true;
        taskPrompt = trimmed.replace(/^\/(task|urgent|priority)\s+/i, '').trim();
      } else if (/^(urgent|priority|task):\s*/i.test(trimmed)) {
        isPriorityTask = true;
        taskPrompt = trimmed.replace(/^(urgent|priority|task):\s*/i, '').trim();
      } else if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !/^\/[^\s]+\//.test(trimmed)) {
        const cmdWord = trimmed.split(/\s+/)[0];
        console.log(chalk.yellow(`\nUnknown command "${cmdWord}". Type ${chalk.cyan('/help')} to see all available commands.\n`));
        continue;
      }

      if (isPriorityTask) {
        renderPriorityTaskBanner(taskPrompt, config.model, agent.getMode());
      }

      // OpenCode @ file mentions and image ingestion
      const { expandedPrompt, attachedImages } = await expandOpenCodeMentions(taskPrompt);
      const allImages = [...stagedImages, ...attachedImages];
      stagedImages = []; // reset staged images after passing to agent

      // Real-time Escape-to-cancel agent chat execution
      const abortController = new AbortController();
      let hasAborted = false;
      const detachEscape = attachEscapeListener(() => {
        if (hasAborted) return;
        hasAborted = true;
        abortController.abort();
        renderInterruptedNotice();
        updateFixedBottomStatus('Stopped by Escape key', {
          mode: agent.getMode(),
          model: config?.model || 'unknown',
        });
      });

      try {
        const reply = await agent.chat(expandedPrompt, {
          signal: abortController.signal,
          images: allImages,
        });
        if (abortController.signal.aborted || hasAborted) {
          // Notice already rendered immediately upon Escape press
        } else {
          console.log('\n' + chalk.bold.hex('#00A3FF')('IUB CLI:'));
          console.log(renderMarkdown(reply) + '\n');
        }
      } catch (err: any) {
        if (abortController.signal.aborted || hasAborted) {
          // Notice already rendered immediately upon Escape press
        } else {
          console.error(chalk.red(`\nAgent Error: ${err.message}\n`));
        }
      } finally {
        detachEscape();
        updateFixedBottomStatus('', { mode: agent.getMode(), model: config.model });
      }
    }
  });

// Explicit config subcommand
program
  .command('config')
  .description('Run interactive configuration to set provider, API key, and model')
  .action(async () => {
    await promptConfig(false);
  });

// Explicit guide subcommand
program
  .command('guide')
  .alias('keys')
  .description('Display the free API keys & models guide with direct links')
  .action(() => {
    showFreeApiKeyGuide();
  });

// Explicit limits subcommand
program
  .command('limits')
  .alias('limit')
  .alias('tokens')
  .alias('token')
  .alias('quota')
  .alias('quotas')
  .description('Display free token limits, context windows, and rate limits for all models')
  .action(() => {
    showTokenLimitsGuide();
  });

// Explicit agent/model selector subcommand (OpenCode style)
program
  .command('agent')
  .alias('model')
  .description('OpenCode-style AI agent & model selector (Free, Flagship, Gemini, Local)')
  .action(async () => {
    let config: IUBCLIConfig | null | undefined = getConfig();
    if (!config) {
      config = await promptConfig(true);
    }
    if (!config) return;
    await selectAgentModelInteractive(config, 'build');
  });

// Explicit mode subcommand
program
  .command('mode')
  .description('Switch agent mode between BUILD (autonomous coder) and PLAN (architect)')
  .action(async () => {
    console.log(chalk.bold.hex('#00A3FF')('\nIUB CLI Agent Modes (OpenCode Style):\n'));
    console.log(`  ${chalk.green.bold('BUILD Mode:')} Autonomous full-stack coder. Inspects, writes files & runs terminal commands.`);
    console.log(`  ${chalk.yellow.bold('PLAN Mode:')} Senior Architect. Read-only codebase investigation & architectural planning.\n`);
    console.log(chalk.gray('Use "/mode", "/plan", or "/build" inside interactive chat or launch with "iubcli -M plan".\n'));
  });

// Explicit about subcommand (Developer, GitHub & Project details)
program
  .command('about')
  .alias('developer')
  .alias('author')
  .description('Display creator, developer GitHub profile, and project details')
  .action(() => {
    showAbout();
  });

// Explicit renewal subcommand (Token renewal countdown & provider schedule)
program
  .command('renewal')
  .alias('countdown')
  .alias('renew')
  .description('Display live token quota renewal countdown and provider reset schedules')
  .action(() => {
    renderAllTokensExhaustedReport();
  });

// Explicit doctor subcommand (OpenCode style)
program
  .command('doctor')
  .alias('check')
  .description('Run automated diagnostic check of Node.js runtime, workspace, shell, and provider')
  .action(async () => {
    const config = getConfig() || {
      provider: 'gemini',
      apiKey: '',
      model: 'gemini-3.5-flash-lite',
    };
    await runDoctorDiagnostics(config);
  });

// Explicit stats subcommand
program
  .command('stats')
  .alias('cost')
  .description('Display token limits, pricing, and live cost calculation')
  .action(() => {
    const config = getConfig() || {
      provider: 'gemini',
      apiKey: '',
      model: 'gemini-3.5-flash-lite',
    };

    renderSessionStats({
      model: config.model,
      provider: formatProviderLabel(config),
      mode: 'build',
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalRequests: 0,
      estimatedCostSavedUsd: 0,
      filesTouched: 0,
    });
  });

// Explicit peers subcommand
program
  .command('peers')
  .alias('mesh')
  .description('Discover and display connected cross-instance mesh peers (e.g. frontend, backend)')
  .action(async () => {
    const node = new MeshNode({ role: 'cli-scanner', workspace: process.cwd() });
    await node.start();
    const peers = node.listPeers().filter((p) => p.nodeId !== node.nodeId);
    console.log('\n' + chalk.bold.hex('#00A3FF')('Cross-Instance Workspace Mesh Status:'));
    console.log(chalk.dim('─'.repeat(70)));
    if (peers.length === 0) {
      console.log(chalk.yellow('  No other active IUB CLI instances detected on 127.0.0.1:49152.'));
      console.log(chalk.gray('  Start an instance with: iubcli --role frontend or iubcli --role backend\n'));
    } else {
      console.log(chalk.bold(`  Active Peers (${peers.length}):`));
      peers.forEach((p, idx) => {
        console.log(`  ${idx + 1}. [${chalk.cyan.bold(p.role.toUpperCase())}] (${chalk.gray(p.nodeId)})`);
        console.log(`     Workspace: ${chalk.white(p.workspace)}`);
        console.log(`     Mode: ${p.mode.toUpperCase()}  •  Model: ${p.model} (${p.provider})`);
      });
      console.log(chalk.dim('─'.repeat(70)) + '\n');
    }
    node.stop();
    gracefulExit(0);
  });

program.parse(process.argv);

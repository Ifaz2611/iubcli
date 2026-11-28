import { readOpenCodePrompt } from '../src/prompt.js';

/**
 * Regression tests for the interactive prompt input handling.
 *
 * A normal Enter key press arrives as either CR (`\r`) or bare LF (`\n`)
 * depending on the terminal. Both must submit the prompt. Shift+Enter
 * escape sequences must still insert a newline instead of submitting.
 *
 * Run with: npx tsx scripts/test-prompt.ts
 */

const stdin: any = process.stdin;
const stdout: any = process.stdout;

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) {
      console.log('       ', detail);
    }
  }
}

type PromptCase = {
  name: string;
  keys: string[];
  expected: string;
};

const cases: PromptCase[] = [
  {
    name: 'bare LF (Enter) submits the prompt',
    keys: ['hello world', '\n'],
    expected: 'hello world',
  },
  {
    name: 'CR (Enter) submits the prompt',
    keys: ['hello world', '\r'],
    expected: 'hello world',
  },
  {
    name: 'Shift+Enter inserts a newline before submitting',
    keys: ['line one', '\x1b[13;2u', 'line two', '\n'],
    expected: 'line one\nline two',
  },
];

async function runCase(testCase: PromptCase): Promise<void> {
  const promptPromise = readOpenCodePrompt({
    mode: 'build',
    model: 'test-model',
    provider: 'test',
  });

  // Feed keys on the next tick so the prompt has attached its listeners.
  setTimeout(() => {
    for (const key of testCase.keys) {
      stdin.emit('data', Buffer.from(key, 'utf-8'));
    }
  }, 10);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('prompt did not resolve within 1000ms')), 1000)
  );

  try {
    const result = await Promise.race([promptPromise, timeout]);
    check(testCase.name, result === testCase.expected, {
      expected: testCase.expected,
      actual: result,
    });
  } catch (err: any) {
    check(testCase.name, false, err.message);
  }
}

async function main(): Promise<void> {
  const saved = {
    stdinTTY: stdin.isTTY,
    stdinIsRaw: stdin.isRaw,
    stdinSetRawMode: stdin.setRawMode,
    stdinResume: stdin.resume,
    stdoutColumns: stdout.columns,
    stdoutRows: stdout.rows,
    stdoutWrite: stdout.write,
  };

  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(stdin, 'isRaw', { value: false, writable: true, configurable: true });
  stdin.setRawMode = () => {};
  stdin.resume = () => stdin;
  stdout.columns = 80;
  stdout.rows = 30;
  // Suppress the interactive box rendering so test output stays readable.
  stdout.write = () => true;

  try {
    for (const testCase of cases) {
      await runCase(testCase);
    }
  } finally {
    Object.defineProperty(stdin, 'isTTY', { value: saved.stdinTTY, configurable: true });
    Object.defineProperty(stdin, 'isRaw', { value: saved.stdinIsRaw, writable: true, configurable: true });
    stdin.setRawMode = saved.stdinSetRawMode;
    stdin.resume = saved.stdinResume;
    stdout.columns = saved.stdoutColumns;
    stdout.rows = saved.stdoutRows;
    stdout.write = saved.stdoutWrite;
  }

  if (failures === 0) {
    console.log('\nAll prompt input regression tests passed!');
  } else {
    console.error(`\n${failures} prompt regression test(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Prompt regression test crashed:', err);
  process.exitCode = 1;
});

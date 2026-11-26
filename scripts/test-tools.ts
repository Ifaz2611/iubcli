import {
  listFiles,
  readFile,
  writeFile,
  editFile,
  runCommand,
  grepSearch,
  findFiles,
  splitShellCommands,
  globToRegExp,
  safetySession,
} from '../src/tools.js';
import { detectProjectContext } from '../src/detector.js';
import { sanitizeApiKeyInput, getAppVersion } from '../src/config.js';
import { IUBAgent } from '../src/agent.js';
import fs from 'node:fs';
import path from 'node:path';

async function testAll() {
  console.log('Testing tools...');

  // Enable auto approve for test
  safetySession.autoApproveAll = true;

  // 1. Test writeFile
  const testFilePath = 'temp-test/hello.txt';
  const writeRes = await writeFile(testFilePath, 'Hello IUB CLI from test!');
  console.log('writeFile result:', writeRes);
  if (!fs.existsSync(testFilePath)) {
    throw new Error('writeFile failed to create file');
  }

  // 2. Test editFile (surgical in-place replacement)
  const editRes = await editFile(testFilePath, 'Hello IUB CLI', 'Hello World');
  console.log('editFile result:', editRes);
  const updatedContent = await readFile(testFilePath);
  if (!updatedContent.includes('Hello World from test!')) {
    throw new Error('editFile failed to replace target text');
  }

  // 3. Test readFile
  const readRes = await readFile(testFilePath);
  console.log('readFile result:', readRes);
  if (!readRes.includes('Hello World from test!')) {
    throw new Error('readFile content mismatch');
  }

  // 4. Test listFiles
  const listRes = await listFiles('.');
  console.log('listFiles contains temp-test:', listRes.includes('temp-test/hello.txt'));
  if (!listRes.includes('temp-test/hello.txt')) {
    throw new Error('listFiles missing newly written file');
  }
  if (listRes.includes('node_modules/')) {
    throw new Error('listFiles should ignore node_modules');
  }

  // 5. Test grepSearch
  const grepRes = await grepSearch('Hello World', 'temp-test/*');
  console.log('grepSearch result:', grepRes);
  if (!grepRes.includes('Hello World from test!')) {
    throw new Error('grepSearch failed to find text in test file');
  }

  // 6. Test findFiles
  const findRes = await findFiles('*.txt');
  console.log('findFiles result:', findRes);
  if (!findRes.includes('hello.txt')) {
    throw new Error('findFiles failed to locate hello.txt');
  }

  // 7. Test detectProjectContext
  const ctx = detectProjectContext();
  console.log('detectProjectContext summary:', ctx.summary);
  if (!ctx.packageManager || !ctx.language) {
    throw new Error('detectProjectContext missing core properties');
  }

  // 8. Test runCommand
  const cmdRes = await runCommand('node -e "console.log(12345);"');
  console.log('runCommand result:', cmdRes);
  if (!cmdRes.includes('12345')) {
    throw new Error('runCommand output mismatch');
  }

  // 9. Test sequential one-by-one command execution
  const seqRes = await runCommand('node -e "console.log(\'step1\');" && node -e "console.log(\'step2\');"');
  console.log('sequential command result:', seqRes);
  if (!seqRes.includes('step1') || !seqRes.includes('step2')) {
    throw new Error('sequential execution failed');
  }

  // 10. Test executeTool in PLAN mode (should block edit_file and write_file)
  const { executeTool } = await import('../src/tools.js');
  const planBlockRes = await executeTool('write_file', { filePath: 'temp-test/block.txt', content: 'test' }, 'plan');
  console.log('planMode block result:', planBlockRes);
  if (!planBlockRes.includes('PLAN MODE')) {
    throw new Error('executeTool in PLAN mode did not block write_file');
  }
  const planEditBlockRes = await executeTool('edit_file', { filePath: testFilePath, target: 'a', replacement: 'b' }, 'plan');
  if (!planEditBlockRes.includes('PLAN MODE')) {
    throw new Error('executeTool in PLAN mode did not block edit_file');
  }
  const planPeerWriteBlock = await executeTool(
    'peer_call_tool',
    { peer: 'backend', tool: 'write_file', args: { filePath: 'x.txt', content: 'y' } },
    'plan'
  );
  if (!planPeerWriteBlock.includes('PLAN MODE')) {
    throw new Error('executeTool in PLAN mode did not block mutating peer_call_tool');
  }

  // 11. Test globToRegExp with special regex characters & extensions
  const tsGlob = globToRegExp('*.ts');
  if (!tsGlob.test('src/index.ts') || tsGlob.test('src/index.tsx')) {
    throw new Error('globToRegExp *.ts extension matching failed');
  }
  const bracketGlob = globToRegExp('[id].tsx');
  if (!bracketGlob.test('[id].tsx')) {
    throw new Error('globToRegExp bracket filename matching failed');
  }

  // 12. Test splitShellCommands with escaped quotes & brace blocks
  const splitEscaped = splitShellCommands('node -e "console.log(\\"a && b\\")" && echo ok');
  if (splitEscaped.length !== 2) {
    throw new Error(`splitShellCommands escaped quotes failed: ${JSON.stringify(splitEscaped)}`);
  }
  const splitBraces = splitShellCommands('if ($true) { Write-Output 1; Write-Output 2 } && echo done');
  if (splitBraces.length !== 2) {
    throw new Error(`splitShellCommands brace block failed: ${JSON.stringify(splitBraces)}`);
  }

  // 13. Test CRLF editFile preserves CRLF
  const crlfFile = 'temp-test/crlf.txt';
  await writeFile(crlfFile, 'line1\r\nline2\r\nline3\r\n');
  await editFile(crlfFile, 'line2', 'line2a\nline2b');
  const crlfRaw = fs.readFileSync(crlfFile, 'utf8');
  if (!crlfRaw.includes('line2a\r\nline2b\r\n')) {
    throw new Error('editFile failed to preserve CRLF line endings');
  }

  // 14. Test chained cd command directory tracking
  const cdSeqRes = await runCommand('cd temp-test && node -e "console.log(require(\'path\').basename(process.cwd()))"');
  if (!cdSeqRes.includes('temp-test')) {
    throw new Error(`chained cd failed to preserve directory: ${cdSeqRes}`);
  }

  // 15. Test detectProjectContext does not duplicate TypeScript
  if (ctx.summary.includes('TypeScript, TypeScript')) {
    throw new Error('detectProjectContext duplicated TypeScript in summary');
  }

  // 16. Test sanitizeApiKeyInput & getAppVersion
  if (sanitizeApiKeyInput('export GEMINI_API_KEY="AIzaTest123"') !== 'AIzaTest123') {
    throw new Error('sanitizeApiKeyInput failed');
  }
  const pkgJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  if (getAppVersion() !== pkgJson.version) {
    throw new Error(`getAppVersion mismatch: ${getAppVersion()} vs ${pkgJson.version}`);
  }

  // 17. Test IUBAgent updateConfig preserves history & custom Gemini model
  const agent = new IUBAgent(
    { provider: 'gemini', apiKey: 'AIzaTestKey123456', model: 'gemini-custom-preview' },
    'build'
  );
  (agent as any).geminiContents.push({ role: 'user', parts: [{ text: 'hello' }] });
  agent.updateConfig({
    provider: 'openrouter',
    apiKey: 'sk-or-test-123456',
    model: 'openrouter/free',
    baseURL: 'https://openrouter.ai/api/v1',
  });
  const statsAfterSwitch = agent.getHistoryStats();
  if (statsAfterSwitch.openAIMessageCount < 2) {
    throw new Error('IUBAgent.updateConfig wiped conversation history on provider switch');
  }

  // Clean up
  fs.rmSync('temp-test', { recursive: true, force: true });
  console.log('All tool tests passed successfully! ');
}

testAll().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

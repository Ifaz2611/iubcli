import { IUBAgent } from '../src/agent.js';

/**
 * Regression tests for the agent loop and auto-cascade history handling.
 * Run with: npx tsx scripts/test-agent.ts
 */

function makeAgent(provider: 'gemini' | 'openrouter' | 'custom', model: string): IUBAgent {
  return new IUBAgent(
    {
      provider,
      apiKey: provider === 'gemini' ? 'AIzaFAKEKEY' : 'sk-or-fake',
      model,
      ...(provider === 'openrouter' ? { baseURL: 'https://openrouter.ai/api/v1' } : {}),
    } as any,
    'build'
  );
}

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

async function main(): Promise<void> {
  // 1. Gemini -> Gemini failover must preserve the live conversation.
  {
    const agent = makeAgent('gemini', 'gemini-3.5-flash-lite');
    (agent as any).openAIMessages = [{ role: 'system', content: 'system prompt' }];
    (agent as any).geminiContents = [
      { role: 'user', parts: [{ text: 'hello from user' }] },
      { role: 'model', parts: [{ text: 'hello from model' }] },
    ];
    const before = JSON.stringify((agent as any).geminiContents);
    const next = await (agent as any).cascadeModel('gemini-3.5-flash-lite', '429 rate limit');
    const after = JSON.stringify((agent as any).geminiContents);
    check('gemini -> gemini cascade preserves history', Boolean(next) && before === after, { next });
  }

  // 2. Gemini -> OpenAI-compatible failover must convert (not drop) history.
  {
    const agent = makeAgent('gemini', 'gemini-3.5-flash-lite');
    (agent as any).openAIMessages = [{ role: 'system', content: 'system prompt' }];
    (agent as any).geminiContents = [
      { role: 'user', parts: [{ text: 'hello from user' }] },
      { role: 'model', parts: [{ text: 'hello from model' }] },
    ];
    (agent as any).syncHistoryForProviderChange('gemini', 'openrouter');
    const msgs = (agent as any).openAIMessages;
    check(
      'gemini -> openrouter cascade converts history',
      msgs.length === 3 && msgs[1].content === 'hello from user' && msgs[2].content === 'hello from model',
      msgs
    );
  }

  // 3. OpenAI -> OpenAI failover must not overwrite live messages with stale Gemini state.
  {
    const agent = makeAgent('openrouter', 'openrouter/free');
    (agent as any).geminiContents = [
      { role: 'user', parts: [{ text: 'stale old message' }] },
      { role: 'model', parts: [{ text: 'stale old reply' }] },
    ];
    (agent as any).openAIMessages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'live message' },
      { role: 'assistant', content: 'live reply' },
    ];
    (agent as any).syncHistoryForProviderChange('openrouter', 'custom');
    const msgs = (agent as any).openAIMessages;
    check(
      'openai -> openai switch keeps live history',
      msgs.some((m: any) => m.content === 'live message') &&
        !msgs.some((m: any) => m.content === 'stale old message'),
      msgs
    );
  }

  // 4. Escape mid-tool must not leave an OpenAI assistant turn with missing tool responses.
  {
    const agent = makeAgent('openrouter', 'openrouter/free');
    (agent as any).openAIMessages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'do three things' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
          { id: 'call_c', type: 'function', function: { name: 'c', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'done a' },
    ];
    (agent as any).sanitizeDanglingHistory();
    const msgs = (agent as any).openAIMessages;
    const ids = msgs.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
    check(
      'openai sanitize fills missing tool responses',
      ids.length === 3 && ids.includes('call_b') && ids.includes('call_c'),
      ids
    );
  }

  // 5. Escape mid-tool must not leave a Gemini functionCall without a response.
  {
    const agent = makeAgent('gemini', 'gemini-3.5-flash-lite');
    (agent as any).geminiContents = [
      { role: 'user', parts: [{ text: 'do it' }] },
      { role: 'model', parts: [{ functionCall: { name: 'write_file', id: 'fn_1', args: {} } }] },
    ];
    (agent as any).sanitizeDanglingHistory();
    const contents = (agent as any).geminiContents;
    const hasResponse = contents.some((c: any) =>
      c.parts?.some((p: any) => p.functionResponse?.id === 'fn_1')
    );
    check(
      'gemini sanitize fills dangling function response',
      hasResponse && contents[contents.length - 1].role === 'model',
      contents
    );
  }

  // 6. Escape while waiting for the model must close the user turn.
  {
    const agent = makeAgent('gemini', 'gemini-3.5-flash-lite');
    (agent as any).geminiContents = [{ role: 'user', parts: [{ text: 'hello' }] }];
    (agent as any).sanitizeDanglingHistory();
    const contents = (agent as any).geminiContents;
    check(
      'gemini sanitize closes interrupted user turn',
      contents.length === 2 && contents[1].role === 'model',
      contents
    );
  }

  if (failures === 0) {
    console.log('\nAll agent loop & cascade regression tests passed!');
  } else {
    console.error(`\n${failures} agent regression test(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Agent regression test crashed:', err);
  process.exitCode = 1;
});

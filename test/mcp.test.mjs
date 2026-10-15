import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('MCP handshake, listing, validation and clean stdin shutdown', { timeout: 5000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'x-poster-mcp-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], {
    env: { ...process.env, X_POSTER_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(home, { recursive: true, force: true });
  });
  const replies = [];
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    assert.equal(response.jsonrpc, '2.0');
    replies.push(response);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  let nextId = 0;
  const request = (method, params) => {
    const id = ++nextId;
    const response = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };

  const init = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.serverInfo, { name: 'x-poster', version: '0.1.0' });
  assert.match(init.result.instructions, /UNCERTAIN/);
  assert.match(init.result.instructions, /fully quit.*Cmd\+Q/);
  assert.equal((await request('initialize', { protocolVersion: 'future' })).result.protocolVersion, '2025-11-25');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'ignored-cancel', method: 'notifications/cancelled' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'no-method' })}\n`);
  const list = await request('tools/list');
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['x_status', 'x_login', 'x_preview', 'x_post', 'x_schedule', 'x_list_scheduled', 'x_cancel_scheduled', 'x_article_draft', 'x_article_status', 'x_article_cover', 'x_article_publish', 'x_article_delete']);
  assert.equal(list.result.tools.length, 12);
  assert.match(init.result.instructions, /12 tools/);
  assert.match(init.result.instructions, /in_progress.*job_id.*x_article_status.*Never call x_article_draft again.*UNCERTAIN/);
  const articleStatus = list.result.tools.find(tool => tool.name === 'x_article_status');
  assert.deepEqual(articleStatus.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(articleStatus.inputSchema.required, ['job_id']);
  assert.equal(new RegExp(articleStatus.inputSchema.properties.job_id.pattern).test('123'), false);
  assert.match(init.result.instructions, /x_article_draft.*x_article_publish/);
  assert.match(init.result.instructions, /x_article_cover/);
  const coverTool = list.result.tools.find(tool => tool.name === 'x_article_cover');
  assert.deepEqual(coverTool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(coverTool.inputSchema.required, ['article_id', 'cover']);
  const articleDraft = list.result.tools.find(tool => tool.name === 'x_article_draft');
  assert.equal(articleDraft.annotations.readOnlyHint, false);
  assert.equal(articleDraft.annotations.destructiveHint, false);
  assert.deepEqual(articleDraft.inputSchema.required, ['markdown_path']);
  assert.equal(list.result.tools.find(tool => tool.name === 'x_article_delete').annotations.destructiveHint, true);
  assert.match(list.result.tools.find(tool => tool.name === 'x_article_publish').description, /explicit user confirmation.*exact article_id/);
  for (const [name, args] of [['x_article_draft', { markdown_path: 'relative.md' }], ['x_article_draft', {}],
    ['x_article_status', { job_id: '00000000-0000-0000-0000-000000000000' }],
    ['x_article_cover', { article_id: 'abc', cover: '/tmp/cover.png' }],
    ['x_article_cover', { article_id: '123', cover: 'relative.png' }],
    ['x_article_cover', { article_id: '123', cover: '/tmp/cover.gif' }],
    ['x_article_cover', { article_id: '123', cover: join(home, 'missing.png') }],
    ['x_article_publish', { article_id: '123\n' }], ['x_article_delete', { article_id: 123 }]]) {
    const invalid = await request('tools/call', { name, arguments: args });
    assert.equal(JSON.parse(invalid.result.content[0].text).code, 'INVALID_INPUT');
  }
  assert.match(init.result.instructions, /x_schedule/);
  const scheduleTool = list.result.tools.find(tool => tool.name === 'x_schedule');
  assert.deepEqual(scheduleTool.inputSchema.required, ['scheduled_at']);
  assert.equal(scheduleTool.annotations.idempotentHint, false);
  assert.equal(list.result.tools.find(tool => tool.name === 'x_list_scheduled').annotations.readOnlyHint, true);
  for (const arguments_ of [{ text: 'hello' }, { text: 'hello', scheduled_at: '2000-01-01T09:00' }]) {
    const invalid = await request('tools/call', { name: 'x_schedule', arguments: arguments_ });
    assert.equal(invalid.result.isError, true);
    assert.equal(JSON.parse(invalid.result.content[0].text).code, 'INVALID_INPUT');
  }
  assert.match(init.result.instructions, /x_cancel_scheduled/);
  const cancelTool = list.result.tools.find(tool => tool.name === 'x_cancel_scheduled');
  assert.equal(cancelTool.annotations.destructiveHint, true);
  assert.equal(cancelTool.annotations.idempotentHint, false);
  assert.equal(cancelTool.annotations.openWorldHint, true);
  assert.equal(cancelTool.inputSchema.properties.id.pattern, '^\\d+$');
  for (const arguments_ of [{ id: 'not-numeric' }, { id: '123\n' }, { id: 123 }, {}]) {
    const invalid = await request('tools/call', { name: 'x_cancel_scheduled', arguments: arguments_ });
    assert.equal(invalid.result.isError, true);
    assert.equal(JSON.parse(invalid.result.content[0].text).code, 'INVALID_INPUT');
  }
  const loginTool = list.result.tools.find(tool => tool.name === 'x_login');
  assert.match(loginTool.description, /ordinary Chrome/);
  assert.match(loginTool.description, /Google\/Apple/);
  assert.match(loginTool.description, /fully quit/);
  assert.match(loginTool.inputSchema.properties.wait_seconds.description, /fully quit/);
  const invalidImage = await request('tools/call', { name: 'x_post', arguments: { text: 'hello', images: ['relative.png'] } });
  assert.equal(invalidImage.result.isError, true);
  assert.equal(JSON.parse(invalidImage.result.content[0].text).code, 'INVALID_INPUT');
  const empty = await request('tools/call', { name: 'x_preview', arguments: {} });
  assert.equal(empty.result.isError, true);
  assert.equal(JSON.parse(empty.result.content[0].text).code, 'INVALID_INPUT');
  assert.equal((await request('tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'toString' })).error.code, -32602);
  assert.equal((await request('unknown')).error.code, -32601);
  assert.deepEqual((await request('ping')).result, {});
  const parsedError = new Promise(resolve => pending.set(null, resolve));
  child.stdin.write('not JSON\n');
  assert.equal((await parsedError).error.code, -32700);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(replies.length, nextId + 1);
  assert.equal(stderr, '');
});

async function pendingMcp(t, delay = 100) {
  const home = await mkdtemp(join(tmpdir(), 'x-poster-shutdown-'));
  const marker = join(home, 'settled');
  const chromeURL = new URL('../server/chrome.mjs', import.meta.url).href;
  const serverURL = new URL('../server/index.mjs', import.meta.url).href;
  const script = `
    import { writeFile } from 'node:fs/promises';
    import { Browser } from ${JSON.stringify(chromeURL)};
    Browser.open = async () => ({
      isLoggedIn: async () => {
        process.stderr.write('job-started\\n');
        await new Promise(resolve => setTimeout(resolve, ${delay}));
        return true;
      },
      close: async () => writeFile(${JSON.stringify(marker)}, 'settled'),
    });
    process.on('SIGINT', () => process.stderr.write('interrupt\\n'));
    await import(${JSON.stringify(serverURL)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, X_POSTER_HOME: home, X_POSTER_CHROME_PATH: '/fake/chrome', X_POSTER_SHUTDOWN_GRACE_SEC: '2' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(home, { recursive: true, force: true });
  });
  const output = createInterface({ input: child.stdout });
  const diagnostics = createInterface({ input: child.stderr });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const ready = once(output, 'line');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  assert.deepEqual(JSON.parse((await ready)[0]).result, {});
  const started = once(diagnostics, 'line');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x_status', arguments: {} } })}\n`);
  assert.deepEqual(await started, ['job-started']);
  return { child, output, diagnostics, marker, exited, stderr: () => stderr };
}

test('stdin close drains pending fake browser work even when stdout is broken', { timeout: 5000 }, async t => {
  const f = await pendingMcp(t);
  f.child.stdout.destroy();
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
  assert.equal(await readFile(f.marker, 'utf8'), 'settled');
  assert.equal(f.stderr(), 'job-started\n');
});

test('SIGTERM waits for pending fake browser work to settle', { timeout: 5000 }, async t => {
  const f = await pendingMcp(t);
  f.child.kill('SIGTERM');
  assert.deepEqual(await f.exited, [0, null]);
  assert.equal(await readFile(f.marker, 'utf8'), 'settled');
});

test('second SIGINT exits immediately while fake browser work is pending', { timeout: 5000 }, async t => {
  const f = await pendingMcp(t, 10000);
  const interrupted = once(f.diagnostics, 'line');
  f.child.kill('SIGINT');
  assert.deepEqual(await interrupted, ['interrupt']);
  f.child.kill('SIGINT');
  assert.deepEqual(await f.exited, [0, null]);
  await assert.rejects(readFile(f.marker), error => error.code === 'ENOENT');
});

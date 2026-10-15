#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { TOOLS, hasTool, callTool, pendingWork, waitForShutdown } from './tools.mjs';

if (globalThis.WebSocket === undefined) {
  console.error('x-poster 需要 Node.js 22 或更高版本');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const instructions = 'The server provides 12 tools. Safe flow: x_status, x_login if needed, x_preview, show the screenshot and final text to the user, obtain explicit confirmation, then x_post with exactly the confirmed text and images. The human must log in themselves in the ordinary Chrome window; never request or type passwords or bypass verification. After login the human must fully quit that Chrome (Cmd+Q on macOS; close all its windows on Windows/Linux) before calling x_status. Use absolute local image paths. For scheduled posts, use x_preview with scheduled_at, show the screenshot and exact scheduled time, obtain explicit confirmation, then x_schedule with identical text, images and scheduled_at. Time is local unless an offset is given. X publishes server-side, so the computer can be off. Use x_list_scheduled to inspect scheduled posts. To cancel, first show the user the exact post text and scheduled time from that list, obtain explicit confirmation, then call x_cancel_scheduled with its id; the user can also cancel in X web UI. Never retry an UNCERTAIN cancellation; ask the user to check X immediately. Never retry UNCERTAIN: ask the user to check their profile or scheduled list to avoid duplicate posts. For new X Articles, always call x_article_draft with an absolute local .md file first (eligible Premium account required). Long articles return in_progress with a job_id. Repeatedly call x_article_status with that job_id until a final result. Never call x_article_draft again for the same file while a job is in progress or after an UNCERTAIN result, because that creates duplicate drafts. It creates a NEW draft and serves as the preview; never edit other drafts through x_article_draft. To set or replace only the cover on an existing draft the user identified, use x_article_cover with its exact article_id and an absolute local cover path, then show the returned screenshot. It does not publish or change the body, requires no publication confirmation, and does not count toward posting limits. Show the screenshot, title, warnings and edit_url. Obtain explicit user confirmation of this exact article_id before x_article_publish; stop for draft-only requests. To change content, let the user edit in X or confirm deletion of the created draft with x_article_delete before recreating. Only delete drafts this session created, or an id the user explicitly supplied and confirmed. Article publishing counts toward posting limits; draft creation and deletion do not. Never retry an UNCERTAIN article operation; ask the user to check https://x.com/compose/articles, including the Published tab.';

let outputClosed = false;
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') outputClosed = true;
  else throw error;
});
function reply(message) {
  if (outputClosed || process.stdout.destroyed) return;
  try { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  catch (error) {
    if (error.code === 'EPIPE') outputClosed = true;
    else throw error;
  }
}
function error(id, code, message) { reply({ id, error: { code, message } }); }

async function handle(line) {
  let request;
  try { request = JSON.parse(line); }
  catch { error(null, -32700, '无效的 JSON。'); return; }
  if (request?.method === 'notifications/cancelled') return;
  if (!request || !Object.hasOwn(request, 'id') || !request.method) return;
  const { id, method, params } = request;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {} }, serverInfo: { name: 'x-poster', version }, instructions,
        };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'tools/call':
        if (!hasTool(params?.name)) { error(id, -32602, '未知工具。'); return; }
        result = await callTool(params.name, params.arguments);
        break;
      default: error(id, -32601, '未知方法。'); return;
    }
    reply({ id, result });
  } catch (failure) {
    console.error('处理 MCP 请求失败：', failure);
    error(id, -32603, '内部错误。');
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const requests = new Set();
let shuttingDown = false;
let interrupts = 0;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Requests may still be validating files before they enter the browser queue.
  await waitForShutdown(Promise.allSettled([...requests]).then(pendingWork));
  process.exit(0);
}

input.on('line', line => {
  if (shuttingDown) return;
  const request = handle(line);
  requests.add(request);
  void request.finally(() => requests.delete(request));
});
input.on('close', () => { void shutdown(); });
process.on('SIGINT', () => {
  if (++interrupts > 1) process.exit(0);
  void shutdown();
});
process.on('SIGTERM', () => { void shutdown(); });

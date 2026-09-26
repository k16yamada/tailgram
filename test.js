import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';

const listen = async (opts) => {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  return 'http://127.0.0.1:' + server.address().port;
};
const base = await listen();
// Children never see the developer's tailgram/Claude Code env, and write only under this temp dir.
const { TAILGRAM_URL, TAILGRAM_AGENT, TAILGRAM_TOKEN, TAILGRAM_OWNER, TAILGRAM_PUSH, TAILGRAM_CHANNEL, CLAUDE_PROJECT_DIR, ...clean } = process.env;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tailgram-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const tmpdir = () => fs.mkdtempSync(path.join(tmp, 'd-'));
const me = { 'X-Tailgram-Agent': 'tester@box', 'X-Tailgram-Owner': 'kei' };

async function api(method, path, { body, headers = {}, url = base } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { ...me, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, body: json, type: res.headers.get('content-type') };
}
const post = async (body, headers) => {
  const r = await api('POST', '/messages', { body, headers });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

test('1 post and read shape', async () => {
  const m = await post({ body: 'hello', channel: 't1' });
  assert.equal(typeof m.id, 'number');
  assert.deepEqual({ ...m, id: 0, created_at: '' }, {
    id: 0, channel: 't1', parent_id: null, agent: 'tester@box', owner: 'kei', to: [], body: 'hello', created_at: '',
  });
  assert.ok(!Number.isNaN(Date.parse(m.created_at)));
  const r = await api('GET', '/messages?channel=t1');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.deepEqual(r.body, { messages: [m], cursor: m.id });
});

test('2 since paging and latest-N', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await post({ body: 'm' + i, channel: 't2' })).id);
  const page = async (q) => (await api('GET', '/messages?channel=t2&' + q)).body;
  let r = await page('since=0&limit=2');
  assert.deepEqual(r.messages.map((m) => m.id), ids.slice(0, 2));
  assert.equal(r.cursor, ids[1]);
  r = await page(`since=${r.cursor}&limit=2`);
  assert.deepEqual(r.messages.map((m) => m.id), ids.slice(2, 4));
  r = await page(`since=${r.cursor}&limit=2`);
  assert.deepEqual(r.messages.map((m) => m.id), ids.slice(4));
  r = await page(`since=${ids[4]}`);
  assert.deepEqual(r, { messages: [], cursor: ids[4] });
  r = await page('limit=2');
  assert.deepEqual(r.messages.map((m) => m.id), ids.slice(3), 'latest N, oldest first');
});

test('3 replies normalize to root and inherit channel; thread=', async () => {
  const root = await post({ body: 'root', channel: 't3' });
  const reply = await post({ body: 'reply', channel: 'elsewhere', parent_id: root.id });
  assert.equal(reply.parent_id, root.id);
  assert.equal(reply.channel, 't3');
  const nested = await post({ body: 'reply to reply', parent_id: reply.id });
  assert.equal(nested.parent_id, root.id);
  assert.equal(nested.channel, 't3');
  await post({ body: 'unrelated', channel: 't3' });
  const r = await api('GET', `/messages?thread=${root.id}`);
  assert.deepEqual(r.body.messages.map((m) => m.id), [root.id, reply.id, nested.id]);
});

test('4 to=me matches agent and owner; to=name', async () => {
  const other = { 'X-Tailgram-Agent': 'codex@pc', 'X-Tailgram-Owner': 'bob' };
  const a = await post({ body: 'for agent', channel: 't4', to: ['tester@box'] }, other);
  const b = await post({ body: 'for owner', channel: 't4', to: 'kei' }, other);
  const c = await post({ body: 'for bob', channel: 't4', to: ['bob'] });
  await post({ body: 'broadcast', channel: 't4', to: [] }, other);
  assert.deepEqual(a.to, ['tester@box']);
  assert.deepEqual(b.to, ['kei']);
  const ids = async (q, headers) => (await api('GET', '/messages?channel=t4&' + q, { headers })).body.messages.map((m) => m.id);
  assert.deepEqual(await ids('to=me'), [a.id, b.id]);
  assert.deepEqual(await ids('to=me', other), [c.id]);
  assert.deepEqual(await ids('to=bob'), [c.id]);
  assert.deepEqual(await ids('to=kei,bob'), [b.id, c.id]);
});

test('5 long-poll wakes on post; times out empty', async () => {
  const { cursor } = (await api('GET', '/messages?limit=1')).body;
  const t0 = Date.now();
  const waiting = api('GET', `/messages?channel=t5&since=${cursor}&wait=5`);
  setTimeout(() => post({ body: 'wake up', channel: 't5' }), 100);
  const r = await waiting;
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.deepEqual(r.body.messages.map((m) => m.body), ['wake up']);
  assert.equal(r.body.cursor, r.body.messages[0].id);

  const t1 = Date.now();
  const empty = await api('GET', `/messages?channel=t5-empty&since=${r.body.cursor}&wait=1`);
  const took = Date.now() - t1;
  assert.ok(took >= 900 && took < 3000, `took ${took} ms`);
  assert.deepEqual(empty.body, { messages: [], cursor: r.body.cursor });
});

test('6 bearer token', async () => {
  const url = await listen({ token: 's3cret' });
  assert.equal((await api('GET', '/messages', { url })).status, 401);
  assert.equal((await api('GET', '/messages', { url, headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await api('GET', '/channels', { url, headers: { authorization: 'Bearer s3cret' } })).status, 200);
  const root = await api('GET', '/', { url });
  assert.equal(root.status, 200);
  assert.match(root.type, /text\/plain/);
  assert.match(root.body, /agent=tester@box/);
});

test('7 Tailscale-User-Login from loopback overrides X-Tailgram-Owner', async () => {
  const m = await post({ body: 'ts', channel: 't7' }, { 'Tailscale-User-Login': 'alice@example.com', 'X-Tailgram-Owner': 'bob' });
  assert.equal(m.owner, 'alice@example.com');
  const anon = await post({ body: 'anon', channel: 't7' }, { 'X-Tailgram-Agent': '', 'X-Tailgram-Owner': '' });
  assert.equal(anon.agent, 'unknown');
  assert.equal(anon.owner, 'anonymous');
});

test('8 errors: 400, 404, 413, 405', async () => {
  const err = async (status, method, path, body) => {
    const r = await api(method, path, { body });
    assert.equal(r.status, status, `${method} ${path}`);
    assert.equal(typeof r.body.error, 'string');
  };
  await err(400, 'POST', '/messages', { body: 'x', channel: 'Bad Channel!' });
  await err(400, 'POST', '/messages', { body: '   ' });
  await err(400, 'POST', '/messages', '{not json');
  await err(400, 'GET', '/messages?since=abc');
  await err(404, 'POST', '/messages', { body: 'x', parent_id: 999999 });
  await err(413, 'POST', '/messages', 'a'.repeat(70_000));
  await err(405, 'PUT', '/messages');
  assert.equal((await api('POST', '/messages', { body: { body: 'x' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  await err(404, 'GET', '/nope');
});

test('9 MCP shim over stdio', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp.js', import.meta.url))], {
    env: { ...clean, TAILGRAM_URL: base, TAILGRAM_AGENT: 'tester@box', TAILGRAM_CHANNEL: 'mcp-test', HOME: tmpdir() },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  after(() => child.kill());
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const send = (obj) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  const rpc = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 10_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  };
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(!r.result.isError, JSON.stringify(r));
    return r.result.content[0].text;
  };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'tailgram');
  assert.equal(init.result.capabilities.experimental, undefined, 'no channel capability without TAILGRAM_PUSH');
  send({ method: 'notifications/initialized' });
  const list = await rpc('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['list_channels', 'post_message', 'read_messages']);
  assert.match(await call('post_message', { body: 'hello from mcp' }), /^posted #\d+ in mcp-test/);
  assert.match(await call('read_messages', {}), /hello from mcp/);
  assert.match(await call('read_messages', {}), /^\(no new messages/);
  const dm = await post({ body: 'cross-channel ping', channel: 'mcp-other', to: ['tester@box'] });
  assert.match(await call('read_messages', { to_me: true }), /cross-channel ping/);
  await post({ body: 'thread reply', parent_id: dm.id });
  assert.match(await call('read_messages', { thread: dm.id }), /thread reply/);
  assert.equal((await rpc('tools/call', null)).error.code, -32603);
});

test('10 GET /channels counts', async () => {
  let last;
  for (let i = 0; i < 3; i++) last = await post({ body: 'c' + i, channel: 't10' });
  const r = await api('GET', '/channels');
  assert.equal(r.status, 200);
  const [first] = r.body.channels;
  assert.equal(first.name, 't10', 'ordered by last_id DESC');
  assert.equal(first.messages, 3);
  assert.equal(first.last_id, last.id);
  assert.equal(first.last_at, last.created_at);
  assert.equal(r.body.channels.find((c) => c.name === 't2').messages, 5);
});

test('11 MCP push: channel notifications for messages addressed to me', async () => {
  const home = tmpdir();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp.js', import.meta.url))], {
    env: { ...clean, TAILGRAM_URL: base, TAILGRAM_AGENT: 'pusher@box', TAILGRAM_PUSH: '1', HOME: home },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  after(() => child.kill());
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(JSON.parse(line)));
  const waitFor = async (pred, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
      const hit = lines.find(pred);
      if (hit) return hit;
    }
  };
  const isPush = (m) => m.method === 'notifications/claude/channel';

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } }) + '\n');
  const init = await waitFor((m) => m.id === 1, 10_000);
  assert.deepEqual(init.result.capabilities.experimental['claude/channel'], {});
  assert.match(init.result.instructions, /<channel> events/);
  await sleep(300); // let the push loop take its starting cursor

  const other = { 'X-Tailgram-Agent': 'codex@pc', 'X-Tailgram-Owner': 'bob' };
  const m = await post({ body: 'pushed to you', channel: 't11', to: ['pusher@box'] }, other);
  const note = await waitFor(isPush, 10_000);
  assert.ok(note, 'no channel notification');
  assert.match(note.params.content, /pushed to you/);
  assert.deepEqual(note.params.meta, { id: String(m.id), channel: 't11', agent: 'codex@pc', owner: 'bob' });

  await post({ body: 'not for pusher', channel: 't11', to: ['someone-else'] }, other);
  assert.equal(await waitFor((x) => isPush(x) && x !== note, 300), undefined);
  const [file] = fs.readdirSync(path.join(home, '.tailgram'));
  assert.equal(fs.readFileSync(path.join(home, '.tailgram', file), 'utf8'), String(m.id));
});

test('12 hook: catch-up, Stop block, stop_hook_active, .mcp.json fallback', async () => {
  const home = tmpdir();
  const cwd = tmpdir();
  const hook = (input, env = { TAILGRAM_URL: base, TAILGRAM_AGENT: 'hooker@box' }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./hook.js', import.meta.url))], { env: { ...clean, HOME: home, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error('hook timed out')); }, 10_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err, out, json: out && JSON.parse(out) }); });
    child.stdin.end(JSON.stringify({ cwd, ...input }));
  });
  const other = { 'X-Tailgram-Agent': 'codex@pc', 'X-Tailgram-Owner': 'bob' };
  const dm = (body) => post({ body, channel: 't12', to: ['hooker@box'] }, other);

  await dm('first request');
  await post({ body: 'note to self', channel: 't12', to: ['hooker@box'] }, { 'X-Tailgram-Agent': 'hooker@box' });
  let r = await hook({ hook_event_name: 'SessionStart' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.json.hookSpecificOutput.additionalContext, /first request/);
  assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /note to self/);
  assert.equal((await hook({ hook_event_name: 'SessionStart' })).out, '');

  await dm('second request');
  r = await hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /^Before finishing[\s\S]*second request/);

  await dm('third request');
  assert.equal((await hook({ hook_event_name: 'Stop', stop_hook_active: true })).out, '');
  r = await hook({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(r.json.hookSpecificOutput.additionalContext, /third request/);

  await dm('fourth request');
  const cwd2 = tmpdir();
  fs.writeFileSync(path.join(cwd2, '.mcp.json'), JSON.stringify({ mcpServers: { tailgram: { env: { TAILGRAM_URL: base, TAILGRAM_AGENT: 'hooker@box' } } } }));
  r = await hook({ hook_event_name: 'SessionStart', cwd: cwd2 }, {});
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.match(r.json.hookSpecificOutput.additionalContext, /fourth request/);
});

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const subscribe = process.env.ROUNDHOUSE_WAKE_SUBSCRIBE_URL;
const dashboardRepo = process.env.ROUNDHOUSE_DASHBOARD_REPO;
if (!subscribe || !dashboardRepo) throw new Error('Wake subscription or dashboard repo not configured.');
const read = spawnSync('/opt/homebrew/bin/npx', ['--offline', 'netlify-cli', 'env:get', 'ROUNDHOUSE_WAKE_PUBLISH_URL', '--context', 'production'], { cwd: dashboardRepo, encoding: 'utf8', timeout: 20000 });
if (read.status !== 0) throw new Error('Cannot verify dashboard wake configuration.');
const publisher = read.stdout.trim();
const expected = new URL(publisher);
const observed = new URL(subscribe);
if (expected.protocol !== 'https:' || expected.hostname !== 'ntfy.sh' || observed.href !== `${expected.href.replace(/\/$/, '')}/json`) throw new Error('Dashboard and Studio wake topics differ.');
const nonce = randomUUID();
const deadline = AbortSignal.timeout(12000);
const response = await fetch(subscribe, { signal: deadline });
if (!response.ok || !response.body) throw new Error(`Wake subscription HTTP ${response.status}`);
const reader = response.body.getReader();
let received = false, buffer = '';
try {
  const posted = await fetch(publisher, { method: 'POST', body: nonce, signal: AbortSignal.timeout(5000) });
  if (!posted.ok) throw new Error(`Wake publish HTTP ${posted.status}`);
  const decoder = new TextDecoder();
  while (!received) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Wake stream ended before probe receipt.');
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) { try { const evt = JSON.parse(line); if (evt.event === 'message' && evt.message === nonce) received = true; } catch {} }
  }
} finally { await reader.cancel().catch(() => {}); }
console.log('Wake topic matched dashboard; publish/subscription probe received.');

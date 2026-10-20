// 타임뱅크 로컬 서버: node server.js → http://localhost:3030
import http from 'node:http';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceOf, dueGrants, fmtDuration, nextGrant } from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '0.0.0.0'; // 같은 와이파이의 폰에서도 접속
const PASSWORD = process.env.TIME_BANK_PASSWORD || '12345';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 저장 ----------
// data: { ledger: [{ id, at, amount(초, +들어옴/-나감), note }], grantedDates: [], active: null | {...}, tokens: [] }
function load() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { ledger: [], grantedDates: [], active: null, tokens: [] };
  }
}

let data = load();

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, DATA_FILE);
}

function addEntry(amount, note, at = Date.now()) {
  data.ledger.push({ id: randomBytes(6).toString('hex'), at, amount: Math.round(amount), note });
}

// 받을 지급 넣기 + 끝난 타이머 정리. 바뀐 게 있으면 저장.
function settle(now = new Date()) {
  let changed = false;
  for (const g of dueGrants(now, data.grantedDates)) {
    const [y, m, d] = g.date.split('-').map(Number);
    addEntry(g.amount, `${g.note} +${fmtDuration(g.amount)}`, new Date(y, m - 1, d).getTime());
    data.grantedDates.push(g.date);
    changed = true;
  }
  const a = data.active;
  if (a && a.mode === 'timer' && now.getTime() >= a.startedAt + a.duration * 1000) {
    data.active = null; // 선불이라 이미 빠져 있음
    changed = true;
  }
  if (changed) {
    data.ledger.sort((x, y) => x.at - y.at);
    save();
  }
}

function state() {
  settle();
  const now = new Date();
  const g = nextGrant(now);
  return {
    now: now.getTime(),
    balance: balanceOf(data.ledger),
    active: data.active,
    nextGrant: g,
    ledger: data.ledger.slice(-100).reverse(),
  };
}

// ---------- HTTP ----------
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function tokenOf(req) {
  const m = /(?:^|;\s*)tb=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

const loggedIn = (req) => {
  const t = tokenOf(req);
  return !!t && data.tokens.includes(t);
};

// 와이파이에 열려 있으므로 비밀번호를 5번 틀리면 1분 동안 막는다.
const failures = { count: 0, until: 0 };

function samePassword(input) {
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MIME = { '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: '없음' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: '없음' });
  }
}

async function api(req, res, pathname) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (Date.now() < failures.until) {
      return send(res, 429, { error: `너무 많이 틀렸어요. ${Math.ceil((failures.until - Date.now()) / 1000)}초 뒤에 다시 해 주세요.` });
    }
    if (!samePassword(password)) {
      failures.count++;
      if (failures.count >= 5) {
        failures.count = 0;
        failures.until = Date.now() + 60_000;
      }
      return send(res, 401, { error: '비밀번호가 틀렸어요.' });
    }
    failures.count = 0;
    const token = randomBytes(24).toString('hex');
    data.tokens = [...data.tokens.slice(-9), token];
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `tb=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }

  if (!loggedIn(req)) return send(res, 401, { error: '로그인이 필요해요.' });

  if (pathname === '/api/logout' && req.method === 'POST') {
    data.tokens = data.tokens.filter((t) => t !== tokenOf(req));
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'tb=; Path=/; Max-Age=0' });
  }

  if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, state());

  if (req.method !== 'POST') return send(res, 404, { error: '없는 주소예요.' });
  settle();
  const now = Date.now();
  const balance = balanceOf(data.ledger);

  // 스톱워치: 후불. 멈출 때 쓴 만큼 빠진다.
  if (pathname === '/api/stopwatch/start') {
    if (data.active) return send(res, 409, { error: '이미 사용 중이에요.' });
    if (balance <= 0) return send(res, 400, { error: '남은 시간이 없어요. 토요일 지급을 기다려 주세요.' });
    data.active = { mode: 'stopwatch', startedAt: now };
    save();
    return send(res, 200, state());
  }
  if (pathname === '/api/stopwatch/stop') {
    const a = data.active;
    if (!a || a.mode !== 'stopwatch') return send(res, 409, { error: '스톱워치가 켜져 있지 않아요.' });
    const used = Math.max(1, Math.round((now - a.startedAt) / 1000));
    addEntry(-used, `스톱워치 ${fmtDuration(used)} 사용 (후불)`, now);
    data.active = null;
    save();
    return send(res, 200, state());
  }

  // 타이머: 선불. 시작할 때 정한 시간만큼 먼저 빠지고, 일찍 끄면 남은 시간을 돌려받는다.
  if (pathname === '/api/timer/start') {
    if (data.active) return send(res, 409, { error: '이미 사용 중이에요.' });
    const { minutes } = await readBody(req);
    const duration = Math.round(Number(minutes) * 60);
    if (!Number.isFinite(duration) || duration < 60 || duration > 24 * 3600) return send(res, 400, { error: '1분 이상으로 정해 주세요.' });
    if (duration > balance) return send(res, 400, { error: `남은 시간(${fmtDuration(Math.max(0, balance))})보다 길게 정할 수 없어요.` });
    addEntry(-duration, `타이머 ${fmtDuration(duration)} (선불)`, now);
    data.active = { mode: 'timer', startedAt: now, duration };
    save();
    return send(res, 200, state());
  }
  if (pathname === '/api/timer/stop') {
    const a = data.active;
    if (!a || a.mode !== 'timer') return send(res, 409, { error: '타이머가 켜져 있지 않아요.' });
    const left = Math.floor((a.startedAt + a.duration * 1000 - now) / 1000);
    if (left > 0) addEntry(left, `타이머 일찍 끝냄, ${fmtDuration(left)} 돌려받음`, now);
    data.active = null;
    save();
    return send(res, 200, state());
  }

  return send(res, 404, { error: '없는 주소예요.' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (req.method === 'GET') return await serveStatic(res, pathname);
    send(res, 404, { error: '없음' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: '서버 오류가 났어요.' });
  }
});

// 타이머가 끝나거나 토요일이 되면 화면을 안 열어 놔도 정리되도록 1분마다 확인
setInterval(() => settle(), 60_000).unref();
settle();

if (!existsSync(PUBLIC_DIR)) console.warn('public 폴더가 없습니다.');
// 폰에서 열 주소 (이 PC의 와이파이/랜 IP)
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`타임뱅크 실행 중: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const ip of lanAddresses()) console.log(`  폰에서 (같은 와이파이): http://${ip}:${PORT}`);
  }
  console.log('이 창을 닫으면 타임뱅크가 꺼집니다.');
});

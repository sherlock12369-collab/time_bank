// 타임뱅크 서버: node server.js → http://localhost:3030
import http from 'node:http';
import os from 'node:os';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SISTER_DAY_MAX, SISTER_WEEK_MAX, TOGETHER_MAX,
  balanceOf, dueGrants, fmtDuration, interestFor, localDateStr, nextGrant, parseDate, weekStart, weekStats, weeklyReports,
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '0.0.0.0'; // 같은 와이파이의 폰에서도 접속
const PASSWORD = process.env.TIME_BANK_PASSWORD || '12345';
// 인터넷 서버에서는 DATA_DIR=/data (지워지지 않는 저장 공간)
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// https로 서비스될 때 쿠키에 Secure를 붙인다
const SECURE_COOKIE = /^(1|true)$/i.test(process.env.SECURE_COOKIE || '');

const THEME_MODES = ['system', 'light', 'dark'];
const ACCENTS = ['purple', 'blue', 'green', 'orange', 'pink', 'red'];

// ---------- 저장 ----------
// data: {
//   ledger: [{ id, at, amount(초, +들어옴/-나감), note, kind, duration? }],
//   grantedDates: [], active: null | { mode: 'stopwatch'|'timer'|'together', startedAt, duration? },
//   tokens: [], settings: { mode, accent }, sisterPin: { salt, hash } | null, reportSeen: 'YYYY-MM-DD' | null
// }
// kind: grant(지급) | interest(이자) | stopwatch | timer | refund(타이머 돌려받음) | sister(누나 선물) | together(누나랑 놀기, 0초) | adjust
function load() {
  let d = {};
  try {
    d = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch { /* 처음 */ }
  return {
    ledger: [],
    grantedDates: [],
    active: null,
    tokens: [],
    settings: { mode: 'system', accent: 'purple' },
    sisterPin: null,
    reportSeen: null,
    ...d,
  };
}

let data = load();

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, DATA_FILE);
}

function addEntry(amount, note, kind, at = Date.now(), extra = {}) {
  data.ledger.push({ id: randomBytes(6).toString('hex'), at, amount: Math.round(amount), note, kind, ...extra });
}

function endTogether(a, endAt, auto) {
  const dur = Math.max(1, Math.round((endAt - a.startedAt) / 1000));
  addEntry(0, `누나랑 같이 놀기 ${fmtDuration(dur)} (무료${auto ? ', 자동 종료' : ''})`, 'together', endAt, { duration: dur });
  data.active = null;
}

// 받을 지급(+토요일 이자) 넣기, 끝난 타이머/같이 놀기 정리. 바뀐 게 있으면 저장.
function settle(now = new Date()) {
  let changed = false;
  for (const g of dueGrants(now, data.grantedDates)) {
    const t = parseDate(g.date).getTime();
    if (g.weekly) {
      // 토요일: 지급 직전까지 남아 있던 시간에 이자
      const before = balanceOf(data.ledger.filter((e) => e.at < t));
      const interest = interestFor(before);
      if (interest > 0) addEntry(interest, `이자 10% (남은 ${fmtDuration(before)}) +${fmtDuration(interest)}`, 'interest', t);
    }
    addEntry(g.amount, `${g.note} +${fmtDuration(g.amount)}`, 'grant', t + 1);
    data.grantedDates.push(g.date);
    data.ledger.sort((x, y) => x.at - y.at);
    changed = true;
  }
  const a = data.active;
  if (a && a.mode === 'timer' && now.getTime() >= a.startedAt + a.duration * 1000) {
    data.active = null; // 선불이라 이미 빠져 있음
    changed = true;
  }
  if (a && a.mode === 'together' && now.getTime() >= a.startedAt + TOGETHER_MAX * 1000) {
    endTogether(a, a.startedAt + TOGETHER_MAX * 1000, true);
    changed = true;
  }
  if (changed) save();
}

// 누나 선물 한도: 오늘 / 이번 주(토요일부터) 받은 양
function sisterGiven(now = new Date()) {
  const today = localDateStr(now);
  const ws = weekStart(now).getTime();
  let day = 0;
  let week = 0;
  for (const e of data.ledger) {
    if (e.kind !== 'sister') continue;
    if (e.at >= ws) week += e.amount;
    if (localDateStr(new Date(e.at)) === today) day += e.amount;
  }
  return { day, week, dayLeft: Math.max(0, SISTER_DAY_MAX - day), weekLeft: Math.max(0, SISTER_WEEK_MAX - week) };
}

function state() {
  settle();
  const now = new Date();
  const g = nextGrant(now);
  const balance = balanceOf(data.ledger);
  const reports = weeklyReports(data.ledger, now);
  const latest = reports[0] || null;
  return {
    now: now.getTime(),
    balance,
    active: data.active,
    nextGrant: g,
    nextInterest: g && g.weekly ? interestFor(balance) : 0, // 지금 잔액 그대로 토요일이 되면 받을 이자
    week: weekStats(data.ledger, now),
    settings: data.settings,
    sister: { pinSet: !!data.sisterPin, ...sisterGiven(now), dayMax: SISTER_DAY_MAX, weekMax: SISTER_WEEK_MAX, togetherMax: TOGETHER_MAX },
    newReport: latest && latest.date !== data.reportSeen ? latest : null,
    reportCount: reports.length,
    ledger: data.ledger.slice(-100).reverse(),
  };
}

// ---------- 비밀번호 ----------
function sameText(input, expected) {
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(pin), salt, 32).toString('hex') };
}

function checkPin(pin) {
  if (!data.sisterPin) return false;
  return sameText(hashPin(pin, data.sisterPin.salt).hash, data.sisterPin.hash);
}

// 5번 틀리면 1분 잠금 (로그인 / 누나 비밀번호 따로)
function makeLimiter() {
  const f = { count: 0, until: 0 };
  return {
    blocked: () => (Date.now() < f.until ? Math.ceil((f.until - Date.now()) / 1000) : 0),
    fail: () => {
      if (++f.count >= 5) {
        f.count = 0;
        f.until = Date.now() + 60_000;
      }
    },
    ok: () => { f.count = 0; },
  };
}
const loginLimit = makeLimiter();
const pinLimit = makeLimiter();

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

const cookie = (v, maxAge) => `tb=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;

const MIME = {
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};

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

// 누나 비밀번호 확인 (틀리면 오류 응답을 보내고 false)
function requirePin(res, pin) {
  const wait = pinLimit.blocked();
  if (wait) return send(res, 429, { error: `누나 비밀번호를 너무 많이 틀렸어요. ${wait}초 뒤에 다시 해 주세요.` }), false;
  if (!data.sisterPin) return send(res, 400, { error: '누나 비밀번호를 먼저 정해 주세요.' }), false;
  if (!checkPin(pin)) {
    pinLimit.fail();
    return send(res, 401, { error: '누나 비밀번호가 틀렸어요.' }), false;
  }
  pinLimit.ok();
  return true;
}

async function api(req, res, pathname) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const { password } = await readBody(req);
    const wait = loginLimit.blocked();
    if (wait) return send(res, 429, { error: `너무 많이 틀렸어요. ${wait}초 뒤에 다시 해 주세요.` });
    if (!sameText(password, PASSWORD)) {
      loginLimit.fail();
      return send(res, 401, { error: '비밀번호가 틀렸어요.' });
    }
    loginLimit.ok();
    const token = randomBytes(24).toString('hex');
    data.tokens = [...data.tokens.slice(-9), token];
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(token, 31536000) });
  }

  if (!loggedIn(req)) return send(res, 401, { error: '로그인이 필요해요.' });

  if (pathname === '/api/logout' && req.method === 'POST') {
    data.tokens = data.tokens.filter((t) => t !== tokenOf(req));
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }

  if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, state());
  if (pathname === '/api/reports' && req.method === 'GET') {
    settle();
    return send(res, 200, { reports: weeklyReports(data.ledger, new Date()) });
  }

  if (req.method !== 'POST') return send(res, 404, { error: '없는 주소예요.' });
  settle();
  const now = Date.now();
  const balance = balanceOf(data.ledger);
  const body = await readBody(req);

  // ----- 테마 -----
  if (pathname === '/api/settings') {
    if (THEME_MODES.includes(body.mode)) data.settings.mode = body.mode;
    if (ACCENTS.includes(body.accent)) data.settings.accent = body.accent;
    save();
    return send(res, 200, state());
  }

  // ----- 성적표 확인함 -----
  if (pathname === '/api/report/seen') {
    if (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) data.reportSeen = body.date;
    save();
    return send(res, 200, { ok: true });
  }

  // ----- 스톱워치: 후불. 멈출 때 쓴 만큼 빠진다. -----
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
    addEntry(-used, `스톱워치 ${fmtDuration(used)} 사용 (후불)`, 'stopwatch', now);
    data.active = null;
    save();
    return send(res, 200, state());
  }

  // ----- 타이머: 선불. 정한 만큼 먼저 빠지고, 일찍 끄면 남은 시간을 돌려받는다. -----
  if (pathname === '/api/timer/start') {
    if (data.active) return send(res, 409, { error: '이미 사용 중이에요.' });
    const duration = Math.round(body.seconds !== undefined ? Number(body.seconds) : Number(body.minutes) * 60);
    if (!Number.isFinite(duration) || duration < 1) return send(res, 400, { error: '시간을 1초 이상으로 정해 주세요.' });
    if (duration > 24 * 3600) return send(res, 400, { error: '24시간보다 길게 정할 수 없어요.' });
    if (duration > balance) return send(res, 400, { error: `남은 시간(${fmtDuration(Math.max(0, balance))})보다 길게 정할 수 없어요.` });
    addEntry(-duration, `타이머 ${fmtDuration(duration)} (선불)`, 'timer', now);
    data.active = { mode: 'timer', startedAt: now, duration };
    save();
    return send(res, 200, state());
  }
  if (pathname === '/api/timer/stop') {
    const a = data.active;
    if (!a || a.mode !== 'timer') return send(res, 409, { error: '타이머가 켜져 있지 않아요.' });
    const left = Math.floor((a.startedAt + a.duration * 1000 - now) / 1000);
    if (left > 0) addEntry(left, `타이머 일찍 끝냄, ${fmtDuration(left)} 돌려받음`, 'refund', now);
    data.active = null;
    save();
    return send(res, 200, state());
  }

  // ----- 누나 타임 -----
  // 누나 비밀번호 정하기 (처음) / 바꾸기 (예전 비밀번호 필요)
  if (pathname === '/api/sister/pin') {
    if (!/^\d{4}$/.test(String(body.pin || ''))) return send(res, 400, { error: '누나 비밀번호는 숫자 4자리로 정해 주세요.' });
    if (data.sisterPin && !requirePin(res, body.oldPin)) return;
    data.sisterPin = hashPin(body.pin);
    save();
    return send(res, 200, state());
  }

  // A. 선물: 잔액에 더한다. 타이머가 돌고 있으면 타이머도 그만큼 늘어난다.
  if (pathname === '/api/sister/gift') {
    if (!requirePin(res, body.pin)) return;
    const amount = Math.round(Number(body.minutes) * 60);
    if (![5, 10, 15].includes(Number(body.minutes))) return send(res, 400, { error: '5분, 10분, 15분 중에서 골라 주세요.' });
    const given = sisterGiven();
    if (amount > given.dayLeft) {
      return send(res, 400, { error: given.dayLeft ? `오늘은 ${fmtDuration(given.dayLeft)}까지만 더 줄 수 있어요.` : '오늘 누나 타임은 다 썼어요.' });
    }
    if (amount > given.weekLeft) {
      return send(res, 400, { error: given.weekLeft ? `이번 주에는 ${fmtDuration(given.weekLeft)}까지만 더 줄 수 있어요.` : '이번 주 누나 타임은 다 썼어요.' });
    }
    addEntry(amount, `누나 타임 선물 +${fmtDuration(amount)}`, 'sister', now);
    const a = data.active;
    if (a && a.mode === 'timer') {
      addEntry(-amount, `타이머 ${fmtDuration(amount)} 연장 (누나 타임)`, 'timer', now + 1);
      a.duration += amount;
    }
    save();
    return send(res, 200, state());
  }

  // B. 같이 놀기: 켜져 있는 동안은 시간이 빠지지 않는다 (최대 2시간 뒤 자동 종료)
  if (pathname === '/api/together/start') {
    if (!requirePin(res, body.pin)) return;
    if (data.active) return send(res, 409, { error: '지금 쓰고 있는 것을 먼저 멈춰 주세요.' });
    data.active = { mode: 'together', startedAt: now };
    save();
    return send(res, 200, state());
  }
  if (pathname === '/api/together/stop') {
    const a = data.active;
    if (!a || a.mode !== 'together') return send(res, 409, { error: '같이 놀기가 켜져 있지 않아요.' });
    endTogether(a, now, false);
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

// 서버 없이 쓰는 버전 (GitHub Pages): server.js와 같은 API를 이 기기의 저장소(localStorage)로 처리한다.
// app.js는 window.TB_LOCAL이 있으면 fetch 대신 이것을 부른다.
import {
  SISTER_DAY_MAX, SISTER_WEEK_MAX, TOGETHER_MAX,
  balanceOf, dueGrants, fmtDuration, interestFor, localDateStr, nextGrant, parseDate, weekStart, weekStats, weeklyReports,
} from './lib.js';

const PASSWORD = '12345';
const KEY = 'tb-data';
const AUTH = 'tb-auth';
const THEME_MODES = ['system', 'light', 'dark'];
const ACCENTS = ['purple', 'blue', 'green', 'orange', 'pink', 'red'];

function load() {
  let d = {};
  try {
    d = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch { /* 처음 */ }
  return {
    ledger: [], grantedDates: [], active: null,
    settings: { mode: 'system', accent: 'purple' }, sisterPin: null, reportSeen: null,
    ...d,
  };
}
let data = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(data));

const rid = () => Math.random().toString(16).slice(2, 14);
function addEntry(amount, note, kind, at = Date.now(), extra = {}) {
  data.ledger.push({ id: rid(), at, amount: Math.round(amount), note, kind, ...extra });
}

function endTogether(a, endAt, auto) {
  const dur = Math.max(1, Math.round((endAt - a.startedAt) / 1000));
  addEntry(0, `누나랑 같이 놀기 ${fmtDuration(dur)} (무료${auto ? ', 자동 종료' : ''})`, 'together', endAt, { duration: dur });
  data.active = null;
}

function settle(now = new Date()) {
  let changed = false;
  for (const g of dueGrants(now, data.grantedDates)) {
    const t = parseDate(g.date).getTime();
    if (g.weekly) {
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
    data.active = null;
    changed = true;
  }
  if (a && a.mode === 'together' && now.getTime() >= a.startedAt + TOGETHER_MAX * 1000) {
    endTogether(a, a.startedAt + TOGETHER_MAX * 1000, true);
    changed = true;
  }
  if (changed) save();
}

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
    nextInterest: g && g.weekly ? interestFor(balance) : 0,
    week: weekStats(data.ledger, now),
    settings: data.settings,
    sister: { pinSet: !!data.sisterPin, ...sisterGiven(now), dayMax: SISTER_DAY_MAX, weekMax: SISTER_WEEK_MAX, togetherMax: TOGETHER_MAX },
    newReport: latest && latest.date !== data.reportSeen ? latest : null,
    reportCount: reports.length,
    ledger: data.ledger.slice(-100).reverse(),
  };
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPin(pin, salt = rid() + rid()) {
  return { salt, hash: await sha(`${salt}:${pin}`) };
}

// 5번 틀리면 1분 잠금
function makeLimiter() {
  const f = { count: 0, until: 0 };
  return {
    blocked: () => (Date.now() < f.until ? Math.ceil((f.until - Date.now()) / 1000) : 0),
    fail: () => { if (++f.count >= 5) { f.count = 0; f.until = Date.now() + 60_000; } },
    ok: () => { f.count = 0; },
  };
}
const loginLimit = makeLimiter();
const pinLimit = makeLimiter();

class ApiError extends Error {}
const fail = (msg) => { throw new ApiError(msg); };

async function requirePin(pin) {
  const wait = pinLimit.blocked();
  if (wait) fail(`누나 비밀번호를 너무 많이 틀렸어요. ${wait}초 뒤에 다시 해 주세요.`);
  if (!data.sisterPin) fail('누나 비밀번호를 먼저 정해 주세요.');
  if ((await hashPin(pin, data.sisterPin.salt)).hash !== data.sisterPin.hash) {
    pinLimit.fail();
    fail('누나 비밀번호가 틀렸어요.');
  }
  pinLimit.ok();
}

const loggedIn = () => localStorage.getItem(AUTH) === '1';

async function handle(path, body) {
  if (path === '/api/login') {
    const wait = loginLimit.blocked();
    if (wait) fail(`너무 많이 틀렸어요. ${wait}초 뒤에 다시 해 주세요.`);
    if (String(body.password) !== PASSWORD) {
      loginLimit.fail();
      fail('비밀번호가 틀렸어요.');
    }
    loginLimit.ok();
    localStorage.setItem(AUTH, '1');
    return { ok: true };
  }
  if (!loggedIn()) fail('로그인이 필요해요.');
  if (path === '/api/logout') {
    localStorage.removeItem(AUTH);
    return { ok: true };
  }
  if (path === '/api/state') return state();
  if (path === '/api/reports') {
    settle();
    return { reports: weeklyReports(data.ledger, new Date()) };
  }

  settle();
  const now = Date.now();
  const balance = balanceOf(data.ledger);

  switch (path) {
    case '/api/settings':
      if (THEME_MODES.includes(body.mode)) data.settings.mode = body.mode;
      if (ACCENTS.includes(body.accent)) data.settings.accent = body.accent;
      break;
    case '/api/report/seen':
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) data.reportSeen = body.date;
      save();
      return { ok: true };
    case '/api/stopwatch/start':
      if (data.active) fail('이미 사용 중이에요.');
      if (balance <= 0) fail('남은 시간이 없어요. 토요일 지급을 기다려 주세요.');
      data.active = { mode: 'stopwatch', startedAt: now };
      break;
    case '/api/stopwatch/stop': {
      const a = data.active;
      if (!a || a.mode !== 'stopwatch') fail('스톱워치가 켜져 있지 않아요.');
      const used = Math.max(1, Math.round((now - a.startedAt) / 1000));
      addEntry(-used, `스톱워치 ${fmtDuration(used)} 사용 (후불)`, 'stopwatch', now);
      data.active = null;
      break;
    }
    case '/api/timer/start': {
      if (data.active) fail('이미 사용 중이에요.');
      const duration = Math.round(Number(body.seconds));
      if (!Number.isFinite(duration) || duration < 1) fail('시간을 1초 이상으로 정해 주세요.');
      if (duration > 24 * 3600) fail('24시간보다 길게 정할 수 없어요.');
      if (duration > balance) fail(`남은 시간(${fmtDuration(Math.max(0, balance))})보다 길게 정할 수 없어요.`);
      addEntry(-duration, `타이머 ${fmtDuration(duration)} (선불)`, 'timer', now);
      data.active = { mode: 'timer', startedAt: now, duration };
      break;
    }
    case '/api/timer/stop': {
      const a = data.active;
      if (!a || a.mode !== 'timer') fail('타이머가 켜져 있지 않아요.');
      const left = Math.floor((a.startedAt + a.duration * 1000 - now) / 1000);
      if (left > 0) addEntry(left, `타이머 일찍 끝냄, ${fmtDuration(left)} 돌려받음`, 'refund', now);
      data.active = null;
      break;
    }
    case '/api/sister/pin':
      if (!/^\d{4}$/.test(String(body.pin || ''))) fail('누나 비밀번호는 숫자 4자리로 정해 주세요.');
      if (data.sisterPin) await requirePin(body.oldPin);
      data.sisterPin = await hashPin(body.pin);
      break;
    case '/api/sister/gift': {
      await requirePin(body.pin);
      if (![5, 10, 15].includes(Number(body.minutes))) fail('5분, 10분, 15분 중에서 골라 주세요.');
      const amount = Number(body.minutes) * 60;
      const given = sisterGiven();
      if (amount > given.dayLeft) fail(given.dayLeft ? `오늘은 ${fmtDuration(given.dayLeft)}까지만 더 줄 수 있어요.` : '오늘 누나 타임은 다 썼어요.');
      if (amount > given.weekLeft) fail(given.weekLeft ? `이번 주에는 ${fmtDuration(given.weekLeft)}까지만 더 줄 수 있어요.` : '이번 주 누나 타임은 다 썼어요.');
      addEntry(amount, `누나 타임 선물 +${fmtDuration(amount)}`, 'sister', now);
      const a = data.active;
      if (a && a.mode === 'timer') {
        addEntry(-amount, `타이머 ${fmtDuration(amount)} 연장 (누나 타임)`, 'timer', now + 1);
        a.duration += amount;
      }
      break;
    }
    case '/api/together/start':
      await requirePin(body.pin);
      if (data.active) fail('지금 쓰고 있는 것을 먼저 멈춰 주세요.');
      data.active = { mode: 'together', startedAt: now };
      break;
    case '/api/together/stop': {
      const a = data.active;
      if (!a || a.mode !== 'together') fail('같이 놀기가 켜져 있지 않아요.');
      endTogether(a, now, false);
      break;
    }
    default:
      fail('없는 주소예요.');
  }
  save();
  return state();
}

// app.js의 call()과 같은 모양: 성공하면 데이터, 실패하면 { error, status }
window.TB_LOCAL = async (path, body) => {
  data = load(); // 다른 탭에서 바뀐 내용 반영
  try {
    return { ok: true, data: await handle(path, body || {}) };
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err);
    return { ok: false, status: err.message.includes('로그인') ? 401 : 400, data: { error: err.message } };
  }
};

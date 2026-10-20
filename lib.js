// 타임뱅크 규칙 (시간 단위: 초)

export const START_DATE = '2026-10-21'; // 이 날 첫 지급
export const FIRST_GRANT = 2 * 3600; // 첫 지급 2시간
export const WEEKLY_GRANT = 2 * 3600; // 매주 토요일 2시간
const SATURDAY = 6;

// 이자: 토요일 지급 직전에 남아 있던 시간의 10% (분 단위로 내림, 최대 30분). 마이너스면 없음.
export const INTEREST_RATE = 0.1;
export const INTEREST_MAX = 30 * 60;

// 누나 타임 (선물): 하루 최대 30분, 한 주(토요일부터) 최대 1시간
export const SISTER_DAY_MAX = 30 * 60;
export const SISTER_WEEK_MAX = 60 * 60;
// 누나랑 같이 놀기(무료): 켜 두고 잊어도 2시간이 지나면 자동으로 끝남
export const TOGETHER_MAX = 2 * 3600;

const pad = (n) => String(n).padStart(2, '0');

// 이 컴퓨터 시간대 기준 날짜 문자열 (YYYY-MM-DD)
export function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// 이 날짜에 들어오는 시간 (없으면 null). weekly: 토요일 지급(이자 붙음)
function grantOn(d) {
  const s = localDateStr(d);
  if (s === START_DATE) return { date: s, amount: FIRST_GRANT, note: '첫 지급', weekly: false };
  if (s > START_DATE && d.getDay() === SATURDAY) return { date: s, amount: WEEKLY_GRANT, note: '토요일 주간 지급', weekly: true };
  return null;
}

// 오늘까지 받아야 하는데 아직 안 받은 지급 목록
export function dueGrants(now, grantedDates) {
  const out = [];
  const today = localDateStr(now);
  for (let d = parseDate(START_DATE); localDateStr(d) <= today; d = addDays(d, 1)) {
    const g = grantOn(d);
    if (g && !grantedDates.includes(g.date)) out.push(g);
  }
  return out;
}

// 내일 이후 가장 가까운 지급 (오늘 지급은 이미 받았으므로)
export function nextGrant(now) {
  for (let d = addDays(now, 1), i = 0; i < 400; d = addDays(d, 1), i++) {
    const g = grantOn(d);
    if (g) return g;
  }
  return null;
}

export function balanceOf(ledger) {
  return ledger.reduce((sum, e) => sum + e.amount, 0);
}

export function interestFor(balance) {
  if (balance <= 0) return 0;
  return Math.min(INTEREST_MAX, Math.floor((balance * INTEREST_RATE) / 60) * 60);
}

// 기록 하나가 "사용"으로 몇 초인지 (타이머에서 돌려받은 시간은 사용에서 뺀다)
export function usageOf(e) {
  return e.kind === 'stopwatch' || e.kind === 'timer' || e.kind === 'refund' ? -e.amount : 0;
}

// 받은 시간 (지급, 이자, 누나 선물, 직접 넣음)
export function incomeOf(e) {
  return ['grant', 'interest', 'sister', 'adjust'].includes(e.kind) && e.amount > 0 ? e.amount : 0;
}

// 가장 최근 토요일 0시 (오늘이 토요일이면 오늘). 누나 선물 주간 한도 계산용
export function weekStart(now) {
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (d.getDay() !== SATURDAY) d = addDays(d, -1);
  return d;
}

// 날짜별 사용 시간과 누나랑 놀기 시간
function dailyUsage(ledger, days) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const e of ledger) {
    const day = byDate.get(localDateStr(new Date(e.at)));
    if (!day) continue;
    day.used += usageOf(e);
    if (e.kind === 'together') day.together += e.duration || 0;
  }
  for (const d of days) d.used = Math.max(0, d.used);
  return days;
}

// 오늘을 포함한 최근 7일
export function weekStats(ledger, now) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(now, -i);
    days.push({ date: localDateStr(d), weekday: d.getDay(), used: 0, together: 0 });
  }
  return dailyUsage(ledger, days);
}

// ---------- 주간 성적표 ----------
// 토요일 S의 성적표: [지난 토요일(또는 시작일), S) 동안의 기록. 이자·지급은 S에 들어오므로 포함되지 않는다.
function reportFor(ledger, satStr) {
  const sat = parseDate(satStr);
  const startD = addDays(sat, -7) < parseDate(START_DATE) ? parseDate(START_DATE) : addDays(sat, -7);
  const from = startD.getTime();
  const to = sat.getTime();
  const inWeek = ledger.filter((e) => e.at >= from && e.at < to);
  const days = [];
  for (let d = startD; d < sat; d = addDays(d, 1)) days.push({ date: localDateStr(d), weekday: d.getDay(), used: 0, together: 0 });
  dailyUsage(inWeek, days);
  const used = days.reduce((s, d) => s + d.used, 0);
  const received = inWeek.reduce((s, e) => s + incomeOf(e), 0);
  const saved = balanceOf(ledger.filter((e) => e.at < to));
  const sorted = [...days].sort((a, b) => b.used - a.used);
  const sister = inWeek.filter((e) => e.kind === 'sister' || e.kind === 'together');
  let title;
  if (saved < 0) title = { icon: '🔥', text: '다음 주엔 아껴 봐요' };
  else if (received && saved / received >= 0.5) title = { icon: '🏆', text: '절약왕' };
  else if (received && saved / received >= 0.25) title = { icon: '🌳', text: '절약 나무' };
  else title = { icon: '🌱', text: '절약 새싹' };
  return {
    date: satStr,
    from: localDateStr(startD),
    days,
    used,
    received,
    saved,
    interest: interestFor(saved),
    sisterCount: sister.length,
    sisterTime: sister.reduce((s, e) => s + (e.kind === 'sister' ? e.amount : e.duration || 0), 0),
    mostDay: sorted[0] && sorted[0].used > 0 ? sorted[0] : null,
    leastDay: sorted.length ? sorted[sorted.length - 1] : null,
    title,
  };
}

// 지난 성적표들 (최신이 먼저). 지난주와 비교값 포함.
export function weeklyReports(ledger, now) {
  const sats = [];
  const today = localDateStr(now);
  for (let d = addDays(parseDate(START_DATE), 1); localDateStr(d) <= today; d = addDays(d, 1)) {
    if (d.getDay() === SATURDAY) sats.push(localDateStr(d));
  }
  const reports = sats.map((s) => reportFor(ledger, s));
  reports.forEach((r, i) => { r.prevUsed = i > 0 ? reports[i - 1].used : null; });
  return reports.reverse();
}

// 1시간 3분 / 25분 / 40초
export function fmtDuration(sec) {
  sec = Math.round(Math.abs(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}시간`);
  if (m) parts.push(`${m}분`);
  if (!h && !m) parts.push(`${s}초`);
  return parts.join(' ');
}

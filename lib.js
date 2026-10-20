// 타임뱅크 규칙 (시간 단위: 초)

export const START_DATE = '2026-10-21'; // 이 날 첫 지급
export const FIRST_GRANT = 2 * 3600; // 첫 지급 2시간
export const WEEKLY_GRANT = 2 * 3600; // 매주 토요일 2시간
const SATURDAY = 6;

const pad = (n) => String(n).padStart(2, '0');

// 이 컴퓨터 시간대 기준 날짜 문자열 (YYYY-MM-DD)
export function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// 이 날짜에 들어오는 시간 (없으면 null)
function grantOn(d) {
  const s = localDateStr(d);
  if (s === START_DATE) return { date: s, amount: FIRST_GRANT, note: '첫 지급' };
  if (s > START_DATE && d.getDay() === SATURDAY) return { date: s, amount: WEEKLY_GRANT, note: '토요일 주간 지급' };
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

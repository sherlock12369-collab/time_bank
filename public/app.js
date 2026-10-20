(function () {
  const NAME = '김주원';
  const PIN_LENGTH = 5;
  const SISTER_PIN_LENGTH = 4;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const ACCENTS = { purple: '#7c5cff', blue: '#3b82f6', green: '#16a34a', orange: '#f97316', pink: '#ec4899', red: '#ef4444' };
  const $ = (s, root = document) => root.querySelector(s);
  let st = null; // 서버 상태
  let offset = 0; // 서버 시계 - 내 시계
  let mode = 'stopwatch';
  let pin = '';
  let alarmed = false;
  let reportShown = null;

  document.querySelectorAll('.who-name').forEach((el) => { el.textContent = NAME; });

  // 저장된 테마를 먼저 적용 (화면 깜빡임 방지)
  try {
    const t = JSON.parse(localStorage.getItem('tb-theme') || 'null');
    if (t) applyTheme(t);
  } catch (_) { /* 저장소 없음 */ }

  // ---------- 공통 ----------
  async function call(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login' && /로그인/.test(data.error || '')) showLogin();
    if (!res.ok) throw new Error(data.error || '오류가 났어요.');
    return data;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function clock(sec) {
    const neg = sec < 0;
    sec = Math.abs(Math.round(sec));
    return `${neg ? '-' : ''}${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  }
  function human(sec) {
    const neg = sec < 0;
    sec = Math.abs(Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const t = h ? `${h}시간${m ? ` ${m}분` : ''}` : m ? `${m}분${s ? ` ${s}초` : ''}` : `${s}초`;
    return (neg ? '-' : '') + t;
  }
  // 막대 위 짧은 표시: 1h30 / 25분 / 40초
  const short = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60) || ''}` : sec >= 60 ? `${Math.floor(sec / 60)}분` : `${Math.round(sec)}초`);
  const left = (sec) => (sec > 0 ? human(sec) : '다 씀');
  const md = (dateStr) => `${Number(dateStr.slice(5, 7))}월 ${Number(dateStr.slice(8))}일`;
  const now = () => Date.now() + offset;
  function showError(sel, msg) {
    const el = $(sel);
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- 테마 ----------
  function applyTheme(t) {
    document.documentElement.dataset.mode = t.mode || 'system';
    document.documentElement.dataset.accent = t.accent || 'purple';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = ACCENTS[t.accent] || ACCENTS.purple;
    try { localStorage.setItem('tb-theme', JSON.stringify(t)); } catch (_) { /* 저장소 없음 */ }
  }

  // ---------- 숫자 키패드 (로그인, 누나 비밀번호 공용) ----------
  function buildKeypad(host, onKey) {
    host.innerHTML = '';
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '지움', '0', '⌫']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = k;
      b.onclick = () => onKey(k);
      host.appendChild(b);
    }
  }
  const dotsHtml = (n, filled) => Array.from({ length: n }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  // ---------- 로그인 ----------
  function renderDots() { $('#dots').innerHTML = dotsHtml(PIN_LENGTH, pin.length); }
  function showLogin() {
    closeModal();
    $('#app').hidden = true;
    $('#login').hidden = false;
    pin = '';
    renderDots();
  }
  async function tryLogin() {
    try {
      await call('/api/login', { password: pin });
      showError('#login-error');
      await refresh();
    } catch (err) {
      showError('#login-error', err.message);
      shake($('.login-card'));
      pin = '';
      renderDots();
    }
  }
  function press(k) {
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (k === '지움') pin = '';
    else if (pin.length < PIN_LENGTH) pin += k;
    renderDots();
    if (pin.length === PIN_LENGTH) tryLogin();
  }
  buildKeypad($('#keypad'), press);
  document.addEventListener('keydown', (e) => {
    if ($('#login').hidden || !$('#modal').hidden) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
  });

  // ---------- 모달 ----------
  function openModal(html) {
    $('#modal-card').innerHTML = html;
    $('#modal').hidden = false;
    return $('#modal-card');
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // 누나 비밀번호 입력 모달. onDone(pin)이 오류 메시지를 throw하면 다시 입력.
  function askSisterPin({ title, sub, extraHtml = '', onReady, onDone }) {
    const card = openModal(`<h2>${title}</h2><p class="muted small">${sub}</p>${extraHtml}
      <div class="dots" id="sp-dots"></div><p class="error" id="sp-error" hidden></p>
      <div class="keypad" id="sp-keypad"></div>
      <div class="modal-foot"><button class="btn" id="sp-cancel">취소</button></div>`);
    let p = '';
    const render = () => { $('#sp-dots', card).innerHTML = dotsHtml(SISTER_PIN_LENGTH, p.length); };
    render();
    if (onReady) onReady(card);
    buildKeypad($('#sp-keypad', card), async (k) => {
      if (k === '⌫') p = p.slice(0, -1);
      else if (k === '지움') p = '';
      else if (p.length < SISTER_PIN_LENGTH) p += k;
      render();
      if (p.length !== SISTER_PIN_LENGTH) return;
      const entered = p;
      p = '';
      try {
        await onDone(entered, card);
      } catch (err) {
        $('#sp-error', card).textContent = err.message;
        $('#sp-error', card).hidden = false;
        shake(card);
        render();
      }
    });
    $('#sp-cancel', card).onclick = closeModal;
  }

  // 처음: 누나 비밀번호 정하기 (두 번 입력)
  function setupSisterPin(then) {
    let first = null;
    askSisterPin({
      title: '누나 비밀번호 정하기',
      sub: '누나만 아는 숫자 4자리를 정해 주세요.',
      onDone: async (p, card) => {
        if (!first) {
          first = p;
          $('p.muted', card).textContent = '한 번 더 눌러 주세요.';
          $('#sp-error', card).hidden = true;
          return;
        }
        if (p !== first) {
          first = null;
          $('p.muted', card).textContent = '누나만 아는 숫자 4자리를 정해 주세요.';
          throw new Error('두 번 누른 비밀번호가 달라요. 처음부터 다시 해 주세요.');
        }
        apply(await call('/api/sister/pin', { pin: p }));
        closeModal();
        then();
      },
    });
  }

  function sisterGift() {
    if (!st.sister.pinSet) return setupSisterPin(sisterGift);
    let minutes = 10;
    askSisterPin({
      title: '🎁 누나 타임 선물',
      sub: '얼마나 더 줄지 고르고 누나 비밀번호를 눌러 주세요.',
      extraHtml: `<div class="choice-row">${[5, 10, 15].map((m) => `<button class="btn${m === minutes ? ' on' : ''}" data-m="${m}">+${m}분</button>`).join('')}</div>
        <p class="muted small">더 줄 수 있는 시간: 오늘 ${left(st.sister.dayLeft)}, 이번 주 ${left(st.sister.weekLeft)}.${st.active && st.active.mode === 'timer' ? ' 타이머도 그만큼 늘어나요.' : ''}</p>`,
      onReady: (card) => {
        card.querySelectorAll('[data-m]').forEach((b) => {
          b.onclick = () => {
            minutes = Number(b.dataset.m);
            card.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
          };
        });
      },
      onDone: async (p) => {
        apply(await call('/api/sister/gift', { pin: p, minutes }));
        closeModal();
        toastMsg(`누나가 ${minutes}분을 선물했어요 🎁`);
      },
    });
  }

  function sisterTogether() {
    if (!st.sister.pinSet) return setupSisterPin(sisterTogether);
    if (st.active) return toastMsg('지금 쓰고 있는 것을 먼저 멈춰 주세요.');
    askSisterPin({
      title: '🎮 누나랑 같이 놀기',
      sub: `켜 둔 동안은 시간이 빠지지 않아요. (최대 ${human(st.sister.togetherMax)} 뒤 자동 종료) 누나 비밀번호를 눌러 주세요.`,
      onDone: async (p) => {
        apply(await call('/api/together/start', { pin: p }));
        closeModal();
      },
    });
  }
  $('#sis-gift').onclick = () => st && sisterGift();
  $('#sis-together').onclick = () => st && sisterTogether();

  function toastMsg(text) {
    showError('#start-error', '');
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:var(--card);padding:10px 16px;border-radius:12px;z-index:20;font-size:.92rem;max-width:90vw;text-align:center';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------- 테마 설정 ----------
  $('#btn-settings').onclick = () => {
    const s = st.settings;
    const card = openModal(`<h2>테마</h2>
      <div class="label" style="margin-top:12px">화면</div>
      <div class="seg">${[['system', '시스템'], ['light', '라이트'], ['dark', '다크']].map(([v, l]) => `<button data-mode="${v}" class="${s.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="label">강조 색</div>
      <div class="swatches">${Object.entries(ACCENTS).map(([k, c]) => `<button data-accent="${k}" class="${s.accent === k ? 'on' : ''}" style="background:${c}" aria-label="${k}"></button>`).join('')}</div>
      <div class="modal-foot"><button class="btn primary" id="th-close">닫기</button></div>`);
    const save = async (patch) => {
      applyTheme({ ...st.settings, ...patch });
      try { apply(await call('/api/settings', patch)); } catch (_) { /* 다음에 다시 */ }
    };
    card.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => {
        card.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
        save({ mode: b.dataset.mode });
      };
    });
    card.querySelectorAll('[data-accent]').forEach((b) => {
      b.onclick = () => {
        card.querySelectorAll('[data-accent]').forEach((x) => x.classList.toggle('on', x === b));
        save({ accent: b.dataset.accent });
      };
    });
    $('#th-close', card).onclick = closeModal;
  };

  // ---------- 주간 성적표 ----------
  function reportHtml(r) {
    const diff = r.prevUsed == null ? '' : r.used < r.prevUsed ? `지난주보다 ${human(r.prevUsed - r.used)} 덜 썼어요 👍` : r.used > r.prevUsed ? `지난주보다 ${human(r.used - r.prevUsed)} 더 썼어요` : '지난주와 똑같이 썼어요';
    const lines = [
      r.mostDay ? `제일 많이 쓴 날: ${WEEKDAYS[r.mostDay.weekday]}요일 (${human(r.mostDay.used)})` : '이번 주엔 하나도 안 썼어요!',
      r.leastDay && r.mostDay ? `제일 아낀 날: ${WEEKDAYS[r.leastDay.weekday]}요일 (${human(r.leastDay.used)})` : '',
      r.sisterCount ? `누나 타임 ${r.sisterCount}번 (${human(r.sisterTime)})` : '',
      r.interest ? `저축 이자 +${human(r.interest)} 받았어요` : '',
      diff,
    ].filter(Boolean);
    return `<div class="report-head"><div class="muted small">${md(r.from)} ~ ${md(r.date)} 주간 성적표</div>
        <div class="report-title">${r.title.icon}</div><div>${esc(r.title.text)}</div></div>
      <div class="report-grid">
        <div><b>${human(r.received)}</b><span>받은 시간</span></div>
        <div><b>${human(r.used)}</b><span>쓴 시간</span></div>
        <div><b style="color:${r.saved < 0 ? 'var(--minus)' : 'var(--plus)'}">${human(r.saved)}</b><span>남긴 시간 (저축)</span></div>
        <div><b>${r.interest ? '+' + human(r.interest) : '-'}</b><span>이자</span></div>
      </div>
      <div class="chart" style="height:110px">${barsHtml(r.days, null)}</div>
      <div class="report-lines">${lines.map((l) => `<div>• ${esc(l)}</div>`).join('')}</div>`;
  }

  async function showReports(startIdx = 0) {
    let reports;
    try { ({ reports } = await call('/api/reports')); } catch (err) { return toastMsg(err.message); }
    if (!reports.length) {
      const card = openModal('<h2>주간 성적표</h2><p class="muted">첫 성적표는 토요일에 나와요. (10월 24일)</p><div class="modal-foot"><button class="btn primary" id="rp-close">닫기</button></div>');
      $('#rp-close', card).onclick = closeModal;
      return;
    }
    let i = startIdx;
    const render = () => {
      const r = reports[i];
      const card = openModal(`${reportHtml(r)}
        <div class="report-nav"><button class="btn small" id="rp-prev" ${i >= reports.length - 1 ? 'disabled' : ''}>◀ 지난주</button>
        <span class="muted small">${i + 1} / ${reports.length}</span>
        <button class="btn small" id="rp-next" ${i === 0 ? 'disabled' : ''}>다음 주 ▶</button></div>
        <div class="modal-foot"><button class="btn" id="rp-save">이미지 저장</button><button class="btn primary" id="rp-close">닫기</button></div>`);
      $('#rp-prev', card).onclick = () => { i++; render(); };
      $('#rp-next', card).onclick = () => { i--; render(); };
      $('#rp-close', card).onclick = closeModal;
      $('#rp-save', card).onclick = () => saveReportImage(r);
    };
    render();
    if (reports[0] && st && st.newReport && st.newReport.date === reports[0].date) {
      call('/api/report/seen', { date: reports[0].date }).catch(() => {});
      st.newReport = null;
      updateReportDot();
    }
  }
  $('#btn-reports').onclick = () => showReports(0);

  function updateReportDot() {
    const btn = $('#btn-reports');
    const has = !!(st && st.newReport);
    let dot = $('.badge-dot', btn);
    if (has && !dot) {
      dot = document.createElement('span');
      dot.className = 'badge-dot';
      btn.appendChild(dot);
    } else if (!has && dot) dot.remove();
  }

  // 성적표를 그림 파일로 (가족에게 보내기용)
  function saveReportImage(r) {
    const W = 1080;
    const H = 1350;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const accent = ACCENTS[st.settings.accent] || ACCENTS.purple;
    const font = (size, weight = 400) => `${weight} ${size}px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.fillRect(0, 0, W, 16);
    g.textAlign = 'center';
    g.fillStyle = '#6b6b76';
    g.font = font(38);
    g.fillText(`${NAME}님의 타임뱅크 · ${md(r.from)} ~ ${md(r.date)}`, W / 2, 110);
    g.font = font(150);
    g.fillText(r.title.icon, W / 2, 290);
    g.fillStyle = '#111';
    g.font = font(70, 800);
    g.fillText(r.title.text, W / 2, 390);
    const boxes = [['받은 시간', human(r.received)], ['쓴 시간', human(r.used)], ['남긴 시간', human(r.saved)], ['이자', r.interest ? '+' + human(r.interest) : '-']];
    boxes.forEach(([label, value], k) => {
      const x = 80 + (k % 2) * 470;
      const y = 450 + Math.floor(k / 2) * 190;
      g.fillStyle = '#f5f5f7';
      g.beginPath();
      g.roundRect(x, y, 450, 165, 28);
      g.fill();
      g.textAlign = 'left';
      g.fillStyle = '#6b6b76';
      g.font = font(34);
      g.fillText(label, x + 34, y + 60);
      g.fillStyle = label === '남긴 시간' ? (r.saved < 0 ? '#e5484d' : '#12a150') : '#111';
      g.font = font(54, 800);
      g.fillText(value, x + 34, y + 130);
    });
    // 요일별 막대
    const max = Math.max(60, ...r.days.map((d) => d.used + d.together));
    const bw = 920 / r.days.length;
    r.days.forEach((d, k) => {
      const x = 80 + k * bw + bw * 0.2;
      const base = 1180;
      const hUsed = (d.used / max) * 260;
      const hTog = (d.together / max) * 260;
      g.fillStyle = accent;
      g.fillRect(x, base - hUsed, bw * 0.6, hUsed);
      g.fillStyle = '#f59e0b';
      g.fillRect(x, base - hUsed - hTog, bw * 0.6, hTog);
      g.fillStyle = '#6b6b76';
      g.textAlign = 'center';
      g.font = font(34);
      g.fillText(WEEKDAYS[d.weekday], x + bw * 0.3, base + 50);
    });
    g.font = font(30);
    g.fillText('보라: 쓴 시간   주황: 누나랑 같이 논 시간', W / 2, 1300);
    c.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `타임뱅크_성적표_${r.date}.png`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }, 'image/png');
  }

  // ---------- 메인 ----------
  async function refresh() {
    try {
      apply(await call('/api/state'));
    } catch (_) { /* 로그인 화면으로 이동했거나 서버 꺼짐 */ }
  }

  function apply(data) {
    st = data;
    offset = data.now - Date.now();
    applyTheme(data.settings);
    $('#login').hidden = true;
    $('#app').hidden = false;
    if (!data.active || data.active.mode !== 'timer') alarmed = false;
    renderLedger();
    renderChart();
    const g = data.nextGrant;
    $('#next-grant').textContent = g ? `다음 지급: ${md(g.date)} +${human(g.amount)} (${g.note})` : '';
    $('#interest').hidden = !data.nextInterest;
    $('#interest').textContent = `💰 지금처럼 남기면 토요일 이자 +${human(data.nextInterest)}`;
    const s = data.sister;
    $('#sis-limit').textContent = s.pinSet
      ? `선물 가능: 오늘 ${left(s.dayLeft)} · 이번 주 ${left(s.weekLeft)}`
      : '처음 쓸 때 누나 비밀번호(4자리)를 정해요.';
    updateReportDot();
    // 토요일에 새 성적표가 나오면 한 번 보여 준다
    if (data.newReport && reportShown !== data.newReport.date && $('#modal').hidden) {
      reportShown = data.newReport.date;
      showReports(0);
    }
    tick();
  }

  function tick() {
    if (!st) return;
    const a = st.active;
    let balance = st.balance;
    $('#active-card').hidden = !a;
    $('#start-card').hidden = !!a;
    $('#active-card').classList.toggle('together', !!a && a.mode === 'together');
    if (a && a.mode === 'stopwatch') {
      const used = (now() - a.startedAt) / 1000;
      balance -= used; // 후불: 멈출 때 빠지지만 미리 보여 줌
      $('#active-label').textContent = '스톱워치 (후불)';
      $('#active-clock').textContent = clock(used);
      $('#active-sub').textContent = balance < 0 ? `남은 시간을 ${human(-balance)} 넘었어요! 다음 지급에서 빠져요.` : `멈추면 쓴 시간만큼 빠져요. 이대로면 ${human(balance)} 남아요.`;
    } else if (a && a.mode === 'timer') {
      const remain = Math.max(0, (a.startedAt + a.duration * 1000 - now()) / 1000);
      $('#active-label').textContent = `타이머 ${human(a.duration)} (선불)`;
      $('#active-clock').textContent = clock(remain);
      $('#active-sub').textContent = '일찍 멈추면 남은 시간을 돌려받아요.';
      if (remain <= 0 && !alarmed) {
        alarmed = true;
        beep();
        setTimeout(refresh, 1500);
      }
    } else if (a && a.mode === 'together') {
      const played = (now() - a.startedAt) / 1000;
      $('#active-label').textContent = '🎮 누나랑 같이 노는 중 (무료)';
      $('#active-clock').textContent = clock(played);
      $('#active-sub').textContent = `시간이 빠지지 않아요. ${human(Math.max(0, st.sister.togetherMax - played))} 뒤 자동으로 끝나요.`;
      if (played >= st.sister.togetherMax) setTimeout(refresh, 1500);
    }
    const el = $('#balance');
    el.textContent = clock(balance);
    el.classList.toggle('neg', balance < 0);
  }

  // 막대 (todayDate가 있으면 그 날을 강조)
  function barsHtml(days, todayDate) {
    const max = Math.max(30 * 60, ...days.map((d) => d.used + d.together));
    return days.map((d) => {
      const hu = (d.used / max) * 100;
      const ht = (d.together / max) * 100;
      const total = d.used + d.together;
      return `<div class="bar${d.date === todayDate ? ' today' : ''}">
        <span class="v">${total ? short(total) : ''}</span>
        <div class="stack" style="height:${Math.max(3, hu + ht)}%"><div class="used" style="flex:${d.used || 0}"></div><div class="tog" style="flex:${d.together || 0}"></div></div>
        <span class="d">${WEEKDAYS[d.weekday]}</span></div>`;
    }).join('');
  }

  function renderChart() {
    const days = st.week;
    const today = days[days.length - 1].date;
    $('#chart').innerHTML = barsHtml(days, today);
    const total = days.reduce((s, d) => s + d.used, 0);
    const together = days.reduce((s, d) => s + d.together, 0);
    $('#stat-row').innerHTML = `<div><b>${human(total)}</b><span>7일 사용</span></div>
      <div><b>${human(Math.round(total / 7))}</b><span>하루 평균</span></div>
      <div><b>${human(together)}</b><span>누나랑 논 시간</span></div>`;
    if (!$('#chart').nextElementSibling.classList.contains('legend')) {
      $('#chart').insertAdjacentHTML('afterend', '<div class="legend"><span><i style="background:var(--accent)"></i>쓴 시간</span><span><i style="background:var(--together)"></i>누나랑 놀기 (무료)</span></div>');
    }
  }

  function renderLedger() {
    const ul = $('#ledger');
    if (!st.ledger.length) {
      ul.innerHTML = '<li class="empty">아직 기록이 없어요</li>';
      return;
    }
    ul.innerHTML = '';
    for (const e of st.ledger) {
      const li = document.createElement('li');
      const d = new Date(e.at);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const cls = e.amount > 0 ? 'plus' : e.amount < 0 ? 'minus' : 'zero';
      const amt = e.amount ? `${e.amount > 0 ? '+' : ''}${human(e.amount)}` : '무료';
      li.innerHTML = `<div><div class="note"></div><div class="when">${when}</div></div><div class="amt ${cls}">${amt}</div>`;
      li.querySelector('.note').textContent = e.note;
      ul.appendChild(li);
    }
  }

  function beep() {
    try {
      const ctx = new AudioContext();
      [0, 0.4, 0.8].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.25, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.3);
      });
    } catch (_) { /* 소리 못 냄 */ }
  }

  async function act(path, body) {
    showError('#start-error');
    try {
      apply(await call(path, body ?? {}));
    } catch (err) {
      showError('#start-error', err.message);
    }
  }

  // 모드 탭
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      mode = t.dataset.mode;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('#mode-stopwatch').hidden = mode !== 'stopwatch';
      $('#mode-timer').hidden = mode !== 'timer';
      showError('#start-error');
    };
  });

  // 타이머 빠른 선택
  for (const m of [1, 5, 15, 30, 60, 90, 120]) {
    const b = document.createElement('button');
    b.textContent = human(m * 60);
    b.onclick = () => {
      $('#tm-h').value = Math.floor(m / 60);
      $('#tm-m').value = m % 60;
      $('#tm-s').value = 0;
      document.querySelectorAll('#chips button').forEach((x) => x.classList.toggle('on', x === b));
    };
    $('#chips').appendChild(b);
  }
  // 직접 고치면 빠른 선택 표시를 지운다
  for (const id of ['#tm-h', '#tm-m', '#tm-s']) {
    $(id).addEventListener('input', () => document.querySelectorAll('#chips button').forEach((x) => x.classList.remove('on')));
  }

  $('#sw-start').onclick = () => act('/api/stopwatch/start');
  $('#tm-start').onclick = () => {
    const v = (id) => Math.max(0, Math.floor(Number($(id).value) || 0));
    act('/api/timer/start', { seconds: v('#tm-h') * 3600 + v('#tm-m') * 60 + v('#tm-s') });
  };
  $('#stop').onclick = () => {
    if (!st || !st.active) return;
    const paths = { stopwatch: '/api/stopwatch/stop', timer: '/api/timer/stop', together: '/api/together/stop' };
    act(paths[st.active.mode]);
  };
  $('#logout').onclick = async () => {
    await call('/api/logout', {}).catch(() => {});
    st = null;
    showLogin();
  };

  setInterval(tick, 500);
  setInterval(() => { if (st) refresh(); }, 15000);
  refresh().then(() => { if (!st) showLogin(); });
})();

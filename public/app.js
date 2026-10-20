(function () {
  const NAME = '김주원';
  const PIN_LENGTH = 5;
  const $ = (s) => document.querySelector(s);
  let st = null; // 서버 상태
  let offset = 0; // 서버 시계 - 내 시계
  let mode = 'stopwatch';
  let pin = '';
  let alarmed = false;

  $('#login-name').textContent = NAME;
  $('#app-name').textContent = NAME;

  // ---------- 공통 ----------
  async function call(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') showLogin();
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
    let t = h ? `${h}시간${m ? ` ${m}분` : ""}` : m ? `${m}분${s ? ` ${s}초` : ""}` : `${s}초`;
    return (neg ? '-' : '') + t;
  }
  const now = () => Date.now() + offset;
  function showError(sel, msg) {
    const el = $(sel);
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // ---------- 로그인 ----------
  function renderDots() {
    $('#dots').innerHTML = Array.from({ length: PIN_LENGTH }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  }
  function showLogin() {
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
      const card = $('.login-card');
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
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
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '지움', '0', '⌫']) {
    const b = document.createElement('button');
    b.textContent = k;
    b.onclick = () => press(k);
    $('#keypad').appendChild(b);
  }
  document.addEventListener('keydown', (e) => {
    if ($('#login').hidden) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
  });

  // ---------- 메인 ----------
  async function refresh() {
    try {
      const data = await call('/api/state');
      apply(data);
    } catch (_) { /* 로그인 화면으로 이동했거나 서버 꺼짐 */ }
  }

  function apply(data) {
    st = data;
    offset = data.now - Date.now();
    $('#login').hidden = true;
    $('#app').hidden = false;
    if (!data.active) alarmed = false;
    renderLedger();
    const g = data.nextGrant;
    $('#next-grant').textContent = g ? `다음 지급: ${g.date.slice(5).replace('-', '월 ')}일 +${human(g.amount)} (${g.note})` : '';
    tick();
  }

  function tick() {
    if (!st) return;
    const a = st.active;
    let balance = st.balance;
    $('#active-card').hidden = !a;
    $('#start-card').hidden = !!a;
    if (a && a.mode === 'stopwatch') {
      const used = (now() - a.startedAt) / 1000;
      balance -= used; // 후불: 멈출 때 빠지지만 미리 보여 줌
      $('#active-label').textContent = '스톱워치 (후불)';
      $('#active-clock').textContent = clock(used);
      $('#active-sub').textContent = balance < 0 ? `남은 시간을 ${human(-balance)} 넘었어요! 다음 지급에서 빠져요.` : `멈추면 쓴 시간만큼 빠져요. 이대로면 ${human(balance)} 남아요.`;
    } else if (a && a.mode === 'timer') {
      const left = Math.max(0, (a.startedAt + a.duration * 1000 - now()) / 1000);
      $('#active-label').textContent = `타이머 ${human(a.duration)} (선불)`;
      $('#active-clock').textContent = clock(left);
      $('#active-sub').textContent = '일찍 멈추면 남은 시간을 돌려받아요.';
      if (left <= 0 && !alarmed) {
        alarmed = true;
        beep();
        setTimeout(refresh, 1500);
      }
    }
    const el = $('#balance');
    el.textContent = clock(balance);
    el.classList.toggle('neg', balance < 0);
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
      li.innerHTML = `<div><div class="note"></div><div class="when">${when}</div></div><div class="amt ${e.amount >= 0 ? 'plus' : 'minus'}">${e.amount >= 0 ? '+' : ''}${human(e.amount)}</div>`;
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
  for (const m of [15, 30, 60, 90, 120]) {
    const b = document.createElement('button');
    b.textContent = m >= 60 ? `${m / 60}시간${m % 60 ? ' 반' : ''}` : `${m}분`;
    b.onclick = () => {
      $('#tm-min').value = m;
      document.querySelectorAll('#chips button').forEach((x) => x.classList.toggle('on', x === b));
    };
    $('#chips').appendChild(b);
  }

  $('#sw-start').onclick = () => act('/api/stopwatch/start');
  $('#tm-start').onclick = () => act('/api/timer/start', { minutes: Number($('#tm-min').value) });
  $('#stop').onclick = () => {
    if (!st || !st.active) return;
    act(st.active.mode === 'stopwatch' ? '/api/stopwatch/stop' : '/api/timer/stop');
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

// Choir practice multitrack player — Web Audio API, all stems sample-locked.
(() => {
  const PARTS = [
    { key: 'S', name: '女高音', en: 'Soprano' },
    { key: 'A', name: '女低音', en: 'Alto' },
    { key: 'T', name: '男高音', en: 'Tenor' },
    { key: 'B', name: '男低音', en: 'Bass' },
  ];
  const KINDS = [
    { key: 'piano', name: '琴 Piano' },
    { key: 'vocal', name: '人聲 Vocal' },
  ];
  const TRACK_IDS = PARTS.flatMap(p => KINDS.map(k => `${p.key}-${k.key}`));
  const DEFAULT_VOL = { piano: 75, vocal: 60 };
  const defVol = id => DEFAULT_VOL[id.split("-")[1]];
  const DEFAULT_MASTER = 60;

  const $ = id => document.getElementById(id);
  const ui = {
    songs: $('songs'), title: $('songTitle'), sub: $('songSub'), status: $('status'),
    seek: $('seek'), loopZone: $('loopZone'), tNow: $('tNow'), tEnd: $('tEnd'),
    play: $('play'), back: $('back'), setA: $('setA'), setB: $('setB'), clearLoop: $('clearLoop'),
    speeds: $('speeds'), master: $('master'), parts: $('parts'),
    allPiano: $('allPiano'), allVocal: $('allVocal'), reset: $('reset'),
  };

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  // iOS 17+: play through the silent switch where supported.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

  const masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);

  // Per-track state + gain node
  const tracks = {};
  TRACK_IDS.forEach(id => {
    const g = ctx.createGain();
    g.connect(masterGain);
    tracks[id] = { id, gain: g, vol: defVol(id), mute: false, solo: false, el: null };
  });

  const cache = new Map();         // `${song}/${speed}` -> {id: AudioBuffer}
  let song = null;                 // current song manifest entry
  let speed = 1;
  let buffers = null;              // current buffers
  let duration = 0;                // seconds, at current speed
  let sources = [];
  let playing = false;
  let startCtxTime = 0, startOffset = 0; // in buffer seconds
  let pausedAt = 0;                      // buffer seconds
  let loopA = null, loopB = null;        // MUSICAL seconds (at 100%), speed-independent
  let loadToken = 0;
  let seeking = false;

  // ---------- helpers ----------
  const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); const r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, '0')}`; };
  const volToGain = v => Math.pow(v / 100, 2);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const loopOn = () => loopA != null && loopB != null && loopB > loopA;

  function speedDir(s) { return s === 1 ? '' : `${Math.round(s * 100)}/`; }

  async function loadBuffers(songId, s) {
    const key = `${songId}/${s}`;
    if (cache.has(key)) return cache.get(key);
    const entries = await Promise.all(TRACK_IDS.map(async id => {
      const res = await fetch(`audio/${songId}/${speedDir(s)}${id}.mp3`);
      if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const buf = await new Promise((ok, bad) => ctx.decodeAudioData(data, ok, bad));
      return [id, buf];
    }));
    const obj = Object.fromEntries(entries);
    cache.set(key, obj);
    return obj;
  }

  // ---------- position ----------
  function position() {
    if (!playing) return pausedAt;
    let p = startOffset + (ctx.currentTime - startCtxTime);
    if (loopOn()) {
      const a = loopA / speed, b = loopB / speed;
      if (startOffset < b && p >= b) p = a + ((p - a) % (b - a));
    }
    return Math.min(p, duration);
  }

  // ---------- playback ----------
  function stopSources() {
    sources.forEach(s => { s.onended = null; try { s.stop(); } catch (e) {} s.disconnect(); });
    sources = [];
  }

  function startAt(offset) {
    stopSources();
    if (!buffers) return;
    offset = Math.max(0, Math.min(offset, duration - 0.01));
    const when = ctx.currentTime + 0.05;
    const lo = loopOn();
    if (lo && offset >= loopB / speed) offset = loopA / speed;
    TRACK_IDS.forEach((id, i) => {
      const src = ctx.createBufferSource();
      src.buffer = buffers[id];
      if (lo) { src.loop = true; src.loopStart = loopA / speed; src.loopEnd = loopB / speed; }
      src.connect(tracks[id].gain);
      src.start(when, offset);
      if (i === 0) src.onended = () => { if (playing) { playing = false; pausedAt = 0; stopSources(); render(); } };
      sources.push(src);
    });
    startCtxTime = when;
    startOffset = offset;
    playing = true;
  }

  async function play() {
    if (!buffers) return;
    if (ctx.state !== 'running') await ctx.resume();
    let at = pausedAt;
    if (loopOn() && (at < loopA / speed || at >= loopB / speed)) at = loopA / speed;
    startAt(at);
    render();
  }
  function pause() { pausedAt = position(); playing = false; stopSources(); render(); }
  function seekTo(t) {
    if (playing) startAt(t); else pausedAt = t;
    render();
  }

  // ---------- mixing ----------
  function applyGains() {
    const anySolo = TRACK_IDS.some(id => tracks[id].solo);
    TRACK_IDS.forEach(id => {
      const t = tracks[id];
      const audible = !t.mute && (!anySolo || t.solo);
      t.gain.gain.setTargetAtTime(audible ? volToGain(t.vol) : 0, ctx.currentTime, 0.015);
      if (t.el) {
        t.el.m.classList.toggle('on', t.mute);
        t.el.s.classList.toggle('on', t.solo);
        t.el.root.classList.toggle('silent', !audible);
        t.el.vol.value = t.vol;
      }
    });
    masterGain.gain.setTargetAtTime(volToGain(+ui.master.value), ctx.currentTime, 0.015);
    if (song) store.set(`mix3:${song.id}`, Object.fromEntries(TRACK_IDS.map(id => [id, { v: tracks[id].vol, m: tracks[id].mute, s: tracks[id].solo }])));
    store.set('master2', +ui.master.value);
  }

  function restoreMix(songId) {
    const saved = store.get(`mix3:${songId}`, {});
    TRACK_IDS.forEach(id => {
      const s = saved[id] || {};
      tracks[id].vol = s.v ?? defVol(id); tracks[id].solo = !!s.s; tracks[id].mute = !!s.m && !s.s;
    });
  }

  function buildMixer() {
    ui.parts.innerHTML = '';
    PARTS.forEach(p => {
      const row = document.createElement('div');
      row.className = 'part';
      row.innerHTML = `<div class="part-name">${p.name}<small>${p.en}</small></div>`;
      KINDS.forEach(k => {
        const id = `${p.key}-${k.key}`;
        const ch = document.createElement('div');
        ch.className = 'ch';
        ch.innerHTML = `<span class="ch-label">${k.name}</span>
          <button class="m" aria-label="Mute ${p.en} ${k.key}">M</button>
          <button class="s" aria-label="Solo ${p.en} ${k.key}">S</button>
          <input type="range" min="0" max="100" aria-label="${p.en} ${k.key} volume">`;
        const [m, s] = ch.querySelectorAll('button');
        const vol = ch.querySelector('input');
        m.onclick = () => { const t = tracks[id]; t.mute = !t.mute; if (t.mute) t.solo = false; applyGains(); };
        s.onclick = () => { const t = tracks[id]; t.solo = !t.solo; if (t.solo) t.mute = false; applyGains(); };
        vol.oninput = () => { tracks[id].vol = +vol.value; applyGains(); };
        tracks[id].el = { root: ch, m, s, vol };
        row.appendChild(ch);
      });
      ui.parts.appendChild(row);
    });
  }

  function toggleGroup(kind) {
    const ids = TRACK_IDS.filter(id => id.endsWith(kind));
    const allMuted = ids.every(id => tracks[id].mute);
    ids.forEach(id => { tracks[id].mute = !allMuted; if (!allMuted) tracks[id].solo = false; });
    applyGains();
  }

  // ---------- loop ----------
  function setLoopPoint(which) {
    const mus = position() * speed;
    if (which === 'A') { loopA = mus; if (loopB != null && loopB <= loopA) loopB = null; }
    else { loopB = mus; if (loopA == null) loopA = 0; if (loopB <= loopA) loopB = null; }
    if (playing) startAt(position());
    render();
  }
  function clearLoop() {
    loopA = loopB = null;
    if (playing) { const p = position(); startAt(p); }
    render();
  }

  // ---------- speed / song ----------
  async function changeSpeed(s) {
    if (s === speed || !song) return;
    const wasPlaying = playing;
    const musPos = position() * speed;
    if (playing) pause();
    setBusy(true, '準備慢速… Preparing');
    const token = ++loadToken;
    try {
      const b = await loadBuffers(song.id, s);
      if (token !== loadToken) return;
      speed = s; buffers = b; duration = b[TRACK_IDS[0]].duration;
      pausedAt = Math.min(musPos / speed, duration);
      setBusy(false);
      if (wasPlaying) play(); else render();
    } catch (e) { setBusy(false, '載入失敗 Load failed'); console.error(e); }
  }

  async function selectSong(entry) {
    if (playing) pause();
    song = entry; loopA = loopB = null; pausedAt = 0; buffers = null;
    ui.title.textContent = entry.title;
    ui.sub.textContent = entry.subtitle || '';
    [...ui.songs.children].forEach(b => b.classList.toggle('on', b.dataset.id === entry.id));
    restoreMix(entry.id); applyGains();
    setBusy(true, '載入中 Loading…');
    const token = ++loadToken;
    try {
      const b = await loadBuffers(entry.id, speed);
      if (token !== loadToken) return;
      buffers = b; duration = b[TRACK_IDS[0]].duration;
      setBusy(false);
    } catch (e) { setBusy(false, '載入失敗 Load failed'); console.error(e); }
    render();
  }

  function setBusy(busy, msg) {
    ui.play.disabled = busy || !buffers;
    [...ui.speeds.children].forEach(b => b.disabled = busy);
    ui.status.textContent = msg ?? (buffers ? '準備好了 Ready' : '');
  }

  // ---------- render ----------
  function render() {
    const p = position();
    if (!seeking) ui.seek.value = duration ? Math.round((p / duration) * 1000) : 0;
    ui.tNow.textContent = fmt(p);
    ui.tEnd.textContent = fmt(duration);
    ui.play.textContent = playing ? '❚❚' : '▶';
    ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    ui.setA.classList.toggle('set', loopA != null);
    ui.setB.classList.toggle('set', loopB != null);
    ui.clearLoop.disabled = loopA == null && loopB == null;
    [...ui.speeds.children].forEach(b => b.classList.toggle('on', +b.dataset.speed === speed));
    const musDur = duration * speed;
    if (musDur && loopA != null) {
      const a = loopA / musDur, b = (loopB ?? loopA) / musDur;
      ui.loopZone.hidden = false;
      ui.loopZone.style.left = `${a * 100}%`;
      ui.loopZone.style.width = `${Math.max(0, b - a) * 100}%`;
    } else ui.loopZone.hidden = true;
  }
  function tick() { if (playing) render(); requestAnimationFrame(tick); }

  // ---------- wire up ----------
  ui.play.onclick = () => (playing ? pause() : play());
  ui.back.onclick = () => seekTo(loopOn() ? loopA / speed : 0);
  ui.setA.onclick = () => setLoopPoint('A');
  ui.setB.onclick = () => setLoopPoint('B');
  ui.clearLoop.onclick = clearLoop;
  ui.seek.addEventListener('input', () => { seeking = true; ui.tNow.textContent = fmt((ui.seek.value / 1000) * duration); });
  ui.seek.addEventListener('change', () => { seeking = false; seekTo((ui.seek.value / 1000) * duration); });
  ui.speeds.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) changeSpeed(+b.dataset.speed); });
  ui.master.value = store.get('master2', DEFAULT_MASTER);
  ui.master.oninput = applyGains;
  ui.allPiano.onclick = () => toggleGroup('piano');
  ui.allVocal.onclick = () => toggleGroup('vocal');
  ui.reset.onclick = () => {
    TRACK_IDS.forEach(id => Object.assign(tracks[id], { vol: defVol(id), mute: false, solo: false }));
    ui.master.value = DEFAULT_MASTER; applyGains();
  };
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !/INPUT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); ui.play.click(); }
  });

  buildMixer();
  requestAnimationFrame(tick);

  if (location.protocol === 'file:') {
    ui.status.textContent = '請用網址開啟 Open via http://localhost:8765 (not the file)';
    return;
  }
  fetch('songs.json').then(r => r.json()).then(list => {
    list.forEach(s => {
      const b = document.createElement('button');
      b.dataset.id = s.id;
      b.innerHTML = s.ready ? s.title : `${s.title}<small>即將推出</small>`;
      b.disabled = !s.ready;
      b.onclick = () => { if (song?.id !== s.id) selectSong(s); };
      ui.songs.appendChild(b);
    });
    const ready = list.filter(s => s.ready);
    const def = ready.find(s => s.default) || ready[0];
    if (def) selectSong(def);
  }).catch(e => { ui.status.textContent = '載入失敗 Load failed'; console.error(e); });
})();

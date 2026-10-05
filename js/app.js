/* ==========================================================================
   app.js — UI controller
   ========================================================================== */
(function (global) {
  'use strict';

  const VF = global.VF;
  const {
    $, $$, el, clamp, round, formatBytes, formatTime, sanitizeFilename, debounce,
    makeUrl, releaseUrl, releaseAll, CancelToken, toast, saveBlob, libs
  } = VF;

  /* ------------------------------------------------------------------ state */

  const state = {
    tab: 'gif',
    queue: [],
    activeId: null,
    media: null,
    loadSeq: 0,
    rotation: 0,
    overlayPos: 'bc',
    extractMode: 'every',
    loopMode: 'forward',
    frames: [],
    lbIndex: -1,
    lastPicked: -1,
    result: { blob: null, url: null },
    token: null,
    busy: false
  };

  let D = {};          // dom cache
  let timeline = null;
  let player = null;
  let previewTime = 0;
  let pendingExtractValue = null;   // restored value waits for the mode's min/max to be applied

  const THEME_KEY = 'gf-theme';
  const SETTINGS_KEY = 'gf-settings';

  const sfx = (name, arg) => { if (VF.sfx) VF.sfx.play(name, arg); };

  /* ------------------------------------------------------------------- boot */

  function init() {
    buildSourceCard();
    cacheDom();
    checkLibraries();
    restoreSettings();

    timeline = VF.createTimeline(D.sourceCard, {
      onRange: (r) => { previewTime = clamp(previewTime, r.start, r.end); updateEstimates(); schedulePreview(); },
      onScrub: (t) => { previewTime = t; if (state.media) { state.media.seek(t); player && player.pause(); schedulePreview(true); } },
      onDragStart: () => { if (player) player.pause(); }
    });

    bindTabs();
    bindDropzone();
    bindGifSettings();
    bindAdjustments();
    bindOverlay();
    bindExtractSettings();
    bindActions();
    bindChrome();

    updateEstimates();
    applyLockState();
    global.addEventListener('resize', debounce(moveGlow, 120));
    global.addEventListener('pagehide', () => { saveSettings(); releaseAll(); });

    // one listener covers every slider, select and checkbox in both panels
    document.addEventListener('input', queueSaveSettings);
    document.addEventListener('change', queueSaveSettings);

    if (!VF.render.supportsCanvasFilter) {
      toast('This browser has no canvas filter support — colour adjustments run in a slower fallback path.', { type: 'warn', title: 'Compatibility note', duration: 8000 });
    }
  }

  function buildSourceCard() {
    const tpl = $('#source-card-template');
    const node = tpl.content.firstElementChild.cloneNode(true);
    const panel = $('#panel-gif .col-main');
    panel.insertBefore(node, panel.firstChild);
  }

  function cacheDom() {
    const ids = [
      'source-card', 'source-sub', 'clear-source', 'dropzone', 'file-input', 'dz-title', 'dz-sub',
      'queue', 'queue-list', 'queue-count', 'queue-clear', 'source-body',
      'preview-canvas', 'play-btn', 'loop-btn', 'pv-current', 'pv-duration', 'pv-badge', 'file-meta',
      'fps', 'fps-out', 'size-chips', 'size-out', 'out-w', 'out-h', 'lock-aspect',
      'quality', 'quality-out', 'dither', 'loop-forever',
      'target-size', 'target-out', 'target-hint', 'speed', 'speed-out', 'loop-mode', 'loop-mode-out',
      'brightness', 'brightness-out', 'contrast', 'contrast-out', 'saturation', 'saturation-out',
      'rotation-seg', 'rotation-out', 'reset-adjust',
      'ov-enable', 'overlay-body', 'ov-text', 'ov-font', 'ov-size', 'ov-size-out',
      'ov-color', 'ov-stroke-color', 'ov-stroke-w', 'ov-stroke-out', 'ov-pos', 'ov-pos-out',
      'ov-x', 'ov-x-out', 'ov-y', 'ov-y-out', 'ov-opacity', 'ov-opacity-out',
      'estimate', 'result-stage', 'result-empty', 'result-img', 'result-meta', 'result-actions',
      'progress-block', 'progress-bar', 'progress-label', 'progress-pct',
      'encode-btn', 'cancel-btn', 'download-btn', 'copy-btn', 'batch-btn', 'batch-hint',
      'extract-mode', 'extract-mode-out', 'extract-value-field', 'extract-value-label',
      'extract-value', 'extract-value-out', 'frame-format', 'jpeg-quality-field',
      'jpeg-quality', 'jpeg-quality-out', 'frames-use-adjust', 'extract-estimate', 'extract-estimate-text',
      'frame-grid', 'frame-empty', 'sel-count', 'total-count',
      'select-all', 'select-none', 'select-invert',
      'frame-progress-block', 'frame-progress-bar', 'frame-progress-label', 'frame-progress-pct',
      'extract-btn', 'frame-cancel-btn', 'zip-btn', 'zip-meta', 'frame-batch-btn',
      'toasts', 'lightbox', 'lb-img', 'lb-close', 'lb-prev', 'lb-next', 'lb-caption',
      'about-modal', 'about-btn', 'privacy-badge', 'privacy-pop', 'lib-banner', 'lib-banner-text', 'lib-retry',
      'sound-btn', 'theme-btn'
    ];
    ids.forEach((id) => { D[camel(id)] = document.getElementById(id); });

    D.tabs = $$('.tab-btn');
    D.tabGlow = $('.tab-glow');
    D.lockables = $$('[data-requires="source"]');
  }

  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function checkLibraries() {
    const L = libs();
    const missing = [];
    if (!L.gifReader) missing.push('omggif (GIF decoding)');
    if (!L.gifEncoder) missing.push('gif.js (GIF encoding)');
    if (!L.jszip) missing.push('JSZip (archives)');
    if (missing.length) {
      D.libBanner.hidden = false;
      D.libBannerText.textContent = 'Could not load ' + missing.join(', ') + ' from the CDN. Reconnect and retry — nothing runs server-side.';
    }
    D.libRetry.addEventListener('click', () => global.location.reload());
  }

  /* ------------------------------------------------------------------- tabs */

  function bindTabs() {
    D.tabs.forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = D.tabs.indexOf(btn);
        const next = D.tabs[(i + (e.key === 'ArrowRight' ? 1 : D.tabs.length - 1)) % D.tabs.length];
        next.focus();
        switchTab(next.dataset.tab);
      });
    });
    requestAnimationFrame(moveGlow);
  }

  function switchTab(tab) {
    if (tab === state.tab) { moveGlow(); return; }
    state.tab = tab;
    sfx('tab');

    D.tabs.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    const panelId = tab === 'gif' ? '#panel-gif' : '#panel-frames';
    $$('.tab-panel').forEach((p) => {
      const on = p.matches(panelId);
      p.classList.toggle('is-active', on);
      p.hidden = !on;
    });

    // move the shared source card into the freshly activated panel
    const col = $(panelId + ' .col-main');
    col.insertBefore(D.sourceCard, col.firstChild);

    D.dzSub.innerHTML = tab === 'gif'
      ? 'MP4 · WebM · MOV · GIF &nbsp;—&nbsp; or <span class="link">browse files</span> / <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste'
      : 'Video or animated GIF &nbsp;—&nbsp; or <span class="link">browse files</span> / <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste';
    D.sourceSub.textContent = state.media ? state.media.file.name : (tab === 'gif' ? 'Drop a video to begin' : 'Drop a video or GIF to begin');

    moveGlow();
    updateEstimates();
    requestAnimationFrame(() => { if (player) player.resize(); schedulePreview(true); });
  }

  function moveGlow() {
    const btn = D.tabs.find((b) => b.classList.contains('is-active'));
    if (!btn || !D.tabGlow) return;
    D.tabGlow.style.width = btn.offsetWidth + 'px';
    D.tabGlow.style.transform = 'translateX(' + (btn.offsetLeft - 5) + 'px)';
  }

  /* -------------------------------------------------------------- dropzone */

  function bindDropzone() {
    const dz = D.dropzone;

    dz.addEventListener('click', (e) => { if (e.target.closest('a,button,input')) return; D.fileInput.click(); });
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); D.fileInput.click(); }
    });
    D.fileInput.addEventListener('change', () => { addFiles(D.fileInput.files); D.fileInput.value = ''; });

    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('is-over'); }));
    ['dragleave', 'dragend'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); if (!dz.contains(e.relatedTarget)) dz.classList.remove('is-over'); }));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('is-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) { sfx('drop'); addFiles(files); }
    });

    // whole-window drop guard so stray drops don't navigate away
    ['dragover', 'drop'].forEach((ev) =>
      global.addEventListener(ev, (e) => { if (!dz.contains(e.target)) e.preventDefault(); }));

    document.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
      let files = cd.files && cd.files.length ? Array.from(cd.files) : [];
      if (!files.length && cd.items) {
        files = Array.from(cd.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
      }
      if (files.length) { addFiles(files); toast('Pasted ' + files.length + ' file(s) from the clipboard.', { type: 'info' }); }
    });

    D.clearSource.addEventListener('click', clearSource);
    D.queueClear.addEventListener('click', () => {
      if (state.busy) return toast('Wait for the current job to finish first.', { type: 'warn' });
      state.queue = [];
      state.activeId = null;
      clearSource();
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const accepted = [];
    for (const f of files) {
      const kind = VF.detectKind(f);
      if (kind === 'unknown') { toast('"' + f.name + '" is not a video or GIF file.', { type: 'error', title: 'Unsupported file' }); continue; }
      if (f.size === 0) { toast('"' + f.name + '" is empty.', { type: 'error' }); continue; }
      accepted.push({ id: 'f' + Date.now() + Math.random().toString(36).slice(2, 7), file: f, kind, status: 'pending' });
    }
    if (!accepted.length) return;

    state.queue = state.queue.concat(accepted);
    renderQueue();

    if (!state.activeId) await setActive(accepted[0].id);
    if (accepted.length > 1) toast(accepted.length + ' files queued. Use "Batch export" to process them all.', { type: 'info', duration: 6000 });
  }

  function renderQueue() {
    const q = state.queue;
    D.queue.hidden = q.length < 2;
    D.queueCount.textContent = q.length;
    D.queueList.innerHTML = '';

    q.forEach((item) => {
      const li = el('li', {
        class: 'queue-item' + (item.id === state.activeId ? ' is-active' : '') + (item.status === 'done' ? ' is-done' : '')
      }, [
        el('span', { class: 'qi-status', html: queueIcon(item), 'aria-hidden': 'true' }),
        el('span', { class: 'qi-name', text: item.file.name, title: item.file.name }),
        el('span', { class: 'qi-size', text: formatBytes(item.file.size) }),
        el('button', { class: 'qi-remove', type: 'button', 'aria-label': 'Remove ' + item.file.name, text: '×' })
      ]);
      li.addEventListener('click', (e) => {
        if (e.target.closest('.qi-remove')) return;
        if (item.id !== state.activeId) { sfx('pick'); setActive(item.id); }
      });
      $('.qi-remove', li).addEventListener('click', (e) => {
        e.stopPropagation();
        removeQueued(item.id);
      });
      D.queueList.appendChild(li);
    });
  }

  function queueIcon(item) {
    if (item.status === 'done') return '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
    if (item.status === 'error') return '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    if (item.status === 'busy') return '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4V1L8 5l4 4V6a6 6 0 11-6 6H4a8 8 0 108-8z"/></svg>';
    return '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 5a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2H4zm6 3.5l6 3.5-6 3.5v-7z"/></svg>';
  }

  function removeQueued(id) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i < 0) return;
    sfx('remove');
    state.queue.splice(i, 1);
    if (state.activeId === id) {
      state.activeId = state.queue.length ? state.queue[Math.max(0, i - 1)].id : null;
      if (state.activeId) setActive(state.activeId);
      else clearSource();
    }
    renderQueue();
  }

  async function setActive(id) {
    if (state.busy) { toast('Finish or cancel the running job first.', { type: 'warn' }); return; }
    const item = state.queue.find((q) => q.id === id);
    if (!item) return;
    state.activeId = id;
    renderQueue();
    await openMedia(item);
  }

  async function openMedia(item) {
    const seq = ++state.loadSeq;
    if (state.media) { state.media.destroy(); state.media = null; }
    player && player.pause();
    D.dropzone.classList.add('is-loading');
    D.dzTitle && (D.dzTitle.textContent = 'Reading file…');

    try {
      const media = await VF.media.open(item.file);
      if (seq !== state.loadSeq) { media.destroy(); return; }

      state.media = media;
      D.sourceBody.hidden = false;
      D.clearSource.hidden = false;
      D.sourceSub.textContent = media.file.name;
      D.pvBadge.textContent = media.kind === 'gif' ? 'GIF · ' + (media.frameCount || 0) + ' frames' : 'Video';
      renderFileMeta(media);

      timeline.load(media.duration);
      previewTime = 0;
      D.pvDuration.textContent = formatTime(media.duration);
      applyLockState();
      updateEstimates();

      player = createPlayer(media);
      await renderPreview(true);
      if (seq !== state.loadSeq) return;

      generateThumbs(media, seq);
      toast('Loaded ' + media.file.name + ' · ' + media.width + '×' + media.height + ' · ' + formatTime(media.duration), { type: 'success', title: 'Ready' });
    } catch (err) {
      if (seq !== state.loadSeq) return;
      item.status = 'error';
      renderQueue();
      toast(err.message || String(err), { type: 'error', title: 'Could not open file', duration: 9000 });
      if (!state.media) { D.sourceBody.hidden = true; D.clearSource.hidden = true; applyLockState(); }
    } finally {
      if (seq === state.loadSeq) {
        D.dropzone.classList.remove('is-loading');
        D.dzTitle.textContent = 'Drag & drop your media';
      }
    }
  }

  async function generateThumbs(media, seq) {
    try {
      const count = clamp(Math.round(media.duration * 2), 6, 12);
      const strip = await media.thumbnails(count, 110, 62);
      if (seq !== state.loadSeq) return;
      timeline.setThumbs(strip);
      strip.width = strip.height = 0;
      await renderPreview(true);
    } catch (e) { /* thumbnails are cosmetic */ }
  }

  function renderFileMeta(media) {
    const pills = [
      ['File', media.file.name],
      ['Type', media.kind === 'gif' ? 'Animated GIF' : (media.file.type || 'video')],
      ['Size', formatBytes(media.file.size)],
      ['Resolution', media.width + ' × ' + media.height],
      ['Duration', formatTime(media.duration)]
    ];
    if (media.kind === 'gif') pills.push(['Frames', String(media.frameCount)]);
    if (media.kind === 'gif') {
      const avg = media.delays.reduce((a, b) => a + b, 0) / media.delays.length;
      pills.push(['Source rate', round(1000 / avg, 1) + ' fps']);
    }
    D.fileMeta.innerHTML = '';
    pills.forEach(([k, v]) => {
      D.fileMeta.appendChild(el('span', { class: 'meta-pill' }, [
        el('span', { text: k + ' ' }),
        el('b', { text: v, title: String(v) })
      ]));
    });
  }

  function clearSource() {
    if (state.busy) return;
    state.loadSeq++;
    if (state.media) { state.media.destroy(); state.media = null; }
    if (player) { player.pause(); player = null; }

    const dropped = state.activeId;
    state.queue = state.queue.filter((q) => q.id !== dropped);
    state.activeId = null;
    previewTime = 0;
    clearFrames();
    clearResult();
    D.sourceBody.hidden = true;
    D.clearSource.hidden = true;
    D.sourceSub.textContent = state.tab === 'gif' ? 'Drop a video to begin' : 'Drop a video or GIF to begin';
    D.fileMeta.innerHTML = '';
    const ctx = D.previewCanvas.getContext('2d');
    ctx && ctx.clearRect(0, 0, D.previewCanvas.width, D.previewCanvas.height);
    renderQueue();
    applyLockState();
    updateEstimates();

    const next = state.queue.find((q) => q.status !== 'error');
    if (next) setActive(next.id);
  }

  function applyLockState() {
    const locked = !state.media;
    D.lockables.forEach((c) => c.classList.toggle('is-locked', locked));
    D.encodeBtn.disabled = locked;
    D.extractBtn.disabled = locked;
    D.batchBtn.disabled = locked || state.queue.length < 1;
    D.frameBatchBtn.disabled = locked || state.queue.length < 1;
  }

  /* --------------------------------------------------------------- preview */

  function previewGeometry() {
    const m = state.media;
    if (!m) return null;
    const s = readSettings();
    const out = state.tab === 'gif'
      ? VF.render.computeOutput(m.width, m.height, s.rotation, s.width, s.height, s.lockAspect)
      : VF.pipeline.nativeOutput(m.width, m.height, s.rotation);

    const k = Math.min(1, 760 / Math.max(out.outW, 1));
    const scale = (v) => Math.max(2, Math.round(v * k));
    return {
      outW: scale(out.outW) - (scale(out.outW) % 2),
      outH: scale(out.outH),
      dW: scale(out.dW),
      dH: scale(out.dH),
      rotation: s.rotation,
      adjust: s.adjust,
      overlay: s.overlay,
      full: out
    };
  }

  let previewQueued = false;
  function schedulePreview(force) {
    if (!state.media || state.busy) return;
    if (previewQueued && !force) return;
    previewQueued = true;
    requestAnimationFrame(() => { previewQueued = false; renderPreview(); });
  }

  async function renderPreview(immediate) {
    const m = state.media;
    if (!m || state.busy) return;
    const geo = previewGeometry();
    if (!geo) return;

    if (!immediate && player && player.playing) return; // the play loop is already drawing
    const range = timeline.getRange();
    const t = clamp(previewTime, range.start, range.end);
    try { await m.seek(t); } catch (e) { /* ignore */ }
    timeline.setTimeOnly(t);
    VF.render.renderFrame(m.drawable, D.previewCanvas, geo);
    D.pvCurrent.textContent = formatTime(t);
  }

  function createPlayer(media) {
    let raf = 0;
    let playing = false;
    let gifIdx = 0;
    let gifAcc = 0;
    let last = 0;

    const geo = () => previewGeometry();

    function frame(t) {
      const g = geo();
      if (!g) return;
      previewTime = t;
      timeline.setTimeOnly(t);
      VF.render.renderFrame(media.drawable, D.previewCanvas, g);
      D.pvCurrent.textContent = formatTime(t);
    }

    async function tick(ts) {
      if (!playing) return;
      const range = timeline.getRange();
      const dt = last ? Math.min(120, ts - last) : 16;
      last = ts;

      if (media.kind === 'video') {
        let t = media.el.currentTime;
        if (t >= range.end - 0.005 || t < range.start - 0.05) {
          if (!player || !player.loop) return stop();
          media.el.pause();
          await media.seek(range.start);
          try { await media.el.play(); } catch (e) { return stop(); }
          t = range.start;
        }
        frame(t);
      } else {
        gifAcc += dt;
        const delay = media.delays[gifIdx] || 100;
        if (gifAcc >= delay) {
          gifAcc -= delay;
          gifIdx++;
          const times = media.frameTimes;
          if (gifIdx >= times.length || times[gifIdx] > range.end) {
            if (!player || !player.loop) return stop();
            gifIdx = firstIndexInRange(times, range.start);
          }
          await media.seek(times[gifIdx]);
        }
        frame(times_(media, gifIdx));
      }
      raf = requestAnimationFrame(tick);
    }

    function firstIndexInRange(times, start) {
      for (let i = 0; i < times.length; i++) if (times[i] >= start - 1e-6) return i;
      return 0;
    }
    function times_(m, i) { return m.frameTimes[clamp(i, 0, m.frameTimes.length - 1)] || 0; }

    function start() {
      if (playing || !media) return;
      const range = timeline.getRange();
      playing = true;
      last = 0;
      gifAcc = 0;
      D.playBtn.setAttribute('aria-label', 'Pause preview');
      D.playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

      if (media.kind === 'video') {
        media.seek(range.start).then(() => {
          const p = media.el.play();
          if (p && p.catch) p.catch(() => stop());
        });
      } else {
        gifIdx = firstIndexInRange(media.frameTimes, range.start);
        media.seek(media.frameTimes[gifIdx]);
      }
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      playing = false;
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      if (media.kind === 'video') { try { media.el.pause(); } catch (e) { /* noop */ } }
      D.playBtn.setAttribute('aria-label', 'Play preview');
      D.playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
    }

    return {
      get playing() { return playing; },
      get loop() { return D.loopBtn.getAttribute('aria-pressed') === 'true'; },
      start, pause: stop, toggle() { playing ? stop() : start(); },
      resize() { /* geometry is recomputed per frame */ }
    };
  }

  /* -------------------------------------------------------------- settings */

  function bindRange(input, output, format) {
    const sync = () => {
      const min = +input.min, max = +input.max, v = +input.value;
      input.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(2) + '%');
      if (output) output.textContent = format ? format(v) : v;
    };
    input.addEventListener('input', () => {
      sync();
      const min = +input.min, max = +input.max;
      sfx('tick', max > min ? (+input.value - min) / (max - min) : 0);
    });
    sync();
    return sync;
  }

  function bindGifSettings() {
    bindRange(D.fps, D.fpsOut, (v) => v + ' FPS');
    bindRange(D.quality, D.qualityOut, (v) => v + ' · ' + (v > 80 ? 'excellent' : v > 55 ? 'good' : v > 30 ? 'small' : 'tiny'));
    bindRange(D.speed, D.speedOut, (v) => (+v).toFixed(2) + '×');

    D.sizeChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      activate(D.sizeChips, '.chip', (c) => c === chip);
      sfx('pick');
      const w = +chip.dataset.width;
      D.sizeOut.textContent = chip.textContent.trim();
      if (w > 0) {
        D.outW.value = w;
        if (D.lockAspect.checked) syncHeightFromWidth();
      } else {
        D.outW.focus();
      }
      afterSettingsChange();
    });

    const onWidth = () => { syncHeightFromWidth(); markCustomWidth(); afterSettingsChange(); };
    D.outW.addEventListener('input', debounce(onWidth, 120));
    D.outH.addEventListener('input', debounce(() => afterSettingsChange(), 120));
    D.lockAspect.addEventListener('change', () => { syncHeightFromWidth(); afterSettingsChange(); });
    D.fps.addEventListener('input', () => afterSettingsChange());
    D.quality.addEventListener('input', () => afterSettingsChange());
    D.speed.addEventListener('input', () => afterSettingsChange());
    D.dither.addEventListener('change', () => afterSettingsChange());
    D.loopForever.addEventListener('change', () => afterSettingsChange());

    D.loopMode.addEventListener('click', (e) => {
      const seg = e.target.closest('.seg');
      if (!seg) return;
      state.loopMode = seg.dataset.loop;
      activate(D.loopMode, '.seg', (s) => s === seg);
      D.loopModeOut.textContent = seg.textContent.trim();
      sfx('pick');
      afterSettingsChange();
    });

    D.targetSize.addEventListener('change', () => {
      syncTargetHint();
      sfx(+D.targetSize.value ? 'on' : 'off');
      afterSettingsChange();
    });
  }

  /** Ticking a width that is not on the preset ladder flips the chips to Custom. */
  function markCustomWidth() {
    const w = +D.outW.value;
    const chip = $$('.chip', D.sizeChips).find((c) => +c.dataset.width === w);
    activate(D.sizeChips, '.chip', (c) => c === (chip || $('.chip[data-width="0"]', D.sizeChips)));
    D.sizeOut.textContent = chip ? chip.textContent.trim() : w + '×' + (+D.outH.value || 0);
  }

  function activate(container, selector, isOn) {
    $$(selector, container).forEach((n) => {
      const on = isOn(n);
      n.classList.toggle('is-active', on);
      n.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function syncHeightFromWidth() {
    if (!D.lockAspect.checked || !state.media) return;
    const s = readSettings();
    const out = VF.render.computeOutput(state.media.width, state.media.height, s.rotation, +D.outW.value || 480, +D.outH.value || 270, true);
    D.outW.value = out.outW;
    D.outH.value = out.outH;
    D.sizeOut.textContent = out.outW + '×' + out.outH;
  }

  function bindAdjustments() {
    bindRange(D.brightness, D.brightnessOut, (v) => v + '%');
    bindRange(D.contrast, D.contrastOut, (v) => v + '%');
    bindRange(D.saturation, D.saturationOut, (v) => v + '%');

    [D.brightness, D.contrast, D.saturation].forEach((r) => r.addEventListener('input', () => afterSettingsChange()));

    D.rotationSeg.addEventListener('click', (e) => {
      const seg = e.target.closest('.seg');
      if (!seg) return;
      state.rotation = +seg.dataset.rot;
      activate(D.rotationSeg, '.seg', (s) => s === seg);
      D.rotationOut.textContent = state.rotation + '°';
      sfx('pick');
      syncHeightFromWidth();
      afterSettingsChange();
    });

    D.resetAdjust.addEventListener('click', () => {
      D.brightness.value = 100; D.contrast.value = 100; D.saturation.value = 100;
      [D.brightness, D.contrast, D.saturation].forEach((r) => r.dispatchEvent(new Event('input')));
      const zero = $('.seg[data-rot="0"]', D.rotationSeg);
      if (zero) zero.click();
      toast('Adjustments reset.', { type: 'info', duration: 2200 });
    });
  }

  function bindOverlay() {
    bindRange(D.ovSize, D.ovSizeOut, (v) => v + '%');
    bindRange(D.ovStrokeW, D.ovStrokeOut, (v) => v + '%');
    bindRange(D.ovX, D.ovXOut, (v) => (v > 0 ? '+' : '') + v + '%');
    bindRange(D.ovY, D.ovYOut, (v) => (v > 0 ? '+' : '') + v + '%');
    bindRange(D.ovOpacity, D.ovOpacityOut, (v) => v + '%');

    const toggle = () => {
      const on = D.ovEnable.checked;
      D.overlayBody.classList.toggle('is-off', !on);
      D.overlayBody.setAttribute('aria-hidden', on ? 'false' : 'true');
      $$('input,select,textarea,button', D.overlayBody).forEach((n) => { n.tabIndex = on ? 0 : -1; });
      afterSettingsChange();
    };
    D.ovEnable.addEventListener('change', () => { sfx(D.ovEnable.checked ? 'on' : 'off'); toggle(); });

    D.ovPos.addEventListener('click', (e) => {
      const btn = e.target.closest('.pos');
      if (!btn) return;
      state.overlayPos = btn.dataset.pos;
      activate(D.ovPos, '.pos', (b) => b === btn);
      D.ovPosOut.textContent = VF.render.POSITIONS[state.overlayPos] || '';
      sfx('pick');
      afterSettingsChange();
    });
    D.ovPosOut.textContent = VF.render.POSITIONS[state.overlayPos];

    [D.ovText, D.ovSize, D.ovStrokeW, D.ovX, D.ovY, D.ovOpacity].forEach((n) => n.addEventListener('input', () => afterSettingsChange()));
    [D.ovFont, D.ovColor, D.ovStrokeColor].forEach((n) => n.addEventListener('input', () => afterSettingsChange()));
    toggle();
  }

  function bindExtractSettings() {
    D.extractMode.addEventListener('click', (e) => {
      const seg = e.target.closest('.seg');
      if (!seg) return;
      state.extractMode = seg.dataset.mode;
      activate(D.extractMode, '.seg', (s) => s === seg);
      sfx('pick');
      applyExtractMode();
    });

    const valueSync = bindRange(D.extractValue, D.extractValueOut, (v) => String(v));
    D.extractValue.addEventListener('input', () => { valueSync(); updateEstimates(); });
    bindRange(D.jpegQuality, D.jpegQualityOut, (v) => v + '%');
    D.jpegQuality.addEventListener('input', debounce(() => updateEstimates(), 100));
    D.frameFormat.addEventListener('change', () => {
      D.jpegQualityField.hidden = D.frameFormat.value !== 'image/jpeg';
      updateEstimates();
    });
    D.framesUseAdjust.addEventListener('change', () => { updateEstimates(); schedulePreview(); });
    D.jpegQualityField.hidden = D.frameFormat.value !== 'image/jpeg';
    applyExtractMode();

    if (pendingExtractValue !== null) {
      D.extractValue.value = clamp(Math.round(pendingExtractValue), +D.extractValue.min, +D.extractValue.max);
      D.extractValue.dispatchEvent(new Event('input'));
      pendingExtractValue = null;
    }
  }

  function applyExtractMode() {
    const m = state.extractMode;
    const labels = {
      every: ['every frame', 'Every N frames', 2, 60, 1, 5],
      nth: ['every Nth frame', 'Every N frames', 2, 60, 1, 5],
      fps: ['N frames per second', 'Frames per second', 1, 30, 1, 8],
      count: ['exactly N frames', 'Total frames', 1, 500, 1, 24]
    }[m];
    D.extractModeOut.textContent = labels[0];
    D.extractValueLabel.textContent = labels[1];
    D.extractValue.min = labels[2];
    D.extractValue.max = labels[3];
    D.extractValue.step = labels[4];
    D.extractValue.value = labels[5];
    D.extractValue.dispatchEvent(new Event('input'));
    D.extractValueField.hidden = m === 'every';
    updateEstimates();
  }

  function readSettings() {
    return {
      fps: clamp(+D.fps.value || 12, 5, 30),
      width: clamp(+D.outW.value || 480, 32, 2048),
      height: clamp(+D.outH.value || 270, 32, 2048),
      lockAspect: D.lockAspect.checked,
      quality: clamp(+D.quality.value || 72, 1, 100),
      dither: D.dither.value,
      loop: D.loopForever.checked,
      speed: clamp(+D.speed.value || 1, 0.25, 2),
      loopMode: state.loopMode,
      targetMB: +D.targetSize.value || 0,
      rotation: state.rotation,
      adjust: { brightness: +D.brightness.value, contrast: +D.contrast.value, saturation: +D.saturation.value },
      overlay: {
        enabled: D.ovEnable.checked,
        text: D.ovText.value,
        font: D.ovFont.value,
        sizePct: +D.ovSize.value,
        color: D.ovColor.value,
        strokeColor: D.ovStrokeColor.value,
        strokePct: +D.ovStrokeW.value,
        opacity: +D.ovOpacity.value,
        position: state.overlayPos,
        x: +D.ovX.value,
        y: +D.ovY.value
      },
      range: timeline ? timeline.getRange() : { start: 0, end: 0 },
      mode: state.extractMode,
      value: +D.extractValue.value,
      format: D.frameFormat.value,
      jpegQuality: (+D.jpegQuality.value || 92) / 100,
      useAdjust: D.framesUseAdjust.checked
    };
  }

  const afterSettingsChange = debounce(() => { updateEstimates(); schedulePreview(); }, 30);

  /**
   * What an encode will really use. With a size budget picked, fps, width and
   * quality are walked down until the estimate fits; `auto` reports the change.
   */
  function effectiveSettings(media, base) {
    const s = Object.assign({ auto: null }, base || readSettings());
    if (!media || !s.targetMB) return s;

    const solved = VF.pipeline.solveBudget(media.width, media.height, s, s.targetMB * 1024 * 1024);
    if (!solved) { s.auto = 'unsolvable'; return s; }

    if (solved.fps !== s.fps || solved.width !== s.width || solved.quality !== s.quality) {
      s.auto = { fps: solved.fps, width: solved.width, quality: solved.quality, est: solved.est, frames: solved.frames };
    }
    s.fps = solved.fps;
    s.width = solved.width;
    s.height = solved.height;
    s.quality = solved.quality;
    return s;
  }

  /* ---------------------------------------------------------- persistence */

  const PREF_FIELDS = [
    'fps', 'out-w', 'out-h', 'lock-aspect', 'quality', 'dither', 'loop-forever',
    'target-size', 'speed', 'brightness', 'contrast', 'saturation',
    'ov-enable', 'ov-text', 'ov-font', 'ov-size', 'ov-color', 'ov-stroke-color',
    'ov-stroke-w', 'ov-x', 'ov-y', 'ov-opacity',
    'extract-value', 'frame-format', 'jpeg-quality', 'frames-use-adjust'
  ];

  function collectPrefs() {
    const values = {};
    PREF_FIELDS.forEach((id) => {
      const n = document.getElementById(id);
      if (n) values[id] = n.type === 'checkbox' ? n.checked : n.value;
    });
    return {
      values,
      rotation: state.rotation,
      loopMode: state.loopMode,
      extractMode: state.extractMode,
      overlayPos: state.overlayPos
    };
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(collectPrefs())); } catch (e) { /* blocked or full */ }
  }

  const queueSaveSettings = debounce(saveSettings, 400);

  function setNumber(input, raw) {
    const v = parseFloat(raw);
    if (isFinite(v)) input.value = String(clamp(v, +input.min, +input.max));
  }

  function setSelect(sel, val) {
    if ($$('option', sel).some((o) => o.value === String(val))) sel.value = String(val);
  }

  function findSeg(container, selector, key, want) {
    return $$(selector, container).find((n) => n.dataset[key] === String(want)) || null;
  }

  function restoreSettings() {
    let prefs = null;
    try { prefs = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { prefs = null; }
    if (!prefs || typeof prefs !== 'object') return;

    const values = prefs.values || {};
    PREF_FIELDS.forEach((id) => {
      if (id === 'extract-value' || values[id] === undefined || values[id] === null) return;
      const n = document.getElementById(id);
      if (!n) return;
      if (n.type === 'checkbox') n.checked = !!values[id];
      else if (n.tagName === 'SELECT') setSelect(n, values[id]);
      else if (n.type === 'range' || n.type === 'number') setNumber(n, values[id]);
      else n.value = String(values[id]);
    });

    // the extract slider's bounds come from its mode, so its value lands after binding
    const ev = parseFloat(values['extract-value']);
    if (isFinite(ev)) pendingExtractValue = ev;

    const rot = findSeg(D.rotationSeg, '.seg', 'rot', prefs.rotation);
    if (rot) state.rotation = +rot.dataset.rot;
    const loop = findSeg(D.loopMode, '.seg', 'loop', prefs.loopMode);
    if (loop) state.loopMode = loop.dataset.loop;
    const mode = findSeg(D.extractMode, '.seg', 'mode', prefs.extractMode);
    if (mode) state.extractMode = mode.dataset.mode;
    const pos = findSeg(D.ovPos, '.pos', 'pos', prefs.overlayPos);
    if (pos && VF.render.POSITIONS[pos.dataset.pos]) state.overlayPos = pos.dataset.pos;

    syncControls();
  }

  /** Push the restored values and state back into the chips, segments and readouts. */
  function syncControls() {
    markCustomWidth();
    activate(D.rotationSeg, '.seg', (s) => +s.dataset.rot === state.rotation);
    D.rotationOut.textContent = state.rotation + '°';
    const loopSeg = findSeg(D.loopMode, '.seg', 'loop', state.loopMode) || $('.seg', D.loopMode);
    activate(D.loopMode, '.seg', (s) => s === loopSeg);
    D.loopModeOut.textContent = loopSeg ? loopSeg.textContent.trim() : '';
    const modeSeg = findSeg(D.extractMode, '.seg', 'mode', state.extractMode) || $('.seg', D.extractMode);
    activate(D.extractMode, '.seg', (s) => s === modeSeg);
    activate(D.ovPos, '.pos', (b) => b.dataset.pos === state.overlayPos);
    D.ovPosOut.textContent = VF.render.POSITIONS[state.overlayPos] || '';
    syncTargetHint();
  }

  const TARGET_HINT_OFF = 'Pick a budget and frame rate, width and quality are tuned down automatically until the estimate fits.';

  function syncTargetHint() {
    const mb = +D.targetSize.value || 0;
    D.targetHint.textContent = mb
      ? 'Frame rate, width and quality are tuned down automatically until the estimate fits ' + mb + ' MB.'
      : TARGET_HINT_OFF;
    D.targetOut.textContent = mb ? 'under ' + mb + ' MB' : 'off';
  }

  function updateEstimates() {
    const m = state.media;
    if (!m) {
      D.estimate.textContent = 'Load a video to estimate output size';
      D.estimate.style.color = '';
      const off = +D.targetSize.value || 0;
      if (off) D.targetOut.textContent = 'under ' + off + ' MB';
      D.extractEstimateText.textContent = 'Load a video or GIF to see how many frames will be extracted.';
      return;
    }
    const s = readSettings();

    // GIF tab
    const eff = effectiveSettings(m, s);
    if (eff.auto === 'unsolvable') {
      D.estimate.textContent = 'Nothing fits ' + s.targetMB + ' MB — shorten the clip, then try again.';
      D.estimate.style.color = '#ffb4b4';
      D.targetOut.textContent = 'cannot fit';
    } else {
      const out = VF.render.computeOutput(m.width, m.height, eff.rotation, eff.width, eff.height, eff.lockAspect);
      const times = VF.pipeline.planGif(m, eff);
      const est = VF.pipeline.estimateGifBytes(out.outW, out.outH, times.length, eff.quality, eff.dither);
      const budget = VF.pipeline.checkBudget(out.outW, out.outH, times.length);
      const rate = eff.fps * eff.speed;
      D.estimate.textContent = '≈ ' + formatBytes(est) + ' · ' + out.outW + '×' + out.outH + ' · ' + times.length + ' frames · ' +
        formatTime(Math.max(0, s.range.end - s.range.start)) + ' @ ' + eff.fps + ' fps' +
        (Math.abs(eff.speed - 1) > 0.01 ? ' · ' + eff.speed.toFixed(2) + '× (' + rate.toFixed(1) + ' fps out)' : '');
      D.estimate.style.color = budget.ok ? '' : '#ffb4b4';
      if (s.targetMB) {
        D.targetOut.textContent = eff.auto
          ? 'fits · auto ' + eff.fps + ' fps ' + out.outW + 'p'
          : (est <= s.targetMB * 1024 * 1024 ? 'fits · ' + formatBytes(est) : 'over budget');
      }
    }

    // Frames tab
    let samples = [];
    try { samples = VF.media.planSamples(m, s.mode, s.value, s.range); } catch (e) { /* noop */ }
    const rot = s.useAdjust ? s.rotation : 0;
    const no = VF.pipeline.nativeOutput(m.width, m.height, rot);
    const perFrame = s.format === 'image/jpeg' ? no.outW * no.outH * 0.28 * s.jpegQuality : no.outW * no.outH * 0.9;
    D.extractEstimateText.textContent = samples.length
      ? samples.length + ' frames · ' + no.outW + '×' + no.outH + ' · ' + (s.format === 'image/jpeg' ? 'JPEG' : 'PNG') + ' · ≈ ' + formatBytes(perFrame * samples.length)
      : 'The selected range contains no frames to extract.';
    D.extractEstimate.style.borderColor = samples.length > 3000 ? 'rgba(248,113,113,.5)' : '';
  }

  /* --------------------------------------------------------------- actions */

  function bindActions() {
    D.encodeBtn.addEventListener('click', runEncode);
    D.extractBtn.addEventListener('click', runExtract);
    D.cancelBtn.addEventListener('click', () => state.token && state.token.cancel());
    D.frameCancelBtn.addEventListener('click', () => state.token && state.token.cancel());
    D.downloadBtn.addEventListener('click', () => {
      if (!state.result.blob) return;
      saveBlob(state.result.blob, outputName('gif'));
      pulse(D.downloadBtn);
    });
    D.copyBtn.addEventListener('click', copyResult);
    D.batchBtn.addEventListener('click', runBatchGif);
    D.frameBatchBtn.addEventListener('click', runBatchFrames);

    D.zipBtn.addEventListener('click', downloadFramesZip);
    D.selectAll.addEventListener('click', () => { setAllFrames(true); sfx('pick'); });
    D.selectNone.addEventListener('click', () => { setAllFrames(false); sfx('unpick'); });
    D.selectInvert.addEventListener('click', () => {
      state.frames.forEach((f) => { f.selected = !f.selected; paintTile(f); });
      state.lastPicked = -1;
      updateFrameCounts();
      sfx('pick');
    });

    D.playBtn.addEventListener('click', () => player && player.toggle());
    D.loopBtn.addEventListener('click', () => {
      const on = D.loopBtn.getAttribute('aria-pressed') === 'true';
      D.loopBtn.setAttribute('aria-pressed', on ? 'false' : 'true');
      D.loopBtn.classList.toggle('is-on', !on);
      sfx(on ? 'off' : 'on');
    });

    D.lbClose.addEventListener('click', closeLightbox);
    D.lbPrev.addEventListener('click', () => stepLightbox(-1));
    D.lbNext.addEventListener('click', () => stepLightbox(1));
    D.lightbox.addEventListener('click', (e) => { if (e.target === D.lightbox) closeLightbox(); });
  }

  function bindChrome() {
    const badge = D.privacyBadge, pop = D.privacyPop;
    const togglePop = (force) => {
      const show = force === undefined ? pop.hidden : force;
      pop.hidden = !show;
      badge.setAttribute('aria-expanded', show ? 'true' : 'false');
    };
    badge.addEventListener('click', () => togglePop());
    badge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePop(); } });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !badge.contains(e.target)) togglePop(false); });

    applyTheme(currentTheme(), false);
    if (!VF.sfx || !VF.sfx.supported) D.soundBtn.hidden = true;
    else {
      syncSoundBtn();
      D.soundBtn.addEventListener('click', () => { VF.sfx.toggle(); syncSoundBtn(); });
    }
    D.themeBtn.addEventListener('click', () => toggleTheme());

    // browsers only start audio after a gesture
    const unlock = () => { if (VF.sfx) VF.sfx.unlock(); };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { togglePop(false); closeLightbox(); closeAbout(); }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (aboutOpen()) return;
      switch (e.key) {
        case '1': switchTab('gif'); break;
        case '2': switchTab('frames'); break;
        case ' ':
          // a focused button owns Space (activate it), the page owns it otherwise
          if (state.media && !e.target.closest('button, a, [role="button"]')) { e.preventDefault(); player && player.toggle(); }
          break;
        case 'e': case 'E':
          if (state.media) { e.preventDefault(); state.tab === 'gif' ? runEncode() : runExtract(); }
          break;
        case 'd': case 'D':
          if (state.result.blob) { e.preventDefault(); saveBlob(state.result.blob, outputName('gif')); pulse(D.downloadBtn); }
          break;
        case 'c': case 'C':
          if (state.result.blob) { e.preventDefault(); copyResult(); }
          break;
        case 't': case 'T': toggleTheme(); break;
        case 'm': case 'M':
          if (VF.sfx && VF.sfx.supported) { VF.sfx.toggle(); syncSoundBtn(); }
          break;
        case '?': openAbout(); break;
        case 'ArrowLeft':
          if (state.lbIndex >= 0) { e.preventDefault(); stepLightbox(-1); }
          break;
        case 'ArrowRight':
          if (state.lbIndex >= 0) { e.preventDefault(); stepLightbox(1); }
          break;
      }
    });

    D.aboutBtn.addEventListener('click', openAbout);
  }

  /* ----------------------------------------------------------------- theme */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme, announce) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage blocked */ }
    const light = theme === 'light';
    D.themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    D.themeBtn.title = (light ? 'Dark theme' : 'Light theme') + ' (T)';
    if (announce) sfx(light ? 'light' : 'dark');
  }

  function toggleTheme() { applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true); }

  function syncSoundBtn() {
    const on = !!(VF.sfx && VF.sfx.enabled);
    D.soundBtn.classList.toggle('is-off', !on);
    D.soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    D.soundBtn.setAttribute('aria-label', on ? 'Mute interface sounds' : 'Unmute interface sounds');
    D.soundBtn.title = (on ? 'Sounds on' : 'Sounds muted') + ' (M)';
  }

  /* ----------------------------------------------------------------- about */

  const aboutOpen = () => D.aboutModal.open || D.aboutModal.hasAttribute('open');

  function openAbout() {
    if (typeof D.aboutModal.showModal === 'function' && !aboutOpen()) D.aboutModal.showModal();
    else D.aboutModal.setAttribute('open', '');
    sfx('tap');
  }

  function closeAbout() {
    if (!aboutOpen()) return;
    if (typeof D.aboutModal.close === 'function') D.aboutModal.close();
    else D.aboutModal.removeAttribute('open');
  }

  function isTyping(node) {
    return node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
  }

  function outputName(ext) {
    const base = state.media ? sanitizeFilename(state.media.file.name, 'gif') : 'gif';
    return base + '_' + Date.now().toString(36) + '.' + ext;
  }

  function pulse(node) {
    node.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(.97)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'ease-out' }
    );
  }

  /* ----------------------------------------------------------- progress UI */

  function makeProgress(block, bar, label, pct) {
    return {
      show(text) { block.hidden = false; bar.classList.remove('is-indeterminate'); this.set(0, text); },
      set(f, text) {
        bar.style.width = clamp(f * 100, 0, 100).toFixed(1) + '%';
        pct.textContent = Math.round(clamp(f, 0, 1) * 100) + '%';
        if (text) label.textContent = text;
      },
      indeterminate(text) { block.hidden = false; bar.classList.add('is-indeterminate'); if (text) label.textContent = text; },
      hide() { block.hidden = true; bar.classList.remove('is-indeterminate'); bar.style.width = '0%'; }
    };
  }

  function setBusy(on) {
    state.busy = on;
    document.body.classList.toggle('is-busy-cursor', on);
    D.encodeBtn.disabled = on || !state.media;
    D.extractBtn.disabled = on || !state.media;
    D.batchBtn.disabled = on || !state.media;
    D.frameBatchBtn.disabled = on || !state.media;
    D.cancelBtn.hidden = !on || state.tab !== 'gif';
    D.frameCancelBtn.hidden = !on || state.tab !== 'frames';
    D.downloadBtn.disabled = on;
    D.zipBtn.disabled = on || !state.frames.some((f) => f.selected);
  }

  /* ----------------------------------------------------------- GIF encode */

  async function runEncode() {
    if (!state.media || state.busy) return;
    const base = readSettings();
    const span = base.range.end - base.range.start;
    if (span < 0.05) return toast('The trim range is too short — drag the handles apart.', { type: 'warn' });

    const s = effectiveSettings(state.media, base);
    if (s.auto === 'unsolvable') {
      return toast('Nothing fits under ' + base.targetMB + ' MB for this clip. Shorten the range or clear the budget.', {
        type: 'error', title: 'Budget unreachable', duration: 9000
      });
    }
    if (s.auto) {
      toast('Tuned to ' + s.auto.fps + ' fps · ' + s.auto.width + 'px wide · quality ' + s.auto.quality + ' to fit ' + base.targetMB + ' MB.', {
        type: 'info', title: 'Auto-fitted to budget', duration: 5200
      });
    }

    const out = VF.render.computeOutput(state.media.width, state.media.height, s.rotation, s.width, s.height, s.lockAspect);
    const frameCount = VF.pipeline.planGif(state.media, s).length;
    const budget = VF.pipeline.checkBudget(out.outW, out.outH, frameCount);
    if (!budget.ok) return toast(budget.reason, { type: 'error', title: 'Too large to encode', duration: 9000 });
    if (budget.warn) toast(budget.warn, { type: 'warn', duration: 7000 });

    const prog = makeProgress(D.progressBlock, D.progressBar, D.progressLabel, D.progressPct);
    const token = new CancelToken();
    state.token = token;
    setBusy(true);
    sfx('start');
    player && player.pause();
    prog.indeterminate('Starting encoder…');
    clearResult();

    let lastUi = 0;
    try {
      const res = await VF.pipeline.encodeGif(state.media, s, {
        token,
        onWarn: (msg) => toast(msg, { type: 'warn', duration: 7000 }),
        onProgress: (f, text) => {
          const now = performance.now();
          if (now - lastUi > 70 || f >= 1) { lastUi = now; prog.set(f, text); }
        }
      });

      const url = makeUrl(res.blob);
      state.result = { blob: res.blob, url };
      D.resultImg.src = url;
      D.resultImg.hidden = false;
      D.resultEmpty.hidden = true;
      D.resultActions.hidden = false;
      D.resultMeta.textContent = res.width + ' × ' + res.height + ' · ' + res.frames + ' frames · ' +
        formatBytes(res.blob.size) + ' · encoded in ' + res.elapsed.toFixed(1) + 's';
      prog.set(1, 'Done');
      pulse(D.downloadBtn);
      toast('GIF ready — ' + formatBytes(res.blob.size) + ', ' + res.frames + ' frames.', { type: 'success', title: 'Encoding complete' });
    } catch (err) {
      if (err && err.cancelled) { sfx('cancel'); toast('Encoding cancelled.', { type: 'info', duration: 2600 }); }
      else toast(err.message || String(err), { type: 'error', title: 'Encoding failed', duration: 9000 });
    } finally {
      state.token = null;
      setBusy(false);
      setTimeout(() => prog.hide(), 900);
      schedulePreview(true);
    }
  }

  function clearResult() {
    if (state.result.url) releaseUrl(state.result.url);
    state.result = { blob: null, url: null };
    D.resultImg.removeAttribute('src');
    D.resultImg.hidden = true;
    D.resultEmpty.hidden = false;
    D.resultActions.hidden = true;
    D.resultMeta.textContent = '';
    D.downloadBtn.disabled = true;
  }

  async function copyResult() {
    const blob = state.result.blob;
    if (!blob || !global.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      return toast('Copying a GIF to the clipboard is not supported in this browser.', { type: 'warn' });
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/gif': blob })]);
      toast('GIF copied to the clipboard.', { type: 'success', duration: 2600 });
    } catch (e) {
      toast('The clipboard rejected the GIF (' + (e.name || 'error') + ').', { type: 'error' });
    }
  }

  /* ------------------------------------------------------- frame extraction */

  async function runExtract() {
    if (!state.media || state.busy) return;
    const s = readSettings();
    if (s.range.end - s.range.start < 0.02) return toast('The trim range is too short.', { type: 'warn' });

    const probe = VF.media.planSamples(state.media, s.mode, s.value, s.range);
    if (!probe.length) return toast('No frames fall inside the selected range.', { type: 'warn' });
    if (probe.length > 3000) return toast('That would extract ' + probe.length + ' frames. Narrow the range or sample less often.', { type: 'error', title: 'Too many frames', duration: 8000 });

    const prog = makeProgress(D.frameProgressBlock, D.frameProgressBar, D.frameProgressLabel, D.frameProgressPct);
    const token = new CancelToken();
    state.token = token;
    setBusy(true);
    sfx('start');
    player && player.pause();
    clearFrames();
    prog.show('Starting extraction…');

    let lastUi = 0;
    try {
      const frames = await VF.pipeline.extractFrames(state.media, s, {
        token,
        onProgress: (f, text) => {
          const now = performance.now();
          if (now - lastUi > 70 || f >= 1) { lastUi = now; prog.set(f, text); }
        },
        onFrame: null
      });
      state.frames = frames;
      renderFrames(frames);
      prog.set(1, 'Extracted ' + frames.length + ' frames');
      toast(frames.length + ' frames extracted. Untick any you do not need, then download the ZIP.', { type: 'success', title: 'Extraction complete', duration: 6000 });
    } catch (err) {
      if (err && err.cancelled) {
        sfx('cancel');
        toast('Extraction cancelled — kept ' + state.frames.length + ' frames.', { type: 'info', duration: 3200 });
        renderFrames(state.frames);
      } else {
        toast(err.message || String(err), { type: 'error', title: 'Extraction failed', duration: 9000 });
      }
    } finally {
      state.token = null;
      setBusy(false);
      updateFrameCounts();
      setTimeout(() => prog.hide(), 900);
      schedulePreview(true);
    }
  }

  function clearFrames() {
    VF.pipeline.releaseFrames(state.frames);
    state.frames = [];
    state.lastPicked = -1;
    state.lbIndex = -1;
    D.frameGrid.innerHTML = '';
    D.frameGrid.appendChild(D.frameEmpty);
    D.frameEmpty.hidden = false;
    D.zipMeta.textContent = '';
    D.zipBtn.disabled = true;
    updateFrameCounts();
  }

  function renderFrames(frames) {
    state.lastPicked = -1;
    D.frameGrid.innerHTML = '';
    D.frameEmpty.hidden = frames.length > 0;
    if (frames.length) D.frameGrid.appendChild(D.frameEmpty);

    const frag = document.createDocumentFragment();
    frames.forEach((f, i) => frag.appendChild(buildTile(f, i)));
    D.frameGrid.appendChild(frag);
    updateFrameCounts();
  }

  function buildTile(f, i) {
    const tile = el('label', { class: 'frame-tile' + (f.selected ? ' is-selected' : ''), style: 'animation-delay:' + Math.min(i * 8, 400) + 'ms' });
    f._tile = tile;
    const input = el('input', { type: 'checkbox', 'aria-label': 'Keep frame ' + (i + 1) });
    input.checked = !!f.selected;
    input.addEventListener('change', () => {
      setFrameSelected(f, input.checked);
      state.lastPicked = i;
      sfx(input.checked ? 'pick' : 'unpick');
    });
    // Shift+click spreads this click's intent across everything since the last pick
    input.addEventListener('click', (e) => {
      if (!e.shiftKey || state.lastPicked < 0 || state.lastPicked === i) return;
      e.preventDefault();
      const on = !f.selected;
      const lo = Math.min(state.lastPicked, i);
      const hi = Math.max(state.lastPicked, i);
      for (let n = lo; n <= hi; n++) { state.frames[n].selected = on; paintTile(state.frames[n]); }
      updateFrameCounts();
      sfx(on ? 'pick' : 'unpick');
    });

    tile.appendChild(input);
    tile.appendChild(el('span', {
      class: 'ft-check',
      html: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
    }));
    tile.appendChild(el('img', { src: f.url, alt: 'Frame ' + (i + 1), loading: 'lazy', decoding: 'async' }));

    const zoom = el('button', { class: 'ft-zoom', type: 'button', 'aria-label': 'Enlarge frame ' + (i + 1), html: '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14zM9 8h1v3H9zm0 0"/></svg>' });
    zoom.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openLightbox(f, i);
    });
    tile.appendChild(zoom);

    tile.appendChild(el('div', { class: 'ft-meta' }, [
      el('b', { text: '#' + String(i + 1).padStart(3, '0') }),
      el('span', { text: formatTime(f.time) })
    ]));
    return tile;
  }

  function paintTile(f) {
    const tile = f._tile;
    if (!tile) return;
    tile.classList.toggle('is-selected', !!f.selected);
    const cb = $('input', tile);
    if (cb) cb.checked = !!f.selected;
  }

  function setFrameSelected(f, on) {
    f.selected = !!on;
    paintTile(f);
    updateFrameCounts();
  }

  function setAllFrames(on) {
    state.frames.forEach((f) => { f.selected = on; paintTile(f); });
    state.lastPicked = -1;
    updateFrameCounts();
  }

  function updateFrameCounts() {
    const sel = state.frames.filter((f) => f.selected).length;
    D.selCount.textContent = String(sel);
    D.totalCount.textContent = String(state.frames.length);
    D.zipBtn.disabled = !sel || state.busy;
    const has = state.frames.length > 0;
    D.selectAll.disabled = !has; D.selectNone.disabled = !has; D.selectInvert.disabled = !has;
    if (has) {
      const bytes = state.frames.filter((f) => f.selected).reduce((a, f) => a + f.size, 0);
      D.zipMeta.textContent = sel + ' selected · ' + formatBytes(bytes) + ' uncompressed';
    } else {
      D.zipMeta.textContent = '';
    }
  }

  async function downloadFramesZip() {
    const picked = state.frames.filter((f) => f.selected);
    if (!picked.length) return toast('Select at least one frame.', { type: 'warn' });

    const prog = makeProgress(D.frameProgressBlock, D.frameProgressBar, D.frameProgressLabel, D.frameProgressPct);
    setBusy(true);
    prog.show('Building archive…');
    try {
      const name = state.media ? sanitizeFilename(state.media.file.name, 'frames') : 'frames';
      const blob = await VF.pipeline.buildZip(
        VF.pipeline.frameEntries(picked, null, name + '/frame'),
        { onProgress: (f, t) => prog.set(f, t) }
      );
      saveBlob(blob, name + '_frames.zip');
      prog.set(1, 'Saved');
      pulse(D.zipBtn);
      toast(picked.length + ' frames zipped (' + formatBytes(blob.size) + ').', { type: 'success', title: 'Download started' });
    } catch (err) {
      toast(err.message || String(err), { type: 'error', title: 'ZIP failed' });
    } finally {
      setBusy(false);
      updateFrameCounts();
      setTimeout(() => prog.hide(), 800);
    }
  }

  function openLightbox(f, i) {
    state.lbIndex = i;
    paintLightbox();
    D.lightbox.hidden = false;
    sfx('tap');
  }

  function paintLightbox() {
    const f = state.frames[state.lbIndex];
    if (!f) return;
    D.lbImg.src = f.url;
    D.lbCaption.textContent = 'Frame #' + (state.lbIndex + 1) + ' of ' + state.frames.length + ' · ' +
      formatTime(f.time) + ' · ' + f.width + '×' + f.height + ' · ' + formatBytes(f.size);
    D.lbPrev.disabled = state.lbIndex <= 0;
    D.lbNext.disabled = state.lbIndex >= state.frames.length - 1;
  }

  function stepLightbox(d) {
    if (state.lbIndex < 0) return;
    const next = clamp(state.lbIndex + d, 0, state.frames.length - 1);
    if (next === state.lbIndex) return;
    state.lbIndex = next;
    paintLightbox();
    sfx('pick');
  }

  function closeLightbox() {
    D.lightbox.hidden = true;
    D.lbImg.removeAttribute('src');
    state.lbIndex = -1;
  }

  /* ----------------------------------------------------------------- batch */

  async function withEachQueuedFile(prog, fn) {
    const items = state.queue.slice();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const wasActive = item.id === state.activeId;
      prog.set(i / items.length, 'File ' + (i + 1) + ' of ' + items.length + ' — ' + item.file.name);
      let media = state.media;
      let opened = false;
      if (!wasActive || !media) {
        media = await VF.media.open(item.file);
        opened = true;
      }
      item.status = 'busy';
      renderQueue();
      try {
        const base = readSettings();
        base.range = { start: 0, end: media.duration };   // batch always uses the full clip
        const s = effectiveSettings(media, base);
        if (s.auto === 'unsolvable') throw new Error('nothing fits under ' + base.targetMB + ' MB');
        out.push(await fn(media, s, item, (f, label) => prog.set((i + f) / items.length, label)));
        item.status = 'done';
      } catch (err) {
        item.status = 'error';
        if (err && err.cancelled) throw err;
        toast(item.file.name + ': ' + (err.message || err), { type: 'error', title: 'Skipped', duration: 6000 });
      } finally {
        if (opened) media.destroy();
        renderQueue();
      }
    }
    return out;
  }

  async function runBatchGif() {
    if (!state.queue.length || state.busy) return;
    const prog = makeProgress(D.progressBlock, D.progressBar, D.progressLabel, D.progressPct);
    const token = new CancelToken();
    state.token = token;
    setBusy(true);
    sfx('start');
    player && player.pause();
    prog.show('Preparing batch…');
    try {
      const results = await withEachQueuedFile(prog, async (media, s, item, onP) => {
        token.throwIfCancelled();
        return VF.pipeline.encodeGif(media, s, {
          token,
          onProgress: (f, label) => onP(f, label),
          onWarn: () => {}
        }).then((r) => ({ name: sanitizeFilename(item.file.name, 'gif') + '.gif', blob: r.blob }));
      });
      if (!results.length) throw new Error('No files could be converted.');
      prog.indeterminate('Zipping results…');
      const blob = await VF.pipeline.buildZip(results.map((r) => ({ name: r.name, blob: r.blob })));
      saveBlob(blob, 'gifs_' + Date.now().toString(36) + '.zip');
      prog.set(1, 'Done');
      toast(results.length + ' GIF(s) exported (' + formatBytes(blob.size) + ').', { type: 'success', title: 'Batch complete' });
    } catch (err) {
      if (err && err.cancelled) { sfx('cancel'); toast('Batch cancelled.', { type: 'info', duration: 2600 }); }
      else toast(err.message || String(err), { type: 'error', title: 'Batch failed', duration: 8000 });
    } finally {
      state.token = null;
      setBusy(false);
      setTimeout(() => prog.hide(), 900);
      schedulePreview(true);
    }
  }

  async function runBatchFrames() {
    if (!state.queue.length || state.busy) return;
    const prog = makeProgress(D.frameProgressBlock, D.frameProgressBar, D.frameProgressLabel, D.frameProgressPct);
    const token = new CancelToken();
    state.token = token;
    setBusy(true);
    sfx('start');
    player && player.pause();
    prog.show('Preparing batch…');
    try {
      const results = await withEachQueuedFile(prog, async (media, s, item, onP) => {
        token.throwIfCancelled();
        const frames = await VF.pipeline.extractFrames(media, s, { token, onProgress: (f, label) => onP(f, label) });
        return { name: sanitizeFilename(item.file.name, 'frames'), frames };
      });
      if (!results.length) throw new Error('No files could be processed.');

      const entries = [];
      results.forEach((r) => {
        VF.pipeline.frameEntries(r.frames, r.name, 'frame').forEach((e) => entries.push(e));
      });
      prog.indeterminate('Zipping ' + entries.length + ' frames…');
      const blob = await VF.pipeline.buildZip(entries);
      results.forEach((r) => VF.pipeline.releaseFrames(r.frames));
      saveBlob(blob, 'frames_' + Date.now().toString(36) + '.zip');
      prog.set(1, 'Done');
      toast(entries.length + ' frames exported from ' + results.length + ' file(s).', { type: 'success', title: 'Batch complete' });
    } catch (err) {
      if (err && err.cancelled) { sfx('cancel'); toast('Batch cancelled.', { type: 'info', duration: 2600 }); }
      else toast(err.message || String(err), { type: 'error', title: 'Batch failed', duration: 8000 });
    } finally {
      state.token = null;
      setBusy(false);
      setTimeout(() => prog.hide(), 900);
      schedulePreview(true);
    }
  }

  /* ------------------------------------------------------------------- go */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.GifForge = { state, readSettings, open: addFiles };
})(window);

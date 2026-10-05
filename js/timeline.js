/* ==========================================================================
   timeline.js — dual-handle trimmer with thumbnail strip + playhead
   ========================================================================== */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const { $, clamp, formatTime } = VF;

  const MIN_GAP = 0.05; // seconds

  function createTimeline(root, handlers) {
    const track = $('#timeline', root);
    const rangeEl = $('#tl-range', root);
    const playhead = $('#tl-playhead', root);
    const hStart = $('#tl-start', root);
    const hEnd = $('#tl-end', root);
    const thumbs = $('#tl-thumbs', root);
    const inStart = $('#t-start', root);
    const inEnd = $('#t-end', root);
    const inLen = $('#t-len', root);
    const btnReset = $('#reset-range', root);

    let duration = 0;
    let start = 0;
    let end = 0;
    let time = 0;
    let dragging = null;
    let suppressCallbacks = false;

    const pct = (t) => (duration > 0 ? clamp((t / duration) * 100, 0, 100) : 0);
    const timeAt = (clientX) => {
      const r = track.getBoundingClientRect();
      if (!r.width) return 0;
      return clamp(((clientX - r.left) / r.width) * duration, 0, duration);
    };

    function paint() {
      const sp = pct(start);
      const ep = pct(end);
      hStart.style.left = sp + '%';
      hEnd.style.left = ep + '%';
      rangeEl.style.left = sp + '%';
      rangeEl.style.width = Math.max(0, ep - sp) + '%';
      paintPlayhead();
      track.style.setProperty('--dim-l', sp + '%');
      track.style.setProperty('--dim-r', (100 - ep) + '%');

      hStart.setAttribute('aria-valuetext', formatTime(start));
      hEnd.setAttribute('aria-valuetext', formatTime(end));

      if (document.activeElement !== inStart) inStart.value = start.toFixed(2);
      if (document.activeElement !== inEnd) inEnd.value = end.toFixed(2);
      inLen.value = formatTime(Math.max(0, end - start));
      inStart.max = Math.max(0, duration - MIN_GAP).toFixed(2);
      inEnd.max = duration.toFixed(2);
    }

    function paintPlayhead() {
      playhead.style.left = pct(time) + '%';
    }

    function emitRange() {
      if (suppressCallbacks) return;
      if (handlers.onRange) handlers.onRange({ start, end });
    }
    function emitScrub(isFinal) {
      if (suppressCallbacks) return;
      if (handlers.onScrub) handlers.onScrub(time, isFinal);
    }

    function setStart(v, fromUser) {
      start = clamp(v, 0, Math.max(0, end - MIN_GAP));
      if (time < start) time = start;
      paint();
      emitRange();
      if (fromUser) emitScrub(true);
    }
    function setEnd(v, fromUser) {
      end = clamp(v, Math.min(duration, start + MIN_GAP), duration);
      if (time > end) time = end;
      paint();
      emitRange();
      if (fromUser) emitScrub(true);
    }
    function setTime(v, fromUser) {
      time = clamp(v, 0, duration || 0);
      paint();
      if (fromUser) emitScrub(true);
    }
    function resetRange() {
      start = 0;
      end = duration;
      time = clamp(time, 0, end);
      paint();
      emitRange();
      emitScrub(true);
    }

    /* ---------- pointer dragging ---------- */
    function beginDrag(which, ev) {
      dragging = which;
      track.setPointerCapture && ev.pointerId != null && track.setPointerCapture(ev.pointerId);
      const node = which === 'start' ? hStart : which === 'end' ? hEnd : null;
      if (node) node.classList.add('is-drag');
      if (handlers.onDragStart) handlers.onDragStart();
      ev.preventDefault();
      ev.stopPropagation();
    }

    function onPointerMove(ev) {
      if (!dragging) return;
      const t = timeAt(ev.clientX);
      if (dragging === 'start') setStart(Math.min(t, end - MIN_GAP), false);
      else if (dragging === 'end') setEnd(Math.max(t, start + MIN_GAP), false);
      else setTime(t, false);
      emitScrub(false);
    }

    function onPointerUp(ev) {
      if (!dragging) return;
      const was = dragging;
      dragging = null;
      hStart.classList.remove('is-drag');
      hEnd.classList.remove('is-drag');
      try { track.releasePointerCapture && ev.pointerId != null && track.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      if (handlers.onDragEnd) handlers.onDragEnd(was);
      emitScrub(true);
    }

    hStart.addEventListener('pointerdown', (e) => beginDrag('start', e));
    hEnd.addEventListener('pointerdown', (e) => beginDrag('end', e));

    track.addEventListener('pointerdown', (e) => {
      if (e.target === hStart || e.target === hEnd) return;
      if (!duration) return;
      beginDrag('playhead', e);
      const t = timeAt(e.clientX);
      // clicking near an edge grabs that handle instead
      const r = track.getBoundingClientRect();
      const pxStart = (start / duration) * r.width;
      const pxEnd = (end / duration) * r.width;
      const px = e.clientX - r.left;
      if (Math.abs(px - pxStart) < 14) { dragging = 'start'; setStart(t, false); }
      else if (Math.abs(px - pxEnd) < 14) { dragging = 'end'; setEnd(t, false); }
      else setTime(t, true);
    });

    global.addEventListener('pointermove', onPointerMove, { passive: false });
    global.addEventListener('pointerup', onPointerUp);
    global.addEventListener('pointercancel', onPointerUp);

    /* ---------- keyboard ---------- */
    function keyStep(e) {
      const big = e.shiftKey ? 1 : 0.05;
      switch (e.key) {
        case 'ArrowLeft': return -big;
        case 'ArrowRight': return big;
        case 'PageDown': return -1;
        case 'PageUp': return 1;
        default: return 0;
      }
    }
    hStart.addEventListener('keydown', (e) => {
      if (e.key === 'Home') { setStart(0, true); e.preventDefault(); return; }
      const d = keyStep(e);
      if (d) { setStart(start + d, true); e.preventDefault(); }
    });
    hEnd.addEventListener('keydown', (e) => {
      if (e.key === 'End') { setEnd(duration, true); e.preventDefault(); return; }
      const d = keyStep(e);
      if (d) { setEnd(end + d, true); e.preventDefault(); }
    });

    /* ---------- numeric inputs ---------- */
    inStart.addEventListener('change', () => {
      const v = parseFloat(inStart.value);
      if (isFinite(v)) setStart(v, true); else paint();
    });
    inEnd.addEventListener('change', () => {
      const v = parseFloat(inEnd.value);
      if (isFinite(v)) setEnd(v, true); else paint();
    });

    if (btnReset) btnReset.addEventListener('click', () => { if (duration) resetRange(); });

    /* ---------- thumbnails ---------- */
    function setThumbs(strip) {
      if (!strip) return;
      thumbs.width = strip.width;
      thumbs.height = strip.height;
      const ctx = thumbs.getContext('2d');
      ctx.clearRect(0, 0, thumbs.width, thumbs.height);
      ctx.drawImage(strip, 0, 0, thumbs.width, thumbs.height);
    }

    return {
      get track() { return track; },
      load(dur) {
        suppressCallbacks = true;
        duration = Math.max(0.01, dur || 0);
        start = 0;
        end = duration;
        time = 0;
        suppressCallbacks = false;
        paint();
      },
      setRange(s, e) {
        suppressCallbacks = true;
        start = clamp(s, 0, duration);
        end = clamp(e, start + MIN_GAP, duration);
        suppressCallbacks = false;
        paint();
      },
      resetRange,
      getRange() { return { start, end }; },
      setTimeOnly(v) { time = clamp(v, 0, duration || 0); paintPlayhead(); },
      setTime,
      setStart,
      setEnd,
      setThumbs,
      get duration() { return duration; },
      destroy() {
        global.removeEventListener('pointermove', onPointerMove);
        global.removeEventListener('pointerup', onPointerUp);
        global.removeEventListener('pointercancel', onPointerUp);
      }
    };
  }

  VF.createTimeline = createTimeline;
})(window);

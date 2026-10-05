/* ==========================================================================
   pipeline.js — GIF encoding (gif.js + Web Workers), frame extraction, zipping
   ========================================================================== */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const { clamp, makeUrl, releaseUrl, canvasToBlob, libs, CancelledError } = VF;

  const GIF_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js';

  /* Memory ceiling for buffered raw frames (gif.js holds every frame as RGBA). */
  const MEMORY_WARN = 320 * 1024 * 1024;
  const MEMORY_HARD = 760 * 1024 * 1024;
  const MAX_FRAMES = 1200;

  /* --------------------------------------------------------- worker script */

  let workerScriptUrl = null;
  let workerScriptPromise = null;

  /**
   * gif.js spawns workers from `workerScript`. A cross-origin URL is rejected
   * by the browser, so we hand it a same-origin Blob instead. Fetching works
   * over http(s); from file:// we fall back to importScripts(), which is not
   * subject to CORS inside a worker.
   */
  function getWorkerScript() {
    if (workerScriptUrl) return Promise.resolve(workerScriptUrl);
    if (workerScriptPromise) return workerScriptPromise;

    workerScriptPromise = (async () => {
      try {
        const res = await fetch(GIF_WORKER_CDN, { mode: 'cors' });
        if (res.ok) {
          const text = await res.text();
          if (text.length > 2000) {
            workerScriptUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
            return workerScriptUrl;
          }
        }
      } catch (e) { /* expected on file:// — use the importScripts shim below */ }

      const shim = 'importScripts(' + JSON.stringify(GIF_WORKER_CDN) + ');';
      workerScriptUrl = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
      return workerScriptUrl;
    })();

    return workerScriptPromise;
  }

  function killGif(gif) {
    try {
      if (typeof gif.abort === 'function') gif.abort();
    } catch (e) { /* noop */ }
    try {
      if (typeof gif.terminateWorkers === 'function') { gif.terminateWorkers(); return; }
      const pool = (gif.freeWorkers || []).concat(gif.activeWorkers || []);
      pool.forEach((w) => { try { w.terminate(); } catch (e) { /* noop */ } });
    } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------ sampling */

  /** Times to sample for a GIF encode, honouring the source's own cadence. */
  function sampleTimes(media, range, fps) {
    const start = range.start;
    const end = Math.max(range.end, start + 0.001);

    if (media.kind === 'gif' && media.frameTimes) {
      const minGap = (1 / fps) * 0.82;
      const out = [];
      let last = -Infinity;
      for (const t of media.frameTimes) {
        if (t < start - 1e-6 || t > end + 1e-6) continue;
        if (!out.length || t - last >= minGap) { out.push(t); last = t; }
      }
      if (!out.length) out.push(start);
      return out;
    }

    const step = 1 / fps;
    const out = [];
    for (let t = start; t <= end + 1e-9; t += step) out.push(Math.min(t, end));
    if (!out.length) out.push(start);
    return out;
  }

  /** The exact frame times an encode will use, direction included. */
  function planGif(media, settings) {
    return orderTimes(sampleTimes(media, settings.range, settings.fps), settings.loopMode);
  }

  /** Reorder sample times for the chosen playback direction. */
  function orderTimes(times, mode) {
    if (!times) return [];
    if (times.length < 2 || mode === 'forward' || !mode) return times;
    if (mode === 'reverse') return times.slice().reverse();
    if (mode === 'boomerang') return times.concat(times.slice(1, -1).reverse());
    return times;
  }

  /** Per-frame GIF delays in ms, aligned to the format's 10ms granularity. */
  function frameDelays(times, fps, speed) {
    const rate = clamp(fps * (speed || 1), 0.5, 120);
    const uniform = clamp(Math.round(1000 / rate / 10) * 10, 20, 60000);
    if (times.length < 2) return [uniform];
    const out = [];
    for (let i = 0; i < times.length - 1; i++) {
      // abs(): reverse and boomerang walk the list backwards, so diffs go negative
      const d = Math.round(Math.abs(times[i + 1] - times[i]) * 1000 / (speed || 1) / 10) * 10;
      out.push(clamp(d, 20, 60000));
    }
    out.push(uniform);
    return out;
  }

  /* ------------------------------------------------------- size estimates */

  function estimateGifBytes(outW, outH, frames, quality, dither) {
    const px = outW * outH;
    let bpp = 0.58 - (quality / 100) * 0.27;             // ~0.31 – 0.58 B/px/frame
    if (dither && dither !== 'none') bpp *= 1.34;
    bpp *= px < 40000 ? 1.25 : px > 400000 ? 0.88 : 1;  // small frames waste palette
    return px * frames * bpp;
  }

  function checkBudget(outW, outH, frames) {
    const bytes = frames * outW * outH * 4;
    if (frames > MAX_FRAMES) {
      return { ok: false, bytes, reason: 'That is ' + frames + ' frames — the cap is ' + MAX_FRAMES + '. Lower the FPS or shorten the clip.' };
    }
    if (bytes > MEMORY_HARD) {
      return {
        ok: false, bytes,
        reason: 'This needs about ' + VF.formatBytes(bytes, 0) + ' of raw frame memory and will likely crash the tab. Reduce the width, the FPS or the clip length.'
      };
    }
    if (bytes > MEMORY_WARN) {
      return { ok: true, warn: 'This will buffer roughly ' + VF.formatBytes(bytes, 0) + ' of frame data. Encoding may be slow.', bytes };
    }
    return { ok: true, bytes };
  }

  function qualityToGifJs(q) { return clamp(Math.round(21 - (q / 100) * 20), 1, 30); }

  /**
   * Walk fps → width → quality down until the estimate fits `maxBytes`.
   * Frame rate is the outer loop because smooth motion is what people notice
   * first in a GIF; resolution gives way before the cadence does.
   */
  function solveBudget(srcW, srcH, settings, maxBytes) {
    const span = Math.max(0.05, settings.range.end - settings.range.start);
    const mult = settings.loopMode === 'boomerang' ? 2 : 1;

    const ladder = (top, steps, floor) => {
      const list = [top].concat(steps).filter((v) => v <= top && v >= floor);
      return list.filter((v, i) => list.indexOf(v) === i);
    };
    const fpsList = ladder(settings.fps, [20, 15, 12, 10, 8, 6, 5], 5);
    const widthList = ladder(settings.width, [720, 640, 560, 480, 420, 360, 320, 280, 240], 120);
    const qualityList = ladder(settings.quality, [80, 72, 60, 48, 36, 26, 18], 10);

    for (const fps of fpsList) {
      const frames = Math.min(Math.max(1, Math.round(span * fps) + 1) * mult, MAX_FRAMES);
      for (const width of widthList) {
        const out = VF.render.computeOutput(srcW, srcH, settings.rotation || 0, width, settings.height, true);
        if (!checkBudget(out.outW, out.outH, frames).ok) continue;
        for (const quality of qualityList) {
          const est = estimateGifBytes(out.outW, out.outH, frames, quality, settings.dither);
          if (est <= maxBytes) return { fps, width: out.outW, height: out.outH, quality, frames, est };
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ encoding */

  function renderOpts(out, settings) {
    return {
      outW: out.outW,
      outH: out.outH,
      dW: out.dW,
      dH: out.dH,
      rotation: settings.rotation || 0,
      adjust: settings.adjust,
      overlay: settings.overlay
    };
  }

  /**
   * Encode a GIF. hooks: { onProgress(fraction, label), token }
   * Resolves with { blob, frames, width, height, elapsed }.
   */
  async function encodeGif(media, settings, hooks) {
    const L = libs();
    if (!L.gifEncoder) {
      throw new Error('The GIF encoder (gif.js) is not loaded. Check your connection and reload the page.');
    }
    hooks = hooks || {};
    const token = hooks.token || new VF.CancelToken();
    const onProgress = hooks.onProgress || function () {};

    const out = VF.render.computeOutput(
      media.width, media.height, settings.rotation || 0,
      settings.width, settings.height, settings.lockAspect !== false
    );
    const speed = clamp(+settings.speed || 1, 0.25, 4);
    const times = orderTimes(sampleTimes(media, settings.range, settings.fps), settings.loopMode);
    const budget = checkBudget(out.outW, out.outH, times.length);
    if (!budget.ok) throw new Error(budget.reason);
    if (budget.warn && hooks.onWarn) hooks.onWarn(budget.warn);

    const delays = frameDelays(times, settings.fps, speed);

    const workerScript = await getWorkerScript();
    token.throwIfCancelled();

    const workerCount = clamp((navigator.hardwareConcurrency || 4) - 1, 1, 6);
    const gif = new L.gifEncoder({
      workers: workerCount,
      quality: qualityToGifJs(settings.quality),
      width: out.outW,
      height: out.outH,
      workerScript: workerScript,
      dither: settings.dither === 'none' ? false : settings.dither,
      repeat: settings.loop === false ? -1 : 0,
      background: '#ffffff',
      transparent: null
    });

    const canvas = document.createElement('canvas');
    const opts = renderOpts(out, settings);
    const started = performance.now();

    // ---- capture phase (0 → 0.55) ----
    for (let i = 0; i < times.length; i++) {
      token.throwIfCancelled();
      await media.seek(times[i]);
      VF.render.renderFrame(media.drawable, canvas, opts);
      gif.addFrame(canvas, { copy: true, delay: delays[i] || delays[0] });
      onProgress(((i + 1) / times.length) * 0.55, 'Capturing frame ' + (i + 1) + ' of ' + times.length);
    }

    // ---- encode phase (0.55 → 1) ----
    const blob = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      gif.on('progress', (p) => onProgress(0.55 + clamp(p, 0, 1) * 0.45, 'Encoding GIF…'));
      gif.on('finished', (b) => done(resolve, b));
      gif.on('abort', () => done(reject, new CancelledError()));
      token.onCancel(() => done(reject, new CancelledError()));

      try { gif.render(); } catch (e) { done(reject, e); }
    }).catch((err) => { killGif(gif); throw err; });

    killGif(gif);

    if (!blob) throw new Error('The encoder returned no data.');
    return {
      blob,
      frames: times.length,
      width: out.outW,
      height: out.outH,
      fps: Math.round(settings.fps * speed),
      elapsed: (performance.now() - started) / 1000
    };
  }

  /* ---------------------------------------------------- frame extraction */

  function nativeOutput(srcW, srcH, rotation) {
    const swapped = rotation % 180 !== 0;
    const outW = swapped ? srcH : srcW;
    const outH = swapped ? srcW : srcH;
    return { outW, outH, dW: swapped ? outH : outW, dH: swapped ? outW : outH };
  }

  /**
   * Extract frames as Blobs (kept off the JS heap, so hundreds stay cheap).
   * settings: { mode, value, format, jpegQuality, range, rotation, adjust, useAdjust }
   */
  async function extractFrames(media, settings, hooks) {
    hooks = hooks || {};
    const token = hooks.token || new VF.CancelToken();
    const onProgress = hooks.onProgress || function () {};

    const samples = VF.media.planSamples(media, settings.mode, settings.value, settings.range);
    if (!samples.length) throw new Error('Nothing to extract — the selected range contains no frames.');

    const rotation = settings.useAdjust ? (settings.rotation || 0) : 0;
    const adjust = settings.useAdjust
      ? settings.adjust
      : { brightness: 100, contrast: 100, saturation: 100 };

    const out = nativeOutput(media.width, media.height, rotation);
    if (samples.length > 3000) {
      throw new Error('That would extract ' + samples.length + ' frames. Narrow the range or sample less often.');
    }

    const canvas = document.createElement('canvas');
    const opts = renderOpts(out, { rotation, adjust, overlay: null });
    const ext = settings.format === 'image/jpeg' ? 'jpg' : 'png';
    const results = [];

    for (let i = 0; i < samples.length; i++) {
      token.throwIfCancelled();
      const s = samples[i];
      await media.seek(s.time);
      VF.render.renderFrame(media.drawable, canvas, opts);

      const blob = await canvasToBlob(canvas, settings.format, settings.jpegQuality);
      const url = makeUrl(blob);
      results.push({
        index: s.index,
        time: s.time,
        blob,
        url,
        ext,
        size: blob.size,
        width: out.outW,
        height: out.outH,
        selected: true
      });

      onProgress((i + 1) / samples.length, 'Extracting frame ' + (i + 1) + ' of ' + samples.length);
      // yield to the main thread so the UI can paint
      if (i % 6 === 5) await new Promise((r) => requestAnimationFrame(() => r()));
    }

    return results;
  }

  function releaseFrames(frames) {
    (frames || []).forEach((f) => releaseUrl(f.url));
  }

  /* ------------------------------------------------------------- zipping */

  async function buildZip(entries, hooks) {
    const L = libs();
    if (!L.jszip) throw new Error('JSZip is not loaded — check your connection and reload.');
    hooks = hooks || {};
    const zip = new L.jszip();

    entries.forEach((e) => {
      if (e.folder) zip.folder(e.folder).file(e.name, e.blob);
      else zip.file(e.name, e.blob);
    });

    return zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
      if (hooks.onProgress) hooks.onProgress(clamp(meta.percent / 100, 0, 1), 'Compressing archive…');
    });
  }

  function frameEntries(frames, folderPrefix, namePrefix) {
    return frames.map((f, i) => ({
      folder: folderPrefix || null,
      name: (namePrefix || 'frame') + '_' + String(i + 1).padStart(4, '0') + '_t' + f.time.toFixed(3).replace('.', '_') + 's.' + f.ext,
      blob: f.blob
    }));
  }

  VF.pipeline = {
    encodeGif,
    extractFrames,
    releaseFrames,
    buildZip,
    frameEntries,
    sampleTimes,
    planGif,
    orderTimes,
    frameDelays,
    estimateGifBytes,
    solveBudget,
    checkBudget,
    nativeOutput,
    qualityToGifJs,
    getWorkerScript,
    MAX_FRAMES
  };
})(window);

/* ==========================================================================
   media.js — unified media source: HTML5 video + animated GIF decoding
   ========================================================================== */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const { clamp, makeUrl, releaseUrl, libs } = VF;

  /* ------------------------------------------------------------------ video */

  function seekVideo(video, time) {
    return new Promise((resolve) => {
      const dur = video.duration;
      if (!isFinite(dur)) return resolve();
      const t = clamp(time, 0, Math.max(0, dur - 0.001));
      if (Math.abs(video.currentTime - t) < 0.0008 && video.readyState >= 2) return resolve();

      let settled = false;
      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('seeked', finish);
        video.removeEventListener('error', finish);
      }
      function finish() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
      // A few browsers never emit `seeked` for already-buffered positions.
      const timer = setTimeout(finish, 2500);
      video.addEventListener('seeked', finish);
      video.addEventListener('error', finish);
      try { video.currentTime = t; } catch (e) { finish(); }
    });
  }

  /** WebM files recorded with MediaRecorder often report duration === Infinity. */
  async function repairDuration(video) {
    if (isFinite(video.duration) && video.duration > 0) return video.duration;
    try {
      video.currentTime = 1e6;
      await new Promise((r) => {
        const done = () => { video.removeEventListener('seeked', done); r(); };
        video.addEventListener('seeked', done);
        setTimeout(done, 1200);
      });
      const d = video.duration;
      video.currentTime = 0;
      await new Promise((r) => {
        const done = () => { video.removeEventListener('seeked', done); r(); };
        video.addEventListener('seeked', done);
        setTimeout(done, 800);
      });
      if (isFinite(d) && d > 0) return d;
    } catch (e) { /* fall through */ }
    return 10; // last-resort guess; the trimmer stays usable
  }

  async function openVideo(file) {
    const url = makeUrl(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    const loaded = new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error(describeVideoError(video, file))), { once: true });
      setTimeout(() => reject(new Error('Timed out while reading this video.')), 25000);
    });

    video.src = url;
    await loaded;

    if (!video.videoWidth || !video.videoHeight) {
      releaseUrl(url);
      throw new Error('This file has no readable video track (audio only, or an unsupported codec).');
    }

    const duration = await repairDuration(video);
    await seekVideo(video, 0);

    let lastSeek = Promise.resolve();

    return {
      kind: 'video',
      file,
      url,
      width: video.videoWidth,
      height: video.videoHeight,
      duration,
      frameTimes: null,
      drawable: video,
      el: video,
      seek(t) {
        lastSeek = lastSeek.then(() => seekVideo(video, t)).catch(() => {});
        return lastSeek;
      },
      play() { return video.play(); },
      pause() { video.pause(); },
      get currentTime() { return video.currentTime; },
      set currentTime(v) { video.currentTime = v; },
      get paused() { return video.paused; },
      async thumbnails(count, w, h) {
        const strip = document.createElement('canvas');
        strip.width = w * count; strip.height = h;
        const sctx = strip.getContext('2d');
        for (let i = 0; i < count; i++) {
          const t = duration * ((i + 0.5) / count);
          await seekVideo(video, Math.min(t, Math.max(0, duration - 0.02)));
          sctx.drawImage(video, i * w, 0, w, h);
        }
        await seekVideo(video, 0);
        return strip;
      },
      destroy() {
        video.pause();
        video.removeAttribute('src');
        video.load();
        releaseUrl(url);
      }
    };
  }

  function describeVideoError(video, file) {
    const code = video.error && video.error.code;
    if (code === 4) {
      return 'Your browser cannot decode "' + file.name + '". MOV/HEVC files in particular need Safari or a browser with the codec installed — try re-saving as MP4 (H.264) or WebM.';
    }
    if (code === 2) return 'A network error occurred while reading "' + file.name + '".';
    if (code === 3) return '"' + file.name + '" appears to be corrupt.';
    return 'Could not read "' + file.name + '" as a video.';
  }

  /* -------------------------------------------------------------------- gif */

  async function openGif(file) {
    const L = libs();
    if (!L.gifReader) {
      throw new Error('The GIF decoding library (omggif) is not loaded. Check your connection and reload.');
    }

    let reader;
    try {
      reader = new L.gifReader(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      throw new Error('This GIF could not be parsed — it may be corrupt or use an unusual extension.');
    }

    const count = reader.numFrames();
    if (!count) throw new Error('This GIF contains no decodable frames.');

    const width = reader.width;
    const height = reader.height;
    const infos = [];
    const times = [];
    const delays = [];
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const info = reader.frameInfo(i);
      infos.push(info);
      times.push(acc);
      // omggif reports delays in centiseconds. A zero delay means "use the
      // historical 100ms browser default".
      const ms = Math.max(info.delay > 0 ? info.delay * 10 : 100, 20);
      delays.push(ms);
      acc += ms / 1000;
    }
    const duration = Math.max(acc, 0.04);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // omggif blits into a full-canvas buffer and leaves transparent pixels
    // untouched, so compositing over the previous frame falls out for free.
    const pixels = new Uint8ClampedArray(width * height * 4);
    const image = new ImageData(pixels, width, height);

    let composited = -1;      // index currently reflected in `pixels`
    let snapshot = null;      // disposal method 3

    function paintWhite(from, to) {
      for (let p = from; p < to; p += 4) {
        pixels[p] = 255; pixels[p + 1] = 255; pixels[p + 2] = 255; pixels[p + 3] = 255;
      }
    }

    function resetBuffer() {
      paintWhite(0, pixels.length);
      composited = -1;
      snapshot = null;
    }

    function flush() {
      ctx.putImageData(image, 0, 0);
    }

    function compositeIndex(i) {
      if (infos[i].disposal === 3) snapshot = pixels.slice();
      reader.decodeAndBlitFrameRGBA(i, pixels);
      composited = i;
      flush();
    }

    // omggif does not apply disposal methods, and the logical-screen background
    // index is not exposed, so "restore to background" becomes the same white
    // fill the buffer started with.
    function applyDisposal(i) {
      const info = infos[i];
      if (!info) return;
      if (info.disposal === 2) {
        const x1 = clamp(info.x, 0, width);
        const y1 = clamp(info.y, 0, height);
        const x2 = clamp(info.x + info.width, x1, width);
        const y2 = clamp(info.y + info.height, y1, height);
        for (let y = y1; y < y2; y++) {
          const start = (y * width + x1) * 4;
          paintWhite(start, start + (x2 - x1) * 4);
        }
        flush();
      } else if (info.disposal === 3 && snapshot) {
        pixels.set(snapshot);
        snapshot = null;
        flush();
      }
    }

    function compositeUpTo(i) {
      i = clamp(i | 0, 0, count - 1);
      if (composited === i) return;
      if (i < composited || composited < 0) {
        resetBuffer();
        for (let k = 0; k <= i; k++) {
          if (k > 0) applyDisposal(k - 1);
          compositeIndex(k);
        }
      } else {
        for (let k = composited + 1; k <= i; k++) {
          applyDisposal(k - 1);
          compositeIndex(k);
        }
      }
    }

    function indexForTime(t) {
      t = clamp(t, 0, duration);
      let lo = 0, hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= t) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    resetBuffer();
    compositeUpTo(0);

    return {
      kind: 'gif',
      file,
      url: null,
      width,
      height,
      duration,
      frameTimes: times,
      frameCount: count,
      delays,
      drawable: canvas,
      el: canvas,
      indexForTime,
      async seek(t) { compositeUpTo(indexForTime(t)); },
      play() { return Promise.resolve(); },
      pause() {},
      get currentTime() { return times[clamp(composited, 0, count - 1)] || 0; },
      async thumbnails(tiles, w, h) {
        const strip = document.createElement('canvas');
        strip.width = w * tiles; strip.height = h;
        const sctx = strip.getContext('2d');
        const step = count / tiles;
        for (let i = 0; i < tiles; i++) {
          compositeUpTo(Math.min(count - 1, Math.round(step * (i + 0.5))));
          sctx.drawImage(canvas, i * w, 0, w, h);
        }
        compositeUpTo(0);
        return strip;
      },
      destroy() { /* buffers are garbage collected */ }
    };
  }

  /* --------------------------------------------------------------- dispatch */

  async function open(file) {
    const kind = VF.detectKind(file);
    if (kind === 'gif') return openGif(file);
    if (kind === 'video') return openVideo(file);
    throw new Error('"' + file.name + '" is not a video or GIF file.');
  }

  /**
   * Build the list of sample times for a frame-extraction run.
   * mode: 'every' | 'nth' | 'fps' | 'count'
   */
  function planSamples(media, mode, value, range) {
    const start = range.start;
    const end = Math.max(range.end, start + 0.001);
    const span = end - start;

    if (media.kind === 'gif' && media.frameTimes) {
      const idxs = [];
      for (let i = 0; i < media.frameTimes.length; i++) {
        const t = media.frameTimes[i];
        if (t < start - 1e-6 || t > end + 1e-6) continue;
        idxs.push({ index: i, time: t });
      }
      if (mode === 'every') return idxs;
      if (mode === 'nth') return idxs.filter((_, i) => i % Math.max(1, Math.round(value)) === 0);
      if (mode === 'fps') {
        const want = Math.max(1, Math.round(span * value));
        return pickEvenly(idxs, want);
      }
      return pickEvenly(idxs, Math.max(1, Math.round(value)));
    }

    // video: no reliable frame count, sample on a time grid
    if (mode === 'every') {
      // "every frame" for video = native rate, assumed 30fps, capped for safety
      return grid(start, end, 30);
    }
    if (mode === 'nth') {
      const step = Math.max(1, Math.round(value)) / 30;
      return grid(start, end, 1 / step);
    }
    if (mode === 'fps') {
      return grid(start, end, Math.max(0.5, value));
    }
    const n = clamp(Math.round(value), 1, 999);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ index: i, time: n === 1 ? start : start + (span * i) / (n - 1) });
    return out;
  }

  function grid(start, end, fps) {
    const step = 1 / fps;
    const out = [];
    let i = 0;
    for (let t = start; t <= end + 1e-9; t += step, i++) out.push({ index: i, time: Math.min(t, end) });
    if (!out.length) out.push({ index: 0, time: start });
    return out;
  }

  function pickEvenly(items, want) {
    if (!items.length) return [];
    if (want >= items.length) return items;
    const out = [];
    for (let i = 0; i < want; i++) out.push(items[Math.round((i * (items.length - 1)) / Math.max(1, want - 1))]);
    return out;
  }

  VF.media = { open, openVideo, openGif, seekVideo, planSamples, grid };
})(window);

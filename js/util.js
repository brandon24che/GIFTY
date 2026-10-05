/* ==========================================================================
   util.js — helpers, toast system, object-URL registry, cancellation
   ========================================================================== */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  /* ---------- DOM ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  /* ---------- math / format ---------- */
  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const round = (v, dp) => { const p = Math.pow(10, dp || 0); return Math.round(v * p) / p; };

  function formatBytes(bytes, dp) {
    if (!isFinite(bytes) || bytes === null) return '—';
    if (bytes < 1) return '0 B';
    dp = dp === undefined ? 1 : dp;
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : dp)) + ' ' + units[i];
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return (m > 0 ? m + ':' + String(s.toFixed(2)).padStart(5, '0') : s.toFixed(2) + 's');
  }

  function sanitizeFilename(name, fallback) {
    const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').trim();
    return (base || fallback || 'output').slice(0, 60);
  }

  function debounce(fn, wait) {
    let t;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  /* ---------- object URL registry (memory hygiene) ---------- */
  const liveUrls = new Set();

  function makeUrl(blobOrFile) {
    const url = URL.createObjectURL(blobOrFile);
    liveUrls.add(url);
    return url;
  }

  function releaseUrl(url) {
    if (url && liveUrls.has(url)) {
      URL.revokeObjectURL(url);
      liveUrls.delete(url);
    }
  }

  function releaseAll() {
    liveUrls.forEach((u) => URL.revokeObjectURL(u));
    liveUrls.clear();
  }

  /* ---------- cancellation ---------- */
  class CancelledError extends Error {
    constructor(msg) { super(msg || 'Operation cancelled'); this.name = 'CancelledError'; this.cancelled = true; }
  }

  class CancelToken {
    constructor() { this.cancelled = false; this._onCancel = []; }
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      this._onCancel.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* noop */ } });
    }
    onCancel(fn) { if (this.cancelled) fn(); else this._onCancel.push(fn); }
    throwIfCancelled() { if (this.cancelled) throw new CancelledError(); }
    get isCancelled() { return this.cancelled; }
  }

  /* ---------- toasts ---------- */
  const ICONS = { success: '✓', error: '!', warn: '▲', info: 'i' };
  let toastHost = null;

  function toast(message, opts) {
    opts = opts || {};
    if (!toastHost) toastHost = $('#toasts');
    if (!toastHost) return null;

    const type = opts.type || 'info';
    const duration = opts.duration === undefined ? (type === 'error' ? 7000 : 4200) : opts.duration;
    if (VF.sfx) VF.sfx.toast(type);

    const node = el('div', { class: 'toast toast-' + type, role: type === 'error' ? 'alert' : 'status' }, [
      el('span', { class: 'toast-icon', text: ICONS[type] || 'i', 'aria-hidden': 'true' }),
      el('div', { class: 'toast-body' }, [
        opts.title ? el('div', { class: 'toast-title', text: opts.title }) : null,
        el('div', { class: 'toast-msg', text: message })
      ]),
      el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', text: '×' })
    ]);

    const close = () => {
      if (!node.isConnected) return;
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 240);
    };
    $('.toast-close', node).addEventListener('click', close);
    toastHost.appendChild(node);

    // keep the stack shallow
    const all = $$('.toast', toastHost);
    if (all.length > 4) all.slice(0, all.length - 4).forEach((n) => n.remove());

    if (duration > 0) setTimeout(close, duration);
    return close;
  }

  /* ---------- media helpers ---------- */
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/i;
  const GIF_EXT = /\.gif$/i;

  function detectKind(file) {
    const type = (file.type || '').toLowerCase();
    const name = file.name || '';
    if (type === 'image/gif' || GIF_EXT.test(name)) return 'gif';
    if (type.indexOf('video/') === 0 || VIDEO_EXT.test(name)) return 'video';
    return 'unknown';
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image (' + type + ')'))),
        type, quality
      );
    });
  }

  /* ---------- library availability ---------- */
  function libs() {
    const gifReader = global.GifReader || null;
    return {
      gifReader: gifReader,
      gifEncoder: global.GIF || null,
      jszip: global.JSZip || null,
      saveAs: global.saveAs || null,
      get ok() { return !!(gifReader && this.gifEncoder && this.jszip); }
    };
  }

  function saveBlob(blob, filename) {
    if (VF.sfx) VF.sfx.play('download');
    const L = libs();
    if (L.saveAs) { L.saveAs(blob, filename); return; }
    const url = makeUrl(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => releaseUrl(url), 4000);
  }

  /* ---------- capability flags ---------- */
  const supportsCanvasFilter = (() => {
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.filter = 'brightness(120%)';
      return ctx.filter === 'brightness(120%)';
    } catch (e) { return false; }
  })();

  VF.$ = $;
  VF.$$ = $$;
  VF.el = el;
  VF.clamp = clamp;
  VF.round = round;
  VF.formatBytes = formatBytes;
  VF.formatTime = formatTime;
  VF.sanitizeFilename = sanitizeFilename;
  VF.debounce = debounce;
  VF.makeUrl = makeUrl;
  VF.releaseUrl = releaseUrl;
  VF.releaseAll = releaseAll;
  VF.CancelToken = CancelToken;
  VF.CancelledError = CancelledError;
  VF.toast = toast;
  VF.detectKind = detectKind;
  VF.canvasToBlob = canvasToBlob;
  VF.libs = libs;
  VF.saveBlob = saveBlob;
  VF.supportsCanvasFilter = supportsCanvasFilter;
})(window);

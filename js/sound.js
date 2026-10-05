/* ==========================================================================
   sound.js — every cue is synthesized with the Web Audio API.
   No audio files, no network requests, works from file://.
   ========================================================================== */
(function (global) {
  'use strict';

  var VF = (global.VF = global.VF || {});

  var STORE_KEY = 'gf-sound';
  var TICK_GAP = 40; // ms — slider drags fire dozens of events per second

  var ctx = null;
  var master = null;
  var noiseBuf = null;
  var lastTick = 0;
  var enabled = readPref();

  function readPref() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      return v === null ? true : v === '1';
    } catch (e) {
      return true;
    }
  }

  function writePref(on) {
    try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  /* The AudioContext is only built on first use: browsers refuse to start one
     before the page has seen a gesture, and most cues come from gestures anyway. */
  function audio() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.34;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function tone(o) {
    if (!enabled) return;
    var c = audio();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    var t0 = c.currentTime + (o.at || 0);
    var dur = o.d || 0.09;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(o.to, 1), t0 + dur);
    var peak = o.gain == null ? 0.5 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function hiss(o) {
    if (!enabled) return;
    var c = audio();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    if (!noiseBuf) {
      var len = Math.floor(c.sampleRate * 0.5);
      noiseBuf = c.createBuffer(1, len, c.sampleRate);
      var data = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    var t0 = c.currentTime + (o.at || 0);
    var dur = o.d || 0.2;
    var src = c.createBufferSource();
    src.buffer = noiseBuf;
    var bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = o.q || 1.1;
    bp.frequency.setValueAtTime(o.f || 900, t0);
    if (o.to) bp.frequency.exponentialRampToValueAtTime(Math.max(o.to, 40), t0 + dur);
    var g = c.createGain();
    var peak = o.gain == null ? 0.32 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  /* A rising arpeggio reads as "success"; the same shape inverted reads as "no". */
  function arpeggio(freqs, type, step, gain, at) {
    for (var i = 0; i < freqs.length; i++) {
      tone({ f: freqs[i], at: (at || 0) + i * step, d: step * 1.9, type: type, gain: gain });
    }
  }

  var CUES = {
    tap: function () {
      tone({ f: 1180, to: 900, d: 0.045, type: 'triangle', gain: 0.26 });
    },
    tick: function (ratio) {
      var now = Date.now();
      if (now - lastTick < TICK_GAP) return;
      lastTick = now;
      var r = Math.max(0, Math.min(1, ratio || 0));
      tone({ f: 540 + r * 640, d: 0.035, type: 'sine', gain: 0.2 });
    },
    on: function () {
      tone({ f: 540, d: 0.06, type: 'triangle', gain: 0.3 });
      tone({ f: 860, at: 0.055, d: 0.09, type: 'triangle', gain: 0.3 });
    },
    off: function () {
      tone({ f: 820, d: 0.06, type: 'triangle', gain: 0.26 });
      tone({ f: 520, at: 0.055, d: 0.09, type: 'triangle', gain: 0.26 });
    },
    tab: function () {
      tone({ f: 430, to: 880, d: 0.1, type: 'sine', gain: 0.3 });
      hiss({ f: 1500, to: 2600, d: 0.08, q: 0.8, gain: 0.1 });
    },
    drop: function () {
      hiss({ f: 420, to: 1700, d: 0.22, q: 0.7, gain: 0.3 });
      tone({ f: 150, to: 70, d: 0.18, type: 'sine', gain: 0.5, at: 0.06 });
    },
    pick: function () {
      tone({ f: 940, d: 0.04, type: 'square', gain: 0.13 });
    },
    unpick: function () {
      tone({ f: 700, to: 560, d: 0.045, type: 'square', gain: 0.11 });
    },
    remove: function () {
      tone({ f: 420, to: 250, d: 0.1, type: 'triangle', gain: 0.24 });
    },
    start: function () {
      arpeggio([392, 523, 659], 'triangle', 0.055, 0.3);
    },
    success: function () {
      arpeggio([523, 659, 784, 1047], 'triangle', 0.075, 0.34);
    },
    download: function () {
      arpeggio([659, 880, 1175], 'sine', 0.06, 0.34);
      hiss({ f: 2200, to: 900, d: 0.16, q: 0.9, gain: 0.12, at: 0.05 });
    },
    error: function () {
      tone({ f: 300, to: 130, d: 0.3, type: 'sawtooth', gain: 0.28 });
      tone({ f: 190, to: 96, at: 0.08, d: 0.3, type: 'square', gain: 0.12 });
    },
    warn: function () {
      tone({ f: 660, d: 0.07, type: 'triangle', gain: 0.26 });
      tone({ f: 494, at: 0.09, d: 0.12, type: 'triangle', gain: 0.24 });
    },
    cancel: function () {
      tone({ f: 520, to: 260, d: 0.16, type: 'triangle', gain: 0.28 });
    },
    light: function () {
      arpeggio([880, 1319], 'sine', 0.06, 0.3);
    },
    dark: function () {
      arpeggio([660, 392], 'sine', 0.06, 0.28);
    }
  };

  /* Info toasts stay silent: the caller usually plays its own cue (cancel, download…). */
  var TOAST_CUE = { success: 'success', error: 'error', warn: 'warn' };

  VF.sfx = {
    play: function (name, arg) {
      var cue = CUES[name];
      if (cue && enabled) cue(arg);
    },
    toast: function (type) {
      var name = TOAST_CUE[type];
      if (name) this.play(name);
    },
    unlock: function () {
      var c = audio();
      if (c && c.state === 'suspended') c.resume();
    },
    get enabled() { return enabled; },
    setEnabled: function (on) {
      enabled = !!on;
      writePref(enabled);
      if (enabled) this.unlock();
      return enabled;
    },
    toggle: function () {
      enabled = !enabled;
      writePref(enabled);
      if (enabled) { this.unlock(); this.play('on'); }
      return enabled;
    },
    get supported() { return !!(global.AudioContext || global.webkitAudioContext); }
  };
})(window);

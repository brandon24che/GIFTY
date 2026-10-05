/* ==========================================================================
   render.js — canvas pipeline: scale, rotate, adjust, watermark
   ========================================================================== */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const { clamp, supportsCanvasFilter } = VF;

  const ROTATIONS = [0, 90, 180, 270];

  function isSwapped(rotation) { return rotation % 180 !== 0; }

  /**
   * Work out the encoder canvas size and the drawn source size.
   * targetW/targetH describe the final output box (after rotation).
   */
  function computeOutput(srcW, srcH, rotation, targetW, targetH, lockAspect) {
    const swapped = isSwapped(rotation);
    const effW = swapped ? srcH : srcW;
    const effH = swapped ? srcW : srcH;
    const ratio = effW / effH;

    let outW = clamp(Math.round(targetW) || 480, 32, 2048);
    let outH;
    if (lockAspect) {
      outH = clamp(Math.round(outW / ratio), 32, 2048);
    } else {
      outH = clamp(Math.round(targetH) || Math.round(outW / ratio), 32, 2048);
    }
    // GIF encoders behave best with even dimensions
    outW -= outW % 2;
    outH -= outH % 2;

    return {
      outW: Math.max(32, outW),
      outH: Math.max(32, outH),
      dW: swapped ? outH : outW,
      dH: swapped ? outW : outH,
      ratio
    };
  }

  function ensureSize(canvas, w, h) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  }

  function filterString(a) {
    const parts = [];
    if (Math.round(a.brightness) !== 100) parts.push('brightness(' + (a.brightness / 100).toFixed(3) + ')');
    if (Math.round(a.contrast) !== 100) parts.push('contrast(' + (a.contrast / 100).toFixed(3) + ')');
    if (Math.round(a.saturation) !== 100) parts.push('saturate(' + (a.saturation / 100).toFixed(3) + ')');
    return parts.length ? parts.join(' ') : 'none';
  }

  function isNeutral(a) {
    return Math.round(a.brightness) === 100 && Math.round(a.contrast) === 100 && Math.round(a.saturation) === 100;
  }

  /** Pixel-level fallback for browsers without CanvasRenderingContext2D.filter */
  function applyManualAdjust(ctx, w, h, a) {
    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return; }
    const d = img.data;
    const bAdd = (a.brightness / 100 - 1) * 255;
    const C = (a.contrast / 100 - 1) * 255;
    const cf = (259 * (C + 255)) / (255 * (259 - C));
    const s = a.saturation / 100;

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      r = cf * (r + bAdd - 128) + 128;
      g = cf * (g + bAdd - 128) + 128;
      b = cf * (b + bAdd - 128) + 128;
      if (s !== 1) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum + (r - lum) * s;
        g = lum + (g - lum) * s;
        b = lum + (b - lum) * s;
      }
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    ctx.putImageData(img, 0, 0);
  }

  const POSITIONS = {
    tl: 'Top left', tc: 'Top centre', tr: 'Top right',
    ml: 'Middle left', mc: 'Middle centre', mr: 'Middle right',
    bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right'
  };

  function drawOverlay(ctx, outW, outH, ov) {
    if (!ov || !ov.enabled) return;
    const raw = String(ov.text || '').replace(/\r/g, '');
    if (!raw.trim()) return;

    const lines = raw.split('\n').slice(0, 10).filter((l, i, arr) => l.length || i < arr.length - 1);
    if (!lines.length) return;

    let sizePx = Math.max(7, (Number(ov.sizePct) || 8) / 100 * outH);
    const weight = /Impact|Arial Black/i.test(ov.font) ? '400' : '700';

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const margin = Math.max(4, sizePx * 0.45);
    const col = String(ov.position || 'bc').charAt(1);
    const row = String(ov.position || 'bc').charAt(0);

    // shrink the type so it always fits inside the frame
    ctx.font = weight + ' ' + sizePx.toFixed(1) + 'px ' + ov.font;
    let widest = 0;
    for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
    const maxW = Math.max(20, outW - margin * 2);
    if (widest > maxW) {
      sizePx = Math.max(7, sizePx * (maxW / widest));
      ctx.font = weight + ' ' + sizePx.toFixed(1) + 'px ' + ov.font;
    }

    ctx.textAlign = col === 'l' ? 'left' : col === 'r' ? 'right' : 'center';
    const x = (col === 'l' ? margin : col === 'r' ? outW - margin : outW / 2) + (Number(ov.x) || 0) / 100 * outW;

    const lineH = sizePx * 1.16;
    const blockH = lineH * lines.length;
    let cy;
    if (row === 't') cy = margin + blockH / 2;
    else if (row === 'b') cy = outH - margin - blockH / 2;
    else cy = outH / 2;
    cy += (Number(ov.y) || 0) / 100 * outH;

    ctx.globalAlpha = clamp((Number(ov.opacity) === 0 ? 100 : Number(ov.opacity)) / 100, 0.05, 1);
    const strokeW = (Number(ov.strokePct) || 0) / 100 * sizePx;

    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = sizePx * 0.22;
    ctx.shadowOffsetY = Math.max(1, sizePx * 0.045);

    for (let i = 0; i < lines.length; i++) {
      const ly = cy - blockH / 2 + lineH / 2 + i * lineH;
      if (strokeW > 0.2) {
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = ov.strokeColor || '#000';
        ctx.strokeText(lines[i], x, ly);
      }
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = ov.color || '#fff';
      ctx.fillText(lines[i], x, ly);
      if (i < lines.length - 1) {
        ctx.shadowColor = 'rgba(0,0,0,.55)';
        ctx.shadowBlur = sizePx * 0.22;
        ctx.shadowOffsetY = Math.max(1, sizePx * 0.045);
      }
    }
    ctx.restore();
  }

  /**
   * Draw one frame of `source` into `canvas`, applying rotation, scaling,
   * colour adjustments and the text overlay.
   */
  function renderFrame(source, canvas, opts) {
    const outW = opts.outW, outH = opts.outH;
    ensureSize(canvas, outW, outH);
    const ctx = canvas.getContext('2d', { willReadFrequently: !supportsCanvasFilter });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, outW, outH);
    if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, outW, outH); }

    const rotation = ROTATIONS.indexOf(opts.rotation) >= 0 ? opts.rotation : 0;
    const adjust = opts.adjust || { brightness: 100, contrast: 100, saturation: 100 };

    ctx.save();
    if (supportsCanvasFilter && !isNeutral(adjust)) ctx.filter = filterString(adjust);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(outW / 2, outH / 2);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(source, -opts.dW / 2, -opts.dH / 2, opts.dW, opts.dH);
    ctx.restore();
    ctx.filter = 'none';

    if (!supportsCanvasFilter && !isNeutral(adjust)) applyManualAdjust(ctx, outW, outH, adjust);
    if (opts.overlay) drawOverlay(ctx, outW, outH, opts.overlay);

    return canvas;
  }

  VF.render = {
    ROTATIONS,
    POSITIONS,
    computeOutput,
    ensureSize,
    renderFrame,
    drawOverlay,
    filterString,
    isNeutral,
    supportsCanvasFilter
  };
})(window);

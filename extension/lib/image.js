/*
 * Screenshot post-processing for the extension service worker.
 *
 * Draws element reference boxes, optional coordinate grids, converts formats
 * and keeps images below a sane size before returning them to the MCP server.
 */

export function dataUrlToBase64(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : text;
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function colorFor(value) {
  const palette = [
    '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7',
    '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#8e8e93'
  ];
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index++) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

function drawLabel(ctx, text, x, y, color, fontPx) {
  const paddingX = 4 * (fontPx / 11);
  const paddingY = 2 * (fontPx / 11);
  ctx.font = `${Math.round(fontPx)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const width = ctx.measureText(text).width + paddingX * 2;
  const height = fontPx + paddingY * 2;
  let left = x;
  let top = y - height;
  if (top < 0) top = y + 2;
  ctx.fillStyle = color;
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.fillText(text, left + paddingX, top + paddingY);
}

export async function processScreenshot(options) {
  const base64 = String(options.base64 || '');
  const mimeType = options.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const format = options.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = Math.max(1, Math.min(Number(options.quality) || 82, 100));
  const maxWidth = Math.max(200, Math.min(Number(options.maxWidth) || 1400, 6000));
  const maxHeight = Math.max(200, Math.min(Number(options.maxHeight) || 8000, 12000));
  const annotate = !!options.annotate;
  const grid = !!options.grid;
  const rects = Array.isArray(options.rects) ? options.rects : [];
  const originX = Number(options.originX) || 0;
  const originY = Number(options.originY) || 0;
  const cssWidth = Math.max(1, Number(options.cssWidth) || 1);
  const cssHeight = Math.max(1, Number(options.cssHeight) || 1);

  if (!base64) throw new Error('Screenshot data is empty.');
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('This Chrome version does not support OffscreenCanvas image processing.');
  }

  const bytes = base64ToBytes(base64);
  const blob = new Blob([bytes], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  const imgScale = bitmap.width / cssWidth;
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const needsConversion = format !== (mimeType === 'image/jpeg' ? 'jpeg' : 'png');

  if (!annotate && !grid && scale === 1 && !needsConversion) {
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return {
      base64,
      mimeType,
      width,
      height,
      scaled: false
    };
  }

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create an OffscreenCanvas context.');

  ctx.scale(scale, scale);
  ctx.drawImage(bitmap, 0, 0);

  if (grid) {
    const step = 100 * imgScale;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 122, 255, 0.28)';
    ctx.fillStyle = 'rgba(0, 60, 140, 0.75)';
    ctx.lineWidth = Math.max(1, imgScale);
    ctx.font = `${Math.round(10 * imgScale)}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    for (let x = 0, count = 0; x <= bitmap.width && count < 300; x += step, count++) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, bitmap.height);
      ctx.stroke();
      if (x > 4) ctx.fillText(String(Math.round(x / imgScale)), x + 2 * imgScale, 2 * imgScale);
    }
    for (let y = 0, count = 0; y <= bitmap.height && count < 400; y += step, count++) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(bitmap.width, y);
      ctx.stroke();
      if (y > 4) ctx.fillText(String(Math.round(y / imgScale)), 3 * imgScale, y + 2 * imgScale);
    }
    ctx.restore();
  }

  if (annotate) {
    const fontPx = Math.max(10, 11 * imgScale);
    const lineWidth = Math.max(1, 2 * imgScale);
    const visible = rects.filter((item) => {
      const pageX = item.pageX != null ? item.pageX : (item.rect ? item.rect.x : 0) + originX;
      const pageY = item.pageY != null ? item.pageY : (item.rect ? item.rect.y : 0) + originY;
      const rectWidth = item.rect ? item.rect.width : 0;
      const rectHeight = item.rect ? item.rect.height : 0;
      return pageX + rectWidth >= originX && pageY + rectHeight >= originY &&
        pageX <= originX + cssWidth && pageY <= originY + cssHeight;
    }).slice(0, 250);

    for (const item of visible) {
      const pageX = item.pageX != null ? item.pageX : (item.rect ? item.rect.x : 0) + originX;
      const pageY = item.pageY != null ? item.pageY : (item.rect ? item.rect.y : 0) + originY;
      const rectWidth = item.rect ? item.rect.width : 0;
      const rectHeight = item.rect ? item.rect.height : 0;
      const x = (pageX - originX) * imgScale;
      const y = (pageY - originY) * imgScale;
      const w = Math.max(2, rectWidth * imgScale);
      const h = Math.max(2, rectHeight * imgScale);
      if (x + w < 0 || y + h < 0 || x > bitmap.width || y > bitmap.height) continue;
      const color = colorFor(item.ref || item.name || '');
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
      const label = item.ref ? String(item.ref) : String(item.name || item.tag || '');
      if (label) drawLabel(ctx, label.slice(0, 42), x, y, color, fontPx);
    }
  }

  bitmap.close();
  const outputType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const output = await canvas.convertToBlob({ type: outputType, quality: format === 'jpeg' ? quality / 100 : undefined });
  const buffer = await output.arrayBuffer();
  return {
    base64: bytesToBase64(new Uint8Array(buffer)),
    mimeType: outputType,
    width: canvas.width,
    height: canvas.height,
    scaled: scale !== 1,
    annotated: annotate,
    grid
  };
}

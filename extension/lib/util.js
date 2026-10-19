export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms.`);
      error.code = 'TIMEOUT';
      reject(error);
    }, Math.max(1, Number(ms) || 1));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function truncate(value, max = 4000) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function errorMessage(error) {
  if (!error) return 'Unknown error.';
  return error.message || String(error);
}

export function jsonText(value, max = 20000) {
  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return truncate(String(value), max);
  }
}

export function normalizeServerUrl(value) {
  let url = String(value || '').trim();
  if (!url) url = 'ws://127.0.0.1:8787';
  if (!/^wss?:\/\//i.test(url)) {
    if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
    else url = 'ws://' + url;
  }
  return url.replace(/\/+$/, '');
}

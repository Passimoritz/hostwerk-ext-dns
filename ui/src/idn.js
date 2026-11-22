/*
 * Domains with umlauts are stored as Punycode ("xn--mller-kva.de", the server converts input with domainToASCII) –
 * shown here as the user typed them ("müller.de"). Works for host names and mail addresses (name@xn--…).
 * Punycode decoding after RFC 3492 (browsers have no toUnicode).
 */
const BASE = 36; const TMIN = 1; const TMAX = 26; const SKEW = 38; const DAMP = 700;

function adapt(delta, n, first) {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / n);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) { d = Math.floor(d / (BASE - TMIN)); k += BASE; }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

function decodeLabel(s) {
  const out = [];
  const cut = s.lastIndexOf('-');
  for (let j = 0; j < Math.max(cut, 0); j++) out.push(s.charCodeAt(j));
  let n = 128; let i = 0; let bias = 72;
  for (let p = cut > 0 ? cut + 1 : 0; p < s.length;) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (p >= s.length) throw new Error('bad punycode');
      const c = s.charCodeAt(p++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE;
      if (digit >= BASE) throw new Error('bad punycode');
      i += digit * w;
      const tt = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < tt) break;
      w *= BASE - tt;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** "xn--mller-kva.de" → "müller.de", "info@xn--mller-kva.de" → "info@müller.de"; anything else stays as it is. */
export function showDomain(v) {
  const s = String(v == null ? '' : v);
  if (!/xn--/i.test(s)) return s;
  const at = s.lastIndexOf('@');
  const host = at >= 0 ? s.slice(at + 1) : s;
  const uni = host.split('.').map((l) => { if (!/^xn--/i.test(l)) return l; try { const u = decodeLabel(l.slice(4).toLowerCase()); return u && !/[\u0000-\u001f\u007f]/.test(u) ? u : l; } catch { return l; } }).join('.');
  return at >= 0 ? `${s.slice(0, at + 1)}${uni}` : uni;
}

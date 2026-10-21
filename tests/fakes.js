'use strict';
/*
 * Nachbildungen für die Tests: fetch mit Anbieter-Attrappen (Cloudflare, Hetzner Cloud/alt, INWX, IONOS) und ein
 * DNS-Resolver. Es geht keine einzige echte Anfrage hinaus – unbekannte Adressen lassen den Test scheitern.
 */

/** Antwort wie von fetch. */
function reply(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: (k) => h.get(k.toLowerCase()) || null } };
}

/** fetch, das je Adresse an eine Attrappe weitergibt und jede Anfrage mitschreibt. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const call = { method: opts.method || 'GET', url: u, path: u.pathname, body, headers: opts.headers || {} };
    calls.push(call);
    const h = handlers[u.host];
    if (!h) throw new Error(`unexpected request to ${u.host}`);
    return h(call);
  };
  fn.calls = calls;
  return fn;
}

/* ---------------- Cloudflare ---------------- */
function cloudflare({ token = 'cf-token', zones = [{ id: 'z1', name: 'example.com' }], records = [] } = {}) {
  const st = { zones, records: records.map((r, i) => ({ id: `r${i + 1}`, zone: 'z1', ...r })), next: records.length + 1 };
  const ok = (result, info) => reply(200, { success: true, errors: [], result, ...(info ? { result_info: info } : {}) });
  const handler = (c) => {
    if (c.headers.Authorization !== `Bearer ${token}`) return reply(403, { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] });
    const page = Number(c.url.searchParams.get('page') || 1); const per = Number(c.url.searchParams.get('per_page') || 100);
    const paged = (list) => ok(list.slice((page - 1) * per, page * per), { page, per_page: per, total_pages: Math.max(1, Math.ceil(list.length / per)) });
    let m;
    if (c.path === '/client/v4/user/tokens/verify') return ok({ status: 'active' });
    if (c.path === '/client/v4/zones') return paged(st.zones);
    if ((m = /^\/client\/v4\/zones\/([^/]+)\/dns_records$/.exec(c.path))) {
      if (c.method === 'GET') return paged(st.records.filter((r) => r.zone === m[1]));
      if (c.method === 'POST') { if (c.body.type === 'TXT' && !String(c.body.content).startsWith('"')) return reply(400, { success: false, errors: [{ code: 9999, message: 'expected quoted TXT' }] }); const r = { id: `r${st.next++}`, zone: m[1], ...c.body }; st.records.push(r); return ok(r); }
    }
    if ((m = /^\/client\/v4\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(c.path))) {
      const i = st.records.findIndex((r) => r.id === m[2]);
      if (i < 0) return reply(404, { success: false, errors: [{ code: 81044, message: 'Record does not exist.' }] });
      if (c.method === 'PUT') { st.records[i] = { id: m[2], zone: m[1], ...c.body }; return ok(st.records[i]); }
      if (c.method === 'DELETE') { st.records.splice(i, 1); return ok({ id: m[2] }); }
    }
    return reply(404, { success: false, errors: [{ code: 7003, message: 'No route' }] });
  };
  return { st, handler };
}

/* ---------------- Hetzner Cloud (RRSets) ---------------- */
function hetznerCloud({ token = 'hz-token', zones = [{ id: 11, name: 'example.org' }], rrsets = [] } = {}) {
  const st = { zones, rrsets: rrsets.map((r) => ({ zone: 11, ...r })), actions: [] };
  const handler = (c) => {
    if (c.headers.Authorization !== `Bearer ${token}`) return reply(401, { error: { code: 'unauthorized', message: 'unable to authenticate' } });
    let m;
    if (c.path === '/v1/zones') return reply(200, { zones: st.zones, meta: { pagination: { page: 1, next_page: null } } });
    if ((m = /^\/v1\/zones\/(\d+)\/rrsets$/.exec(c.path))) {
      const z = Number(m[1]);
      if (c.method === 'GET') return reply(200, { rrsets: st.rrsets.filter((r) => r.zone === z).map(({ zone, ...r }) => ({ id: `${r.name}/${r.type}`, ...r })), meta: { pagination: { next_page: null } } });
      if (c.method === 'POST') { st.rrsets.push({ zone: z, name: c.body.name, type: c.body.type, ttl: c.body.ttl, records: c.body.records }); return reply(201, { rrset: c.body, action: { id: 1 } }); }
    }
    if ((m = /^\/v1\/zones\/(\d+)\/rrsets\/([^/]+)\/([A-Z]+)(\/actions\/(\w+))?$/.exec(c.path))) {
      const z = Number(m[1]); const name = decodeURIComponent(m[2]); const type = m[3]; const action = m[5];
      const rr = st.rrsets.find((r) => r.zone === z && r.name === name && r.type === type);
      if (!rr) return reply(404, { error: { code: 'not_found', message: 'rrset not found' } });
      if (!action && c.method === 'GET') return reply(200, { rrset: { id: `${name}/${type}`, name, type, ttl: rr.ttl, records: rr.records } });
      if (!action && c.method === 'DELETE') { st.rrsets.splice(st.rrsets.indexOf(rr), 1); return reply(201, { action: { id: 2 } }); }
      st.actions.push(action);
      if (action === 'set_records') { rr.records = c.body.records; return reply(201, { action: { id: 3 } }); }
      if (action === 'change_ttl') { rr.ttl = c.body.ttl; return reply(201, { action: { id: 4 } }); }
    }
    return reply(404, { error: { code: 'not_found', message: 'no route' } });
  };
  return { st, handler };
}

/* ---------------- Hetzner DNS-Konsole (alt) ---------------- */
function hetznerLegacy({ token = 'old-token', records = [] } = {}) {
  const st = { records: records.map((r, i) => ({ id: `h${i + 1}`, zone_id: 'zL', ...r })), next: records.length + 1 };
  const handler = (c) => {
    if (c.headers['Auth-API-Token'] !== token) return reply(401, { message: 'Invalid authentication credentials' });
    let m;
    if (c.path === '/api/v1/zones') return reply(200, { zones: [{ id: 'zL', name: 'example.net' }], meta: { pagination: { page: 1, last_page: 1 } } });
    if (c.path === '/api/v1/records' && c.method === 'GET') return reply(200, { records: st.records.filter((r) => r.zone_id === c.url.searchParams.get('zone_id')) });
    if (c.path === '/api/v1/records' && c.method === 'POST') { const r = { id: `h${st.next++}`, ...c.body }; st.records.push(r); return reply(200, { record: r }); }
    if ((m = /^\/api\/v1\/records\/(\w+)$/.exec(c.path))) {
      const i = st.records.findIndex((r) => r.id === m[1]);
      if (c.method === 'PUT') { st.records[i] = { id: m[1], ...c.body }; return reply(200, { record: st.records[i] }); }
      if (c.method === 'DELETE') { st.records.splice(i, 1); return reply(200, {}); }
    }
    return reply(404, { message: 'no route' });
  };
  return { st, handler };
}

/* ---------------- INWX (JSON-RPC mit Cookie) ---------------- */
function inwx({ user = 'dnsbot', pass = 'pw', tfa = false, expectTan = null, records = [] } = {}) {
  const st = { records: records.map((r, i) => ({ id: 100 + i, ...r })), next: 100 + records.length, loggedIn: false, unlocked: !tfa, logouts: 0, methods: [] };
  const handler = (c) => {
    const { method, params } = c.body;
    st.methods.push(method);
    const res = (code, resData, extra = {}) => reply(200, { code, msg: code < 2000 ? 'Command completed successfully' : 'Authentication error', ...(resData ? { resData } : {}) }, extra);
    if (method === 'account.login') {
      if (params.user !== user || params.pass !== pass) return res(2200);
      st.loggedIn = true;
      return res(1000, { customerId: 1, tfa: tfa ? 'GOOGLE-AUTH' : '0' }, { 'Set-Cookie': 'domrobot=abc123; path=/; HttpOnly' });
    }
    if (c.headers.Cookie !== 'domrobot=abc123' || !st.loggedIn) return res(2202);
    if (method === 'account.unlock') { if (params.tan !== expectTan) return res(2200); st.unlocked = true; return res(1000); }
    if (!st.unlocked) return res(2202);
    if (method === 'account.logout') { st.loggedIn = false; st.logouts++; return res(1500); }
    if (method === 'nameserver.list') return res(1000, { count: 1, domains: [{ domain: 'example.de', type: 'MASTER' }] });
    if (method === 'nameserver.info') return res(1000, { domain: params.domain, record: st.records });
    if (method === 'nameserver.createRecord') { const fq = params.name ? `${params.name}.${params.domain}` : params.domain; const r = { id: st.next++, name: fq, type: params.type, content: params.content, ttl: params.ttl, prio: params.prio || 0 }; st.records.push(r); return res(1000, { id: r.id }); }
    if (method === 'nameserver.updateRecord') { const r = st.records.find((x) => x.id === params.id); Object.assign(r, { content: params.content, ttl: params.ttl, prio: params.prio || 0 }); return res(1000); }
    if (method === 'nameserver.deleteRecord') { st.records = st.records.filter((x) => x.id !== params.id); return res(1000); }
    return res(2000);
  };
  return { st, handler };
}

/* ---------------- IONOS ---------------- */
function ionos({ key = 'pre.secret', records = [] } = {}) {
  const st = { records: records.map((r, i) => ({ id: `io-${i + 1}`, ...r })), next: records.length + 1 };
  const handler = (c) => {
    if (c.headers['X-API-Key'] !== key) return reply(401, [{ code: 'UNAUTHORIZED', message: 'The customer is not authorized to do this operation.' }]);
    let m;
    if (c.path === '/dns/v1/zones') return reply(200, [{ id: 'zi', name: 'example.eu', type: 'NATIVE' }]);
    if (c.path === '/dns/v1/zones/zi' && c.method === 'GET') return reply(200, { id: 'zi', name: 'example.eu', records: st.records });
    if (c.path === '/dns/v1/zones/zi/records' && c.method === 'POST') { const out = c.body.map((r) => { const x = { id: `io-${st.next++}`, ...r }; st.records.push(x); return x; }); return reply(201, out); }
    if ((m = /^\/dns\/v1\/zones\/zi\/records\/([\w-]+)$/.exec(c.path))) {
      const i = st.records.findIndex((r) => r.id === m[1]);
      if (i < 0) return reply(404, [{ code: 'RECORD_NOT_FOUND', message: 'Record not found' }]);
      if (c.method === 'PUT') { if (c.body.name || c.body.type) return reply(400, [{ code: 'INVALID', message: 'name/type cannot change' }]); Object.assign(st.records[i], c.body); return reply(200, {}); }
      if (c.method === 'DELETE') { st.records.splice(i, 1); return reply(200, {}); }
    }
    return reply(404, [{ code: 'NOT_FOUND', message: 'no route' }]);
  };
  return { st, handler };
}

/**
 * Resolver-Attrappe: answers = { 'name|TYPE': [antworten] } für alle Resolver gleich, oder je Server-Liste über
 * byServer = { '1.1.1.1': { … } }. Antworten in Nodes Form (resolveMx → [{ exchange, priority }] usw.).
 */
function fakeResolver(answers, byServer = {}) {
  return (servers) => {
    const a = byServer[servers[0]] || answers;
    const get = (type) => async (name) => {
      const v = a[`${name}|${type}`];
      if (v === undefined) throw Object.assign(new Error('no data'), { code: 'ENODATA' });
      if (v instanceof Error) throw v;
      return typeof v === 'function' ? v() : v;
    };
    return { resolve4: get('A'), resolve6: get('AAAA'), resolveCname: get('CNAME'), resolveMx: get('MX'), resolveTxt: get('TXT'), resolveSrv: get('SRV'), resolveCaa: get('CAA') };
  };
}

/** Geheimnis-Ablage wie core/secrets (nur umkehrbar „verpackt“, damit der Test sieht, dass nie Klartext liegt). */
const secrets = {
  seal: (t) => (t ? `enc:${Buffer.from(String(t)).toString('base64').split('').reverse().join('')}` : ''),
  open: (v) => (v && String(v).startsWith('enc:') ? Buffer.from(String(v).slice(4).split('').reverse().join(''), 'base64').toString() : v || ''),
};

module.exports = { reply, fakeFetch, cloudflare, hetznerCloud, hetznerLegacy, inwx, ionos, fakeResolver, secrets };

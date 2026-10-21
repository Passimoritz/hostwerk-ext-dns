import { useEffect, useMemo, useState } from 'react';
import { Globe, Plus, Pencil, Trash2, RefreshCw, CheckCircle2, XCircle, Mail, KeyRound, ExternalLink, Router as RouterIcon, ListChecks, Server, Wand2, History, Download, Upload, ShieldCheck, ShieldAlert, Shield, Gift, Copy, ArrowLeft, Gamepad2, Clock } from 'lucide-react';
import { get, post, put, del, useApi } from '@hostwerk/api';
import { Btn, Field, Modal, Empty, Loading, Callout, InfoTip, Switch, Tabs, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * DNS-Verwaltung: drei Reiter –
 *   Namen      Namen, die von selbst auf diesen Anschluss zeigen (kostenlose DynDNS-Namen oder eigene Domain), mit Stand,
 *              Prüfung und Protokoll; Assistent „Ich habe keine Domain / Ich habe eine Domain“
 *   Einträge   alle Einträge je Zone (anlegen, ändern, löschen, prüfen), Vorlagen, Zonendatei, DNSSEC
 *   Anbieter   Zugänge und – wenn die Erweiterung „Mailserver“ da ist – deren MX/SPF/DKIM/DMARC mit einem Klick
 * Dazu zwei Einbau-Orte in Hostwerk: Livebetrieb → DNS (Namen + Domains der Webserver) und Minecraft → eigene Adresse.
 * Texte sind Englisch; Deutsch kommt aus locales/de.json (auch in JSX).
 */
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const TTLS = [[60, '1 min'], [300, '5 min'], [3600, '1 h'], [14400, '4 h'], [86400, '1 day']];
const HINT = {
  A: 'IPv4 address, e.g. 203.0.113.10',
  AAAA: 'IPv6 address, e.g. 2001:db8::10',
  CNAME: 'Target name, e.g. example.com',
  MX: 'Mail server name, e.g. mail.example.com',
  TXT: 'Text, e.g. v=spf1 mx -all',
  SRV: 'weight port target, e.g. 5 25565 mc.example.com',
  CAA: 'flags tag value, e.g. 0 issue "letsencrypt.org"',
};
const enc = encodeURIComponent;
const rel = (name, zone) => (name === zone ? '@' : name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name);
const full = (name, zone) => (!name || name === '@' ? zone : name.endsWith(`.${zone}`) || name === zone ? name : `${name}.${zone}`);
// Einzahl/Mehrzahl über t() – läuft auch auf Hostwerk-Versionen, deren @hostwerk/i18n noch kein pl() hat
const pl = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n, ...vars });
const ttlText = (n) => { const x = TTLS.find(([v]) => v === n); return x ? x[1] : n === 1 ? 'auto' : `${n} s`; };
const ago = (ms) => {
  if (!ms) return t('never');
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return t('just now');
  if (m < 60) return pl(m, '1 min ago', '{n} min ago');
  const h = Math.round(m / 60);
  return h < 48 ? pl(h, '1 hour ago', '{n} hours ago') : pl(Math.round(h / 24), '1 day ago', '{n} days ago');
};
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success(t('Copied')); } catch { toast.error(t('Could not copy.')); } };
const zoneBase = (z) => `/dns/zones/${enc(z.account)}/${enc(z.id)}`;

/* ---------------- Formularfelder eines Anbieters ---------------- */
function CredFields({ fields, creds, setCreds, stored = {} }) {
  const set = (k, v) => setCreds({ ...creds, [k]: v });
  return fields.map((f) => (f.type === 'switch' ? (
    <label key={f.key} className="check"><Switch checked={!!creds[f.key]} onChange={(v) => set(f.key, v)} /> {f.label}</label>
  ) : f.type === 'select' ? (
    <Field key={f.key} label={f.label}><select className="select" value={creds[f.key] || f.default} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>
  ) : (
    <Field key={f.key} label={f.label} hint={f.secret && stored[f.key] ? 'Stored encrypted – leave empty to keep it.' : f.secret ? 'Stored encrypted in Hostwerk and never shown again.' : ''}>
      <input className="input mono" type={f.secret ? 'password' : 'text'} autoComplete="off" value={creds[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
    </Field>
  )));
}
const missingCreds = (fields, creds, stored = {}) => fields.some((f) => f.required && !(creds[f.key] || (f.secret && stored[f.key])));

/* ---------------- Zugang anlegen / ändern ---------------- */
function AccountForm({ providers, account, onClose, onSaved }) {
  const isNew = !account;
  const [provider, setProvider] = useState(account ? account.provider : providers[0].id);
  const p = providers.find((x) => x.id === provider);
  const [name, setName] = useState(account ? account.name : '');
  const [creds, setCreds] = useState(() => (account ? Object.fromEntries(p.fields.filter((f) => !f.secret).map((f) => [f.key, account.fields[f.key]])) : {}));
  const stored = account ? account.fields : {};
  const save = async () => {
    try {
      const r = isNew ? await post('/dns/accounts', { provider, name, creds }) : await put(`/dns/accounts/${enc(account.id)}`, { name, creds });
      toast.success(pl(r.zones || 0, 'Connected – 1 zone found', 'Connected – {n} zones found'));
      onSaved(r); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title={isNew ? 'Add DNS provider' : t('Provider {name}', { name: account.name })} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={KeyRound} disabled={missingCreds(p.fields, creds, stored)} onClick={save}>Check and save</Btn></>}>
      <div className="stack">
        {isNew && (
          <Field label="Provider">
            <select className="select" value={provider} onChange={(e) => { setProvider(e.target.value); setCreds({}); }}>{providers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          </Field>
        )}
        <Callout kind="info" dismissible={false}>
          <span>{p.help}</span>{' '}
          <a href={p.url} target="_blank" rel="noreferrer" className="dns-link">Open the provider page <ExternalLink size={12} /></a>
        </Callout>
        {p.cost && <div className="small muted">{p.cost.note}</div>}
        <Field label="Name in Hostwerk" hint="Optional, e.g. “Private domains”"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={p.label} /></Field>
        <CredFields fields={p.fields} creds={creds} setCreds={setCreds} stored={stored} />
      </div>
    </Modal>
  );
}

/* ---------------- Assistent: kostenloser Name oder eigene Domain ---------------- */
function Badges({ x }) {
  return (
    <span className="row-tight dns-badges">
      {x.free && <span className="badge ok">free</span>}
      {x.maintenance === 'monthly' ? <span className="badge warn">confirm every 30 days</span> : <span className="badge">maintenance-free</span>}
      {x.ipv6 && <span className="badge">IPv6</span>}
      {x.dnssec && <span className="badge">DNSSEC</span>}
      {x.records && <span className="badge">all record types</span>}
    </span>
  );
}

function Wizard({ data, onClose, onDone, start = null }) {
  const [step, setStep] = useState(start || 'choose'); // choose → free → free-form | domain → domain-form → domain-name
  const [kind, setKind] = useState(null);
  const [name, setName] = useState('');
  const [creds, setCreds] = useState({});
  const [v4, setV4] = useState(true);
  const [v6, setV6] = useState(true);
  const [alsoRecords, setAlsoRecords] = useState(true);
  const [account, setAccount] = useState(null);
  const [sub, setSub] = useState('@');
  const dyn = data.dyn.find((x) => x.id === kind);
  const prov = data.providers.find((x) => x.id === kind);
  const back = (to) => <Btn className="ghost" icon={ArrowLeft} onClick={() => setStep(to)}>Back</Btn>;

  const saveFree = async () => {
    try {
      const r = await post('/dns/names', { kind, name, creds, v4, v6 });
      if (dyn.records && alsoRecords) { try { await post('/dns/accounts', { provider: 'desec', name: r.host.name, creds: { token: creds.token } }); } catch (e) { toast.error(e); } }
      if (r.warning) toast.error(t('Saved, but: {e}', { e: r.warning })); else toast.success(t('{name} now points to this connection.', { name: r.host.name }));
      onDone(); onClose();
    } catch (e) { toast.error(e); }
  };
  const saveAccount = async () => {
    try {
      const a = await post('/dns/accounts', { provider: kind, creds });
      toast.success(pl(a.zones || 0, 'Connected – 1 zone found', 'Connected – {n} zones found'));
      setAccount(a); onDone(); setStep('domain-name');
    } catch (e) { toast.error(e); }
  };
  const zones = useApi(step === 'domain-name' ? '/dns/zones?force=1' : null, [step], { live: false, poll: false });
  const myZones = ((zones.data && zones.data.zones) || []).filter((z) => !account || z.account === account.id);
  const [zoneId, setZoneId] = useState('');
  const zone = myZones.find((z) => z.id === zoneId) || myZones[0];
  const saveZoneName = async () => {
    try {
      const r = await post('/dns/names', { kind: 'zone', name: full(sub.trim(), zone.name), v4, v6 });
      toast.success(t('{name} now points to this connection.', { name: r.host.name }));
      onDone(); onClose();
    } catch (e) { toast.error(e); }
  };

  let body; let footer;
  if (step === 'choose') {
    body = (
      <div className="grid grid-2 dns-choice">
        <button type="button" className="card dns-choice-card" onClick={() => setStep('free')}>
          <Gift size={22} />
          <b>I have no domain</b>
          <span className="small muted">Get a free name like myserver.duckdns.org – it follows your address by itself.</span>
        </button>
        <button type="button" className="card dns-choice-card" onClick={() => setStep('domain')}>
          <Globe size={22} />
          <b>I have a domain</b>
          <span className="small muted">Connect where its DNS is run – then manage all records here and let a name follow this connection.</span>
        </button>
      </div>
    );
    footer = <Btn onClick={onClose}>Cancel</Btn>;
  } else if (step === 'free') {
    body = (
      <div className="stack">
        <p className="small muted">All of these cost nothing and need no domain. Hostwerk keeps the name up to date by itself.</p>
        {data.dyn.map((x) => (
          <button key={x.id} type="button" className="list-item dns-pick" onClick={() => { setKind(x.id); setCreds({}); setName(''); setStep('free-form'); }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-tight"><b>{x.label}</b><Badges x={x} /></div>
              <div className="small muted">{x.note}</div>
            </div>
          </button>
        ))}
      </div>
    );
    footer = <>{back('choose')}<Btn onClick={onClose}>Cancel</Btn></>;
  } else if (step === 'free-form' && dyn) {
    body = (
      <div className="stack">
        <div className="row-tight"><b>{dyn.label}</b><Badges x={dyn} /></div>
        {dyn.maintenance === 'monthly' && <Callout kind="warn" dismissible={false}>No-IP deletes free hostnames that are not confirmed by e-mail every 30 days. Hostwerk cannot do that for you – pick DuckDNS, deSEC or dynv6 if you want no regular work.</Callout>}
        <ol className="dns-steps small">{dyn.steps.map((s) => <li key={s}>{t(s)}</li>)}</ol>
        <a href={dyn.signup} target="_blank" rel="noreferrer" className="dns-link">{t('Open {name}', { name: dyn.label })} <ExternalLink size={12} /></a>
        <Field label="Name" hint={dyn.suffix ? t('Only the first part is enough – .{suffix} is added', { suffix: dyn.suffix }) : 'The full name, e.g. myserver.mooo.com'}>
          <div className="row-tight"><input className="input mono grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="myserver" aria-label="Name" />{dyn.suffix && <span className="mono muted small">.{dyn.suffix}</span>}</div>
        </Field>
        <CredFields fields={dyn.fields} creds={creds} setCreds={setCreds} />
        <div className="row-tight dns-wrap">
          <label className="check"><Switch checked={v4} onChange={setV4} /> IPv4 (A)</label>
          {dyn.ipv6 && <label className="check"><Switch checked={v6} onChange={setV6} /> IPv6 (AAAA)</label>}
        </div>
        {dyn.records && <label className="check"><Switch checked={alsoRecords} onChange={setAlsoRecords} /> Also manage its records here (TXT, CNAME, MX, SRV …)</label>}
      </div>
    );
    footer = <>{back('free')}<Btn className="primary" icon={CheckCircle2} disabled={!name.trim() || missingCreds(dyn.fields, creds)} onClick={saveFree}>Set up name</Btn></>;
  } else if (step === 'domain') {
    body = (
      <div className="stack">
        <p className="small muted">Pick the provider where the DNS of your domain is run (often the one you bought it from). The DNS itself is free with all of them – the domain costs money at the registrar.</p>
        {data.providers.map((x) => (
          <button key={x.id} type="button" className="list-item dns-pick" onClick={() => { setKind(x.id); setCreds({}); setStep('domain-form'); }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-tight"><b>{x.label}</b>{x.cost && x.cost.dnsFree && <span className="badge ok">DNS free</span>}{x.dnssec && <span className="badge">DNSSEC</span>}</div>
              {x.cost && <div className="small muted">{x.cost.note}</div>}
            </div>
          </button>
        ))}
      </div>
    );
    footer = <>{back('choose')}<Btn onClick={onClose}>Cancel</Btn></>;
  } else if (step === 'domain-form' && prov) {
    body = (
      <div className="stack">
        <Callout kind="info" dismissible={false}><span>{prov.help}</span>{' '}<a href={prov.url} target="_blank" rel="noreferrer" className="dns-link">Open the provider page <ExternalLink size={12} /></a></Callout>
        <CredFields fields={prov.fields} creds={creds} setCreds={setCreds} />
      </div>
    );
    footer = <>{back('domain')}<Btn className="primary" icon={KeyRound} disabled={missingCreds(prov.fields, creds)} onClick={saveAccount}>Check and save</Btn></>;
  } else if (step === 'domain-name') {
    body = !zones.data ? <Loading /> : !myZones.length ? <Callout kind="warn" dismissible={false}>The account has no domains (or the key may not read them).</Callout> : (
      <div className="stack">
        <p className="small muted">Optional: let one name of your domain always point to this connection – Hostwerk updates it when your address changes.</p>
        <div className="grid grid-2">
          <Field label="Domain"><select className="select" value={zone.id} onChange={(e) => setZoneId(e.target.value)}>{myZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></Field>
          <Field label="Name" hint={`@ = ${zone.name}`}><input className="input mono" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="home" /></Field>
        </div>
        <div className="row-tight dns-wrap">
          <label className="check"><Switch checked={v4} onChange={setV4} /> IPv4 (A)</label>
          <label className="check"><Switch checked={v6} onChange={setV6} /> IPv6 (AAAA)</label>
        </div>
      </div>
    );
    footer = <><Btn onClick={onClose}>Not now</Btn>{zone && <Btn className="primary" icon={CheckCircle2} onClick={saveZoneName}>{t('Point {name} here', { name: full(sub.trim(), zone.name) })}</Btn>}</>;
  }
  return <Modal title="Set up a name" subtitle="Free names and your own domain" onClose={onClose} footer={footer}>{body}</Modal>;
}

/* ---------------- Namen ändern / Protokoll ---------------- */
function NameForm({ host, dyn, onClose, onSaved }) {
  const d = dyn.find((x) => x.id === host.kind);
  const [creds, setCreds] = useState(() => Object.fromEntries(((d && d.fields) || []).filter((f) => !f.secret).map((f) => [f.key, host.fields[f.key] || ''])));
  const [v4, setV4] = useState(host.v4);
  const [v6, setV6] = useState(host.v6);
  const [ttl, setTtl] = useState(host.ttl || 300);
  const save = async () => {
    try { await put(`/dns/names/${enc(host.id)}`, { creds, v4, v6, ttl }); toast.success(t('Saved')); onSaved(); onClose(); } catch (e) { toast.error(e); }
  };
  return (
    <Modal title={host.name} subtitle={host.label} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" onClick={save}>Save</Btn></>}>
      <div className="stack">
        {d && <CredFields fields={d.fields} creds={creds} setCreds={setCreds} stored={host.fields} />}
        <div className="row-tight dns-wrap">
          <label className="check"><Switch checked={v4} onChange={setV4} /> IPv4 (A)</label>
          {(!d || d.ipv6) && <label className="check"><Switch checked={v6} onChange={setV6} /> IPv6 (AAAA)</label>}
        </div>
        {host.kind === 'zone' && <Field label="TTL" hint="Short, so a new address arrives quickly"><select className="select" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>{TTLS.slice(0, 3).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
      </div>
    </Modal>
  );
}

function NameLog({ host, onClose }) {
  return (
    <Modal title={t('History of {name}', { name: host.name })} onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      {!host.log.length ? <div className="small muted">Nothing has changed yet.</div> : (
        <div className="stack">
          {host.log.map((e) => (
            <div key={`${e.t}-${e.text}`} className="list-item">
              {e.ok ? <CheckCircle2 size={16} className="c-ok" /> : <XCircle size={16} className="c-err" />}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small"><b>{new Date(e.t).toLocaleString()}</b> · {t(e.text)}</div>
                <div className="tiny muted mono ellipsis">{[e.ip4, e.ip6].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Namen (dynamisch) ---------------- */
function NameState({ h }) {
  if (h.state.blocked) return <span className="badge err">needs you</span>;
  if (h.state.error) return <span className="badge warn" title={h.state.nextTry ? t('Next try {when}', { when: new Date(h.state.nextTry).toLocaleTimeString() }) : undefined}>retrying</span>;
  if (!h.state.t) return <span className="badge">waiting</span>;
  return <span className="badge ok">up to date</span>;
}

export function NamesPanel({ data, compact = false, onWizard }) {
  const n = useApi('/dns/names', [], { live: false, poll: true });
  const [edit, setEdit] = useState(null);
  const [log, setLog] = useState(null);
  if (!n.data) return n.error ? <Callout kind="err">{n.error}</Callout> : <Loading />;
  const { hosts, ip, router } = n.data;
  const reload = () => n.reload({ silent: true });
  const updateNow = async (h) => { try { const r = await post(`/dns/names/${enc(h.id)}/update`); if (r.error) toast.error(r.error); else toast.success(t('{name} is up to date.', { name: h.name })); reload(); } catch (e) { toast.error(e); } };
  const check = async (h) => {
    try {
      const c = await post(`/dns/names/${enc(h.id)}/check`);
      if (c.ok) toast.success(t('{name} points to this connection everywhere.', { name: h.name }));
      else toast.error(t('{name} does not point here everywhere yet – changes can take a few minutes.', { name: h.name }));
      reload();
    } catch (e) { toast.error(e); }
  };
  const remove = async (h) => {
    if (!(await confirmDialog({ title: t('Stop updating “{name}”?', { name: h.name }), text: 'Hostwerk forgets the name and its token. The name itself stays at the provider.', confirm: 'Stop updating', danger: true }))) return;
    try { await del(`/dns/names/${enc(h.id)}`); reload(); } catch (e) { toast.error(e); }
  };
  const takeOver = async () => { try { const r = await post('/dns/names-router/take-over'); toast.success(t('{name} is now kept up to date here.', { name: r.host.name })); reload(); } catch (e) { toast.error(e); } };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><RouterIcon size={16} /><h3>This connection</h3><InfoTip pop title="This connection">The address the internet sees. Hostwerk asks several services (no account needed) and only trusts an address two of them agree on. For IPv6 it uses this PC’s fixed address, not the changing privacy address.</InfoTip></div>
        <div className="card-body dns-addr">
          <div><span className="tiny muted">IPv4</span><code className="mono">{ip && ip.v4 ? ip.v4 : '–'}</code></div>
          <div><span className="tiny muted">IPv6</span><code className="mono ellipsis">{ip && ip.v6 ? ip.v6 : '–'}</code></div>
          {ip && !ip.v6 && ip.v6Local && <div className="small muted">IPv6 is not reachable from outside – AAAA records stay as they are.</div>}
          {ip && ip.t && <div className="tiny muted">{t('Checked {when}', { when: ago(ip.t) })}</div>}
        </div>
      </div>
      {router && (
        <Callout kind="info" dismissible={false}>
          <span>{t('“Router & port forwarding” keeps {name} up to date.', { name: router.name })}</span>{' '}
          {router.canTakeOver && <Btn className="sm" onClick={takeOver}>Keep it up to date here</Btn>}
        </Callout>
      )}
      <div className="card">
        <div className="card-head"><Clock size={16} /><h3>Names that follow this connection</h3><InfoTip pop title="Maintenance-free">Every 5 minutes Hostwerk checks the address and updates a name only when it changed. Every 6 hours it checks that the world really sees this connection. Problems come as one notification; a provider that is down is retried with growing pauses.</InfoTip>
          {onWizard && <div className="right"><Btn className="xs ghost" icon={Plus} onClick={onWizard}>Set up a name</Btn></div>}
        </div>
        {!hosts.length ? (
          <Empty icon={Gift} title="No name yet" text="A name like myserver.duckdns.org is free and finds this PC even when the address changes." action={onWizard ? <Btn className="primary" icon={Plus} onClick={onWizard}>Set up a name</Btn> : <a className="btn primary" href="#/ext/dns">Set up a name</a>} />
        ) : hosts.map((h) => (
          <div key={h.id} className="list-item">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-tight dns-wrap"><b className="mono ellipsis">{h.name}</b><span className="badge">{h.kind === 'zone' ? t('own domain') : h.label}</span><NameState h={h} />{h.maintenance === 'monthly' && <span className="badge warn" title={t('No-IP deletes free hostnames that are not confirmed every 30 days.')}>confirm every 30 days</span>}</div>
              <div className="small muted ellipsis">{h.state.error ? t(h.state.error) : [h.state.ip4, h.state.ip6].filter(Boolean).join(' · ') || t('not set yet')}{h.state.t ? ` · ${ago(h.state.t)}` : ''}{h.state.check ? ` · ${h.state.check.ok ? t('seen everywhere') : t('not seen everywhere yet')}` : ''}</div>
            </div>
            <Btn className="xs ghost icon" icon={RefreshCw} title="Update now" aria-label="Update now" onClick={() => updateNow(h)} />
            {!compact && <Btn className="xs ghost icon" icon={CheckCircle2} title="Check whether it points here" aria-label="Check whether it points here" onClick={() => check(h)} />}
            <Btn className="xs ghost icon" icon={History} title="History" aria-label="History" onClick={() => setLog(h)} />
            {!compact && <Btn className="xs ghost icon" icon={Pencil} title="Change" aria-label="Change" onClick={() => setEdit(h)} />}
            {!compact && <Btn className="xs ghost icon" icon={Trash2} title="Stop updating" aria-label="Stop updating" onClick={() => remove(h)} />}
          </div>
        ))}
      </div>
      {edit && <NameForm host={edit} dyn={data.dyn} onClose={() => setEdit(null)} onSaved={reload} />}
      {log && <NameLog host={log} onClose={() => setLog(null)} />}
    </div>
  );
}

/* ---------------- Eintrag anlegen / ändern ---------------- */
function RecordForm({ zone, record, proxy, onClose, onSaved }) {
  const isNew = !record;
  const [f, setF] = useState(() => (record ? { ...record, name: rel(record.name, zone.name) } : { name: '@', type: 'A', content: '', ttl: 3600, priority: '' }));
  const set = (k, v) => setF({ ...f, [k]: v });
  const prio = f.type === 'MX' || f.type === 'SRV';
  const own = async () => {
    try {
      const a = await get('/dns/public-address');
      const ip = f.type === 'AAAA' ? a.v6 : a.v4;
      if (ip) set('content', ip); else toast.error(t(f.type === 'AAAA' ? 'No public IPv6 address found.' : 'No public IPv4 address found.'));
    } catch (e) { toast.error(e); }
  };
  const save = async () => {
    const body = { name: f.name, type: f.type, content: f.content, ttl: Number(f.ttl), ...(prio ? { priority: f.priority === '' ? undefined : Number(f.priority) } : {}), ...(proxy && ['A', 'AAAA', 'CNAME'].includes(f.type) ? { proxied: !!f.proxied } : {}) };
    try {
      const base = `${zoneBase(zone)}/records`;
      if (isNew) await post(base, body); else await put(`${base}/${enc(record.id)}`, body);
      toast.success('Saved – the change can take a few minutes to show up everywhere.');
      onSaved(); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title={isNew ? 'New record' : 'Change record'} subtitle={zone.name} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" disabled={!f.content} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Name" hint={`@ = ${zone.name}`}><input className="input mono" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="www" /></Field>
          <Field label="Type"><select className="select" value={f.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
        </div>
        <Field label="Value" hint={HINT[f.type]}>
          <div className="row-tight">
            {f.type === 'TXT' ? <textarea className="input mono grow" rows={3} value={f.content} onChange={(e) => set('content', e.target.value)} aria-label="Value" /> : <input className="input mono grow" value={f.content} onChange={(e) => set('content', e.target.value)} aria-label="Value" />}
            {(f.type === 'A' || f.type === 'AAAA') && <Btn className="sm" icon={RouterIcon} title="Public address of this connection" onClick={own}>This connection</Btn>}
          </div>
        </Field>
        <div className="grid grid-2">
          {prio && <Field label="Priority" hint="Lower = preferred"><input className="input" inputMode="numeric" value={f.priority} onChange={(e) => set('priority', e.target.value)} placeholder={f.type === 'MX' ? '10' : '0'} /></Field>}
          <Field label="TTL" hint="How long resolvers keep the answer"><select className="select" value={f.ttl} onChange={(e) => set('ttl', Number(e.target.value))}>{TTLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}{!TTLS.some(([v]) => v === Number(f.ttl)) && <option value={f.ttl}>{ttlText(Number(f.ttl))}</option>}</select></Field>
        </div>
        {proxy && ['A', 'AAAA', 'CNAME'].includes(f.type) && (
          <label className="check"><Switch checked={!!f.proxied} onChange={(v) => set('proxied', v)} /> Through the Cloudflare proxy <InfoTip inline title="Cloudflare proxy">Visitors reach Cloudflare instead of this PC. Only works for websites (HTTP/HTTPS) – leave it off for Minecraft, mail and everything else.</InfoTip></label>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- Vorlagen ---------------- */
const TEMPLATES = [
  { id: 'web', label: 'Website (with and without www)', icon: Globe },
  { id: 'site', label: 'Name for a Hostwerk web server', icon: Server },
  { id: 'mc', label: 'Minecraft server (SRV)', icon: Gamepad2 },
  { id: 'mail', label: 'Mail basics (MX, SPF, DMARC)', icon: Mail },
  { id: 'caa', label: 'Only Let’s Encrypt may issue certificates (CAA)', icon: ShieldCheck },
];

/** Einträge einer Vorlage – A/AAAA ersetzen die alte Adresse, alles andere kommt ohne Doppelte dazu. */
function templateRecords(tpl, z, o, ip) {
  const addr = (name) => [ip.v4 && { name, type: 'A', content: ip.v4, ttl: 300, replace: 'type' }, ip.v6 && { name, type: 'AAAA', content: ip.v6, ttl: 300, replace: 'type' }].filter(Boolean);
  switch (tpl) {
    case 'web': return [...addr(z), { name: `www.${z}`, type: 'CNAME', content: z, ttl: 3600 }];
    case 'site': return o.site ? addr(o.site) : [];
    case 'mc': {
      const host = full(o.sub || 'mc', z);
      const port = Number(o.port) || 25565;
      return [...addr(host), ...(port !== 25565 ? [{ name: `_minecraft._tcp.${host}`, type: 'SRV', priority: 0, content: `5 ${port} ${host}`, ttl: 3600, replace: 'type' }] : [])];
    }
    case 'mail': return [{ name: z, type: 'MX', content: `mail.${z}`, priority: 10, ttl: 3600 }, ...addr(`mail.${z}`), { name: z, type: 'TXT', content: 'v=spf1 mx -all', ttl: 3600 }, { name: `_dmarc.${z}`, type: 'TXT', content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${z}`, ttl: 3600 }];
    case 'caa': return [{ name: z, type: 'CAA', content: '0 issue "letsencrypt.org"', ttl: 3600 }, { name: z, type: 'CAA', content: '0 issuewild "letsencrypt.org"', ttl: 3600 }];
    default: return [];
  }
}

export function TemplateDialog({ zones, zone: zone0, start = 'web', preset = {}, onClose, onApplied }) {
  const [tpl, setTpl] = useState(start);
  const [zoneKey, setZoneKey] = useState(zone0 ? `${zone0.account}/${zone0.id}` : zones[0] ? `${zones[0].account}/${zones[0].id}` : '');
  const zone = zones.find((z) => `${z.account}/${z.id}` === zoneKey) || null;
  const [o, setO] = useState({ sub: 'mc', port: 25565, ...preset });
  const ip = useApi('/dns/public-address', [], { live: false, poll: false });
  const sites = useApi(tpl === 'site' ? '/dns/sites' : null, [tpl], { live: false, poll: false });
  const mySites = ((sites.data || [])).filter((s) => zone && s.zone && s.zone.id === zone.id && s.zone.account === zone.account);
  useEffect(() => { if (tpl === 'site' && !o.site && mySites[0]) setO({ ...o, site: mySites[0].domain }); }, [tpl, mySites.length]); // eslint-disable-line react-hooks/exhaustive-deps -- erste Adresse vorschlagen
  const recs = zone && ip.data ? templateRecords(tpl, zone.name, o, ip.data) : [];
  const apply = async () => {
    try {
      const res = await post('/dns/apply', { records: recs });
      const bad = res.filter((r) => r.action === 'error');
      if (bad.length) toast.error(bad.map((r) => r.error).join(' · '));
      else toast.success(pl(res.filter((r) => r.action !== 'unchanged').length, '1 record set', '{n} records set'));
      onApplied(); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title="Templates" subtitle={zone ? zone.name : ''} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Wand2} disabled={!recs.length} onClick={apply}>{pl(recs.length, 'Set 1 record', 'Set {n} records')}</Btn></>}>
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Template"><select className="select" value={tpl} onChange={(e) => setTpl(e.target.value)}>{TEMPLATES.map((x) => <option key={x.id} value={x.id}>{t(x.label)}</option>)}</select></Field>
          <Field label="Domain"><select className="select" value={zoneKey} onChange={(e) => setZoneKey(e.target.value)}>{zones.map((z) => <option key={`${z.account}/${z.id}`} value={`${z.account}/${z.id}`}>{z.name}</option>)}</select></Field>
        </div>
        {tpl === 'site' && (sites.data && !mySites.length ? <div className="small muted">No web server in Hostwerk uses a name in this domain yet (Web servers → address).</div> : (
          <Field label="Address of the web server"><select className="select" value={o.site || ''} onChange={(e) => setO({ ...o, site: e.target.value })}>{mySites.map((s) => <option key={s.domain} value={s.domain}>{`${s.domain} (${s.web})`}</option>)}</select></Field>
        ))}
        {tpl === 'mc' && (
          <div className="grid grid-2">
            <Field label="Name" hint={zone ? `${o.sub || 'mc'}.${zone.name}` : ''}><input className="input mono" value={o.sub} onChange={(e) => setO({ ...o, sub: e.target.value })} /></Field>
            <Field label="Port" hint="Not 25565? Then a SRV record lets players leave out the port."><input className="input" inputMode="numeric" value={o.port} onChange={(e) => setO({ ...o, port: e.target.value })} /></Field>
          </div>
        )}
        {tpl === 'mail' && <div className="small muted">DKIM needs the key of your mail server – with the extension “Mail server” use “Mail server records” under Providers.</div>}
        {ip.data && !ip.data.v4 && !ip.data.v6 && ['web', 'site', 'mc', 'mail'].includes(tpl) && <Callout kind="warn" dismissible={false}>The public address of this connection is unknown right now.</Callout>}
        {recs.length > 0 && (
          <div className="dns-preview">
            {recs.map((r) => <code key={`${r.type}:${r.name}:${r.content}`} className="tiny ellipsis">{`${r.type.padEnd(5)} ${zone ? rel(r.name, zone.name) : r.name}  ${r.priority !== undefined ? `${r.priority} ` : ''}${r.content}`}</code>)}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- Zonendatei ---------------- */
function ImportDialog({ zone, onClose, onDone }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const pick = (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { setText(String(r.result || '')); setPreview(null); }; r.readAsText(f); };
  const check = async () => { try { setPreview(await post(`${zoneBase(zone)}/import`, { text })); } catch (e) { toast.error(e); } };
  const apply = async () => {
    try {
      const r = await post(`${zoneBase(zone)}/import`, { text, apply: true });
      const bad = (r.done || []).filter((x) => x.action === 'error');
      if (bad.length) toast.error(bad.map((x) => x.error).join(' · ')); else toast.success(pl((r.done || []).length, '1 record set', '{n} records set'));
      onDone(); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title="Import zone file" subtitle={zone.name} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn>{preview ? <Btn className="primary" icon={Upload} disabled={!preview.add.length} onClick={apply}>{pl(preview.add.length, 'Add 1 record', 'Add {n} records')}</Btn> : <Btn className="primary" disabled={!text.trim()} onClick={check}>Check</Btn>}</>}>
      <div className="stack">
        <div className="small muted">A zone file (BIND format) from your old provider. Hostwerk only adds what is missing – nothing is deleted or overwritten. SOA and NS are left to the provider.</div>
        <input type="file" accept=".zone,.txt,.db,text/plain" onChange={pick} aria-label="Zone file" />
        <textarea className="input mono" rows={8} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder="$ORIGIN example.com." aria-label="Zone file text" />
        {preview && (
          <div className="stack">
            <div className="small"><b>{pl(preview.add.length, '1 new record', '{n} new records')}</b> · {pl(preview.same, '1 already there', '{n} already there')}</div>
            {preview.add.length > 0 && <div className="dns-preview">{preview.add.map((r) => <code key={`${r.type}:${r.name}:${r.content}`} className="tiny ellipsis">{`${r.type.padEnd(5)} ${rel(r.name, zone.name)}  ${r.priority !== undefined ? `${r.priority} ` : ''}${r.content}`}</code>)}</div>}
            {preview.errors.map((e) => <div key={e.line} className="small c-err">{t('Line {line}: {text}', { line: e.line, text: t(e.text) })}</div>)}
          </div>
        )}
      </div>
    </Modal>
  );
}
const exportZone = async (zone) => {
  try {
    const r = await get(`${zoneBase(zone)}/export`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.text], { type: 'text/plain' }));
    a.download = r.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast.error(e); }
};

/* ---------------- DNSSEC ---------------- */
const SEC = {
  secure: { icon: ShieldCheck, cls: 'ok', label: 'DNSSEC on', text: 'Signed and confirmed by the parent zone – resolvers can check every answer.' },
  'no-ds': { icon: ShieldAlert, cls: 'warn', label: 'DNSSEC: DS missing', text: 'Your DNS provider signs the zone, but the DS record is missing at the registrar where you bought the domain. Enter it there.' },
  unsigned: { icon: Shield, cls: '', label: 'no DNSSEC', text: 'The zone is not signed. That is common and works – DNSSEC adds protection against forged answers.' },
  broken: { icon: ShieldAlert, cls: 'err', label: 'DNSSEC broken', text: 'Checking resolvers reject the answers – names in this zone cannot be reached! Usually an old DS record at the registrar after moving provider: remove or replace it.' },
  unknown: { icon: Shield, cls: '', label: 'DNSSEC unknown', text: 'The check could not reach a resolver.' },
};
function DnssecBadge({ zone }) {
  const s = useApi(`${zoneBase(zone)}/dnssec`, [], { live: false, poll: false });
  const [open, setOpen] = useState(false);
  if (!s.data) return null;
  const x = SEC[s.data.status] || SEC.unknown;
  const ds = s.data.providerDs || [];
  return (
    <>
      <button type="button" className={`badge dns-sec ${x.cls}`} onClick={() => setOpen(true)} title={t(x.text)}><x.icon size={12} /> {t(x.label)}</button>
      {open && (
        <Modal title={x.label} subtitle={zone.name} onClose={() => setOpen(false)} footer={<Btn onClick={() => setOpen(false)}>Close</Btn>}>
          <div className="stack">
            <p className="small">{t(x.text)}</p>
            {s.data.status !== 'secure' && ds.length > 0 && (
              <>
                <div className="small"><b>DS records for your registrar</b></div>
                {ds.map((d) => <div key={d} className="row-tight"><code className="tiny ellipsis grow">{d}</code><Btn className="xs ghost icon" icon={Copy} title="Copy" aria-label="Copy" onClick={() => copy(d)} /></div>)}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ---------------- Ergebnis von „Prüfen“ ---------------- */
function VerifyResult({ rec, result, onClose }) {
  return (
    <Modal title={result.ok ? 'Visible everywhere' : result.some ? 'Not visible everywhere yet' : 'Not visible yet'} subtitle={`${rec.name} · ${rec.type}`} onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      <div className="stack">
        {result.results.map((r) => (
          <div key={r.resolver} className="list-item">
            {r.ok ? <CheckCircle2 size={16} className="c-ok" /> : <XCircle size={16} className="c-err" />}
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{r.authoritative ? t('Your provider ({name})', { name: r.label }) : r.label}</b>
              <div className="small muted mono ellipsis">{r.error ? t('No answer ({e})', { e: r.error }) : r.values.length ? r.values.join(' · ') : t('No record of this type')}</div>
            </div>
          </div>
        ))}
        {!result.ok && result.atProvider && <p className="small">Your provider already has the new value – the others still show the old answer until its TTL runs out.</p>}
        {!result.ok && !result.atProvider && <p className="small muted">Changes usually show up within minutes; with a long TTL the old answer can stay for up to that time.</p>}
      </div>
    </Modal>
  );
}

/* ---------------- Mailserver-Einträge ---------------- */
function MailRecords({ onApplied }) {
  const m = useApi('/dns/mail', [], { live: false, poll: false });
  if (!m.data) return m.error ? <div className="card-body"><Callout kind="err">{m.error}</Callout></div> : <div className="card-body"><Loading /></div>;
  const domains = m.data.servers.flatMap((s) => s.domains.map((d) => ({ ...d, server: s.name })));
  if (!domains.length) return <div className="card-body small muted">The mail server has no own domain yet.</div>;
  const apply = async (d) => {
    const res = await post('/dns/apply', { records: d.records.filter((r) => !r.present) });
    const bad = res.filter((r) => r.action === 'error');
    if (bad.length) toast.error(bad.map((r) => r.error).join(' · ')); else toast.success(pl(res.length, '1 record set', '{n} records set'));
    m.reload({ silent: true }); onApplied();
  };
  return (
    <div className="card-body stack">
      {domains.map((d) => {
        const open = d.records.filter((r) => !r.present).length;
        return (
          <div key={`${d.server}:${d.name}`} className="dns-domain">
            <div className="row-tight"><b>{d.name}</b><span className="tiny muted">{d.server}</span>
              <div className="right">{!d.zone ? <span className="badge warn">no DNS provider for this domain</span> : open ? <Btn className="sm primary" onClick={() => apply(d)}>{pl(open, 'Set 1 missing', 'Set {n} missing')}</Btn> : <span className="badge ok">all set</span>}</div>
            </div>
            {d.records.map((r) => (
              <div key={`${r.type}:${r.name}:${r.content}`} className="row-tight dns-mailrow">
                {r.present ? <CheckCircle2 size={14} className="c-ok" /> : <XCircle size={14} className="muted" />}
                <span className="small">{r.purpose}</span>
                <code className="tiny ellipsis grow" title={r.content}>{r.type} {r.name}</code>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Einträge ---------------- */
function RecordsPanel({ zs, onAddProvider }) {
  const [zoneKey, setZoneKey] = useState('');
  const zones = (zs.data && zs.data.zones) || [];
  const zone = zones.find((z) => `${z.account}/${z.id}` === zoneKey) || zones[0] || null;
  const recs = useApi(zone ? `${zoneBase(zone)}/records` : null, [], { live: false, poll: false });
  const [rec, setRec] = useState(undefined);
  const [check, setCheck] = useState(null);
  const [tpl, setTpl] = useState(false);
  const [imp, setImp] = useState(false);
  const [filter, setFilter] = useState('');
  useEffect(() => { if (zone && !zoneKey) setZoneKey(`${zone.account}/${zone.id}`); }, [zone, zoneKey]);
  const list = useMemo(() => { const q = filter.trim().toLowerCase(); const l = recs.data || []; return q ? l.filter((r) => `${r.name} ${r.type} ${r.content}`.toLowerCase().includes(q)) : l; }, [recs.data, filter]);
  const proxy = !!(zone && zone.provider === 'cloudflare');
  const removeRec = async (r) => {
    if (!(await confirmDialog({ title: t('Delete the {type} record “{name}”?', { type: r.type, name: rel(r.name, zone.name) }), text: r.content, confirm: 'Delete', danger: true }))) return;
    try { await del(`${zoneBase(zone)}/records/${enc(r.id)}`); recs.reload({ silent: true }); } catch (e) { toast.error(e); }
  };
  const verify = async (r) => { try { setCheck({ rec: r, result: await post('/dns/verify', r) }); } catch (e) { toast.error(e); } };
  if (!zs.data) return zs.error ? <Callout kind="err">{zs.error}</Callout> : <Loading />;
  if (!zone) return <div className="card"><Empty icon={Globe} title="No zones" text="Connect the provider of your domain – or a deSEC name – to edit records here." action={<Btn className="primary" icon={Plus} onClick={onAddProvider}>Add provider</Btn>} /></div>;
  return (
    <div className="card">
      <div className="card-head dns-wrap">
        <ListChecks size={16} /><h3>Records</h3>
        <select className="select dns-zone" aria-label="Zone" value={`${zone.account}/${zone.id}`} onChange={(e) => setZoneKey(e.target.value)}>{zones.map((z) => <option key={`${z.account}/${z.id}`} value={`${z.account}/${z.id}`}>{z.name}</option>)}</select>
        <DnssecBadge key={`${zone.account}/${zone.id}`} zone={zone} />
        <div className="right row-tight">
          <Btn className="xs ghost" icon={Wand2} onClick={() => setTpl(true)}>Templates</Btn>
          <Btn className="xs ghost icon" icon={Upload} title="Import zone file" aria-label="Import zone file" onClick={() => setImp(true)} />
          <Btn className="xs ghost icon" icon={Download} title="Export zone file" aria-label="Export zone file" onClick={() => exportZone(zone)} />
          <Btn className="xs ghost icon" icon={RefreshCw} title="Reload" aria-label="Reload" onClick={() => { zs.reload(); recs.reload(); }} />
          <Btn className="xs primary" icon={Plus} onClick={() => setRec(null)}>New record</Btn>
        </div>
      </div>
      {recs.error ? <div className="card-body"><Callout kind="err">{recs.error}</Callout></div>
        : !recs.data ? <div className="card-body"><Loading /></div> : (
          <>
            <div className="card-body dns-filter"><input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, type or value" aria-label="Filter" /></div>
            {!list.length ? <div className="card-body small muted">{filter ? 'Nothing matches the filter.' : 'This zone has no records yet.'}</div> : (
              <div className="dns-table-wrap">
                <table className="table dns-table">
                  <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>TTL</th><th><span className="dns-sr">Actions</span></th></tr></thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{rel(r.name, zone.name)}</td>
                        <td><span className="badge">{r.type}</span>{r.proxied && <span className="badge accent">proxy</span>}</td>
                        <td className="mono dns-value" title={r.content}>{r.priority !== undefined ? `${r.priority} ` : ''}{r.content}</td>
                        <td className="small muted">{ttlText(r.ttl)}</td>
                        <td className="dns-actions">
                          <Btn className="xs ghost icon" icon={CheckCircle2} title="Check" aria-label="Check" onClick={() => verify(r)} />
                          <Btn className="xs ghost icon" icon={Pencil} title="Change" aria-label="Change" onClick={() => setRec(r)} />
                          <Btn className="xs ghost icon" icon={Trash2} title="Delete" aria-label="Delete" onClick={() => removeRec(r)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      {rec !== undefined && <RecordForm zone={zone} record={rec} proxy={proxy} onClose={() => setRec(undefined)} onSaved={() => recs.reload({ silent: true })} />}
      {check && <VerifyResult rec={check.rec} result={check.result} onClose={() => setCheck(null)} />}
      {tpl && <TemplateDialog zones={zones} zone={zone} onClose={() => setTpl(false)} onApplied={() => recs.reload({ silent: true })} />}
      {imp && <ImportDialog zone={zone} onClose={() => setImp(false)} onDone={() => recs.reload({ silent: true })} />}
    </div>
  );
}

/* ---------------- Anbieter ---------------- */
function ProvidersPanel({ ov, zs, onAdd, onEdit }) {
  const { accounts } = ov.data;
  const removeAcc = async (a) => {
    if (!(await confirmDialog({ title: t('Remove “{name}”?', { name: a.name }), text: 'Only the access in Hostwerk is removed – the domains and records at the provider stay.', confirm: 'Remove', danger: true }))) return;
    try { await del(`/dns/accounts/${enc(a.id)}`); ov.reload({ silent: true }); zs.reload({ silent: true }); } catch (e) { toast.error(e); }
  };
  return (
    <div className="dns-grid">
      <div className="card">
        <div className="card-head"><Server size={16} /><h3>Providers</h3><div className="right"><Btn className="xs ghost" icon={Plus} onClick={onAdd}>Add provider</Btn></div></div>
        {!accounts.length ? <Empty icon={Server} title="No DNS provider yet" text="Connect Cloudflare, deSEC, Hetzner, INWX or IONOS – Hostwerk then lists your domains and their records." action={<Btn className="primary" icon={Plus} onClick={onAdd}>Add provider</Btn>} /> : accounts.map((a) => (
          <div key={a.id} className="list-item">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-tight"><b className="ellipsis">{a.name}</b><span className="badge">{a.providerLabel}</span></div>
              <div className="small muted">{a.zones === null ? '' : pl(a.zones, '1 zone', '{n} zones')}</div>
            </div>
            <Btn className="xs ghost icon" icon={Pencil} title="Change" aria-label="Change" onClick={() => onEdit(a)} />
            <Btn className="xs ghost icon" icon={Trash2} title="Remove" aria-label="Remove" onClick={() => removeAcc(a)} />
          </div>
        ))}
        {zs.data && zs.data.errors.map((e) => <div key={e.account} className="card-body"><Callout kind="warn">{`${e.name}: ${t(e.error)}`}</Callout></div>)}
      </div>
      {ov.data.mail && (
        <div className="card">
          <div className="card-head"><Mail size={16} /><h3>Mail server records</h3><InfoTip pop title="Mail server records">MX, SPF, DKIM and DMARC from the extension “Mail server”. Records that are missing at your provider are set with one click; existing SPF/DMARC records are replaced, nothing else is touched.</InfoTip></div>
          <MailRecords onApplied={() => zs.reload({ silent: true })} />
        </div>
      )}
    </div>
  );
}

/* ---------------- Seite ---------------- */
function DnsPage() {
  const ov = useApi('/dns', [], { live: false });
  const hasAccounts = !!(ov.data && ov.data.accounts.length);
  const zs = useApi(hasAccounts ? '/dns/zones' : null, [hasAccounts], { live: false, poll: false });
  const [tab, setTab] = useState(null);
  const [acc, setAcc] = useState(undefined);
  const [wizard, setWizard] = useState(false);
  if (!ov.data) return ov.error ? <div className="page"><Callout kind="err">{ov.error}</Callout></div> : <Loading />;
  const cur = tab || (hasAccounts ? 'records' : 'names');
  const reloadAll = () => { ov.reload({ silent: true }); zs.reload({ silent: true }); };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Globe /> DNS</h1>
          <p>Names for this connection – free or with your own domain – and all records at your provider, kept up to date by themselves.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={Server} onClick={() => setAcc(null)}>Add provider</Btn>
          <Btn className="sm primary" icon={Wand2} onClick={() => setWizard(true)}>Set up a name</Btn>
        </div>
      </div>
      <Tabs value={cur} onChange={setTab} tabs={[{ id: 'names', label: t('Names'), icon: Clock }, { id: 'records', label: t('Records'), icon: ListChecks }, { id: 'providers', label: t('Providers'), icon: Server }]} />
      <div>
        {cur === 'names' && <NamesPanel data={ov.data} onWizard={() => setWizard(true)} />}
        {cur === 'records' && (hasAccounts ? <RecordsPanel zs={zs} onAddProvider={() => setAcc(null)} /> : <div className="card"><Empty icon={Globe} title="No DNS provider yet" text="Connect Cloudflare, deSEC, Hetzner, INWX or IONOS – Hostwerk then lists your domains and their records." action={<Btn className="primary" icon={Plus} onClick={() => setAcc(null)}>Add provider</Btn>} /></div>)}
        {cur === 'providers' && <ProvidersPanel ov={ov} zs={zs} onAdd={() => setAcc(null)} onEdit={setAcc} />}
      </div>
      {acc !== undefined && <AccountForm providers={ov.data.providers} account={acc} onClose={() => setAcc(undefined)} onSaved={reloadAll} />}
      {wizard && <Wizard data={ov.data} onClose={() => setWizard(false)} onDone={reloadAll} />}
    </div>
  );
}

/* ---------------- Einbau: Livebetrieb → DNS ---------------- */
function SitesCard() {
  const s = useApi('/dns/sites', [], { live: false, poll: false });
  const zs = useApi('/dns/zones', [], { live: false, poll: false });
  const [tpl, setTpl] = useState(null);
  if (!s.data || !s.data.length) return null;
  const zones = (zs.data && zs.data.zones) || [];
  return (
    <div className="card">
      <div className="card-head"><Server size={16} /><h3>Domains of your web servers</h3><InfoTip pop title="Domains of your web servers">The addresses you gave your web servers. Where the domain is connected here, one click points it to this connection (A/AAAA).</InfoTip></div>
      {s.data.map((x) => (
        <div key={x.domain} className="list-item">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row-tight"><b className="mono ellipsis">{x.domain}</b><span className="tiny muted">{x.web}</span></div>
            {!x.zone && <div className="small muted">No DNS provider for this domain is connected.</div>}
          </div>
          {x.zone && !x.domain.startsWith('*.') && <Btn className="xs" icon={Plus} onClick={() => setTpl(x)}>Create DNS record</Btn>}
        </div>
      ))}
      {tpl && zones.length > 0 && <TemplateDialog zones={zones} zone={zones.find((z) => z.id === tpl.zone.id && z.account === tpl.zone.account)} start="site" preset={{ site: tpl.domain }} onClose={() => setTpl(null)} onApplied={() => {}} />}
    </div>
  );
}

function LiveDnsTab() {
  const ov = useApi('/dns', [], { live: false });
  if (!ov.data) return ov.error ? <Callout kind="err">{ov.error}</Callout> : <Loading />;
  return (
    <div className="stack">
      <div className="row-tight dns-wrap">
        <span className="small muted grow">Names that follow this connection and the DNS of your domains – the full management is on the DNS page.</span>
        <a className="btn sm" href="#/ext/dns"><Globe size={14} /> Open DNS</a>
      </div>
      <NamesPanel data={ov.data} compact onWizard={() => { location.hash = '/ext/dns'; }} />
      {ov.data.accounts.length > 0 && ov.data.web && <SitesCard />}
    </div>
  );
}

/* ---------------- Einbau: Minecraft → eigene Adresse ---------------- */
function McAddress({ s }) {
  const n = useApi('/dns/names', [], { live: false, poll: false });
  const ov = useApi('/dns', [], { live: false, poll: false });
  const hasAccounts = !!(ov.data && ov.data.accounts.length);
  const zs = useApi(hasAccounts ? '/dns/zones' : null, [hasAccounts], { live: false, poll: false });
  const [open, setOpen] = useState(false);
  const hosts = ((n.data && n.data.hosts) || []).filter((h) => h.state.t && !h.state.error);
  const zones = (zs.data && zs.data.zones) || [];
  if (!hosts.length && !zones.length) return null;
  const addr = hosts[0] ? `${hosts[0].name}${s.port === 25565 ? '' : `:${s.port}`}` : null;
  return (
    <div className="row-tight dns-wrap">
      {addr && <><code className="grow ellipsis">{addr}</code><Btn className="xs ghost icon" icon={Copy} title="Copy" aria-label="Copy" onClick={() => copy(addr)} /></>}
      {zones.length > 0 && <Btn className="xs" icon={Gamepad2} onClick={() => setOpen(true)}>Own address</Btn>}
      {open && <TemplateDialog zones={zones} start="mc" preset={{ sub: 'mc', port: s.port }} onClose={() => setOpen(false)} onApplied={() => {}} />}
    </div>
  );
}

export default {
  pages: { main: DnsPage },
  slots: {
    // Livebetrieb: direkt hinter „Domains & HTTPS“, Gruppe „Erreichbar machen“
    'live.tabs': [{ id: 'dns', title: 'DNS', icon: Globe, Component: LiveDnsTab, after: 'domains', group: 'erreichbar', order: 25 }],
    'mc.connect': [{ id: 'dns-name', title: 'Own address', Component: McAddress, order: 45 }],
  },
};

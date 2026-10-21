import { useEffect, useMemo, useState } from 'react';
import { Globe, Plus, Pencil, Trash2, RefreshCw, CheckCircle2, XCircle, Mail, KeyRound, ExternalLink, Router as RouterIcon, ListChecks, Server } from 'lucide-react';
import { get, post, put, del, useApi } from '@hostwerk/api';
import { Btn, Field, Modal, Empty, Loading, Callout, InfoTip, Switch, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * DNS-Verwaltung: Anbieter-Zugänge, Einträge je Zone (anlegen, ändern, löschen, prüfen) und – wenn die Erweiterung
 * „Mailserver“ da ist – deren MX/SPF/DKIM/DMARC mit einem Klick eintragen.
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
// Einzahl/Mehrzahl – @hostwerk/i18n bietet nativen Modulen nur t(), kein pl()
const pl = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n, ...vars });
const ttlText = (n) => { const x = TTLS.find(([v]) => v === n); return x ? x[1] : n === 1 ? 'auto' : `${n} s`; };

/* ---------------- Zugang anlegen / ändern ---------------- */
function AccountForm({ providers, account, onClose, onSaved }) {
  const isNew = !account;
  const [provider, setProvider] = useState(account ? account.provider : providers[0].id);
  const p = providers.find((x) => x.id === provider);
  const [name, setName] = useState(account ? account.name : '');
  const [creds, setCreds] = useState(() => (account ? Object.fromEntries(p.fields.filter((f) => !f.secret).map((f) => [f.key, account.fields[f.key]])) : {}));
  const set = (k, v) => setCreds({ ...creds, [k]: v });
  const missing = p.fields.some((f) => f.required && !(creds[f.key] || (!isNew && f.secret && account.fields[f.key])));
  const save = async () => {
    try {
      const r = isNew ? await post('/dns/accounts', { provider, name, creds }) : await put(`/dns/accounts/${enc(account.id)}`, { name, creds });
      toast.success(pl(r.zones || 0, 'Connected – 1 zone found', 'Connected – {n} zones found'));
      onSaved(); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title={isNew ? 'Add DNS provider' : `Provider ${account.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={KeyRound} disabled={missing} onClick={save}>Check and save</Btn></>}>
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
        <Field label="Name in Hostwerk" hint="Optional, e.g. “Private domains”"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={p.label} /></Field>
        {p.fields.map((f) => (f.type === 'switch' ? (
          <label key={f.key} className="check"><Switch checked={!!creds[f.key]} onChange={(v) => set(f.key, v)} /> {f.label}</label>
        ) : f.type === 'select' ? (
          <Field key={f.key} label={f.label}><select className="select" value={creds[f.key] || f.default} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>
        ) : (
          <Field key={f.key} label={f.label} hint={f.secret && !isNew && account.fields[f.key] ? 'Stored encrypted – leave empty to keep it.' : f.secret ? 'Stored encrypted in Hostwerk and never shown again.' : ''}>
            <input className="input mono" type={f.secret ? 'password' : 'text'} autoComplete="off" value={creds[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
          </Field>
        )))}
      </div>
    </Modal>
  );
}

/* ---------------- Eintrag anlegen / ändern ---------------- */
function RecordForm({ zone, record, proxy, router, onClose, onSaved }) {
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
      const base = `/dns/zones/${enc(zone.account)}/${enc(zone.id)}/records`;
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
            {f.type === 'TXT' ? <textarea className="input mono grow" rows={3} value={f.content} onChange={(e) => set('content', e.target.value)} /> : <input className="input mono grow" value={f.content} onChange={(e) => set('content', e.target.value)} />}
            {router && (f.type === 'A' || f.type === 'AAAA') && <Btn className="sm" icon={RouterIcon} title="Public address of this connection (from “Router & port forwarding”)" onClick={own}>This connection</Btn>}
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

/* ---------------- Ergebnis von „Prüfen“ ---------------- */
function VerifyResult({ rec, result, onClose }) {
  return (
    <Modal title={result.ok ? 'Visible everywhere' : result.some ? 'Not visible everywhere yet' : 'Not visible yet'} subtitle={`${rec.name} · ${rec.type}`} onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      <div className="stack">
        {result.results.map((r) => (
          <div key={r.resolver} className="list-item">
            {r.ok ? <CheckCircle2 size={16} className="c-ok" /> : <XCircle size={16} className="c-err" />}
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{r.label}</b>
              <div className="small muted mono ellipsis">{r.error ? t('No answer ({e})', { e: r.error }) : r.values.length ? r.values.join(' · ') : t('No record of this type')}</div>
            </div>
          </div>
        ))}
        {!result.ok && <p className="small muted">Changes usually show up within minutes; with a long TTL the old answer can stay for up to that time.</p>}
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

/* ---------------- Seite ---------------- */
function DnsPage() {
  const ov = useApi('/dns', [], { live: false });
  const hasAccounts = !!(ov.data && ov.data.accounts.length);
  const zs = useApi(hasAccounts ? '/dns/zones' : null, [hasAccounts], { live: false, poll: false });
  const [zoneKey, setZoneKey] = useState('');
  const zones = (zs.data && zs.data.zones) || [];
  const zone = zones.find((z) => `${z.account}/${z.id}` === zoneKey) || zones[0] || null;
  const recs = useApi(zone ? `/dns/zones/${enc(zone.account)}/${enc(zone.id)}/records` : null, [], { live: false, poll: false });
  const [acc, setAcc] = useState(undefined);
  const [rec, setRec] = useState(undefined);
  const [check, setCheck] = useState(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { if (zone && !zoneKey) setZoneKey(`${zone.account}/${zone.id}`); }, [zone, zoneKey]);
  const list = useMemo(() => { const q = filter.trim().toLowerCase(); const l = recs.data || []; return q ? l.filter((r) => `${r.name} ${r.type} ${r.content}`.toLowerCase().includes(q)) : l; }, [recs.data, filter]);
  if (!ov.data) return ov.error ? <div className="page"><Callout kind="err">{ov.error}</Callout></div> : <Loading />;
  const { accounts, providers } = ov.data;
  const proxy = !!(zone && zone.provider === 'cloudflare');
  const reloadAll = () => { ov.reload({ silent: true }); zs.reload({ silent: true }); };
  const removeAcc = async (a) => {
    if (!(await confirmDialog({ title: t('Remove “{name}”?', { name: a.name }), text: 'Only the access in Hostwerk is removed – the domains and records at the provider stay.', confirm: 'Remove', danger: true }))) return;
    try { await del(`/dns/accounts/${enc(a.id)}`); reloadAll(); } catch (e) { toast.error(e); }
  };
  const removeRec = async (r) => {
    if (!(await confirmDialog({ title: t('Delete the {type} record “{name}”?', { type: r.type, name: rel(r.name, zone.name) }), text: r.content, confirm: 'Delete', danger: true }))) return;
    try { await del(`/dns/zones/${enc(zone.account)}/${enc(zone.id)}/records/${enc(r.id)}`); recs.reload({ silent: true }); } catch (e) { toast.error(e); }
  };
  const verify = async (r) => { try { setCheck({ rec: r, result: await post('/dns/verify', r) }); } catch (e) { toast.error(e); } };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Globe /> DNS</h1>
          <p>DNS records of your domains, right at your provider – set, change, delete and check whether the world sees them.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={Server} onClick={() => setAcc(null)}>Add provider</Btn>
          {zone && <Btn className="sm primary" icon={Plus} onClick={() => setRec(null)}>New record</Btn>}
        </div>
      </div>

      {!accounts.length ? (
        <div className="card"><Empty icon={Globe} title="No DNS provider yet" text="Connect Cloudflare, Hetzner, INWX or IONOS – Hostwerk then lists your domains and their records." action={<Btn className="primary" icon={Plus} onClick={() => setAcc(null)}>Add provider</Btn>} /></div>
      ) : (
        <div className="dns-grid">
          <div className="stack">
            <div className="card">
              <div className="card-head"><Server size={16} /><h3>Providers</h3></div>
              {accounts.map((a) => (
                <div key={a.id} className="list-item">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row-tight"><b className="ellipsis">{a.name}</b><span className="badge">{a.providerLabel}</span></div>
                    <div className="small muted">{a.zones === null ? '' : pl(a.zones, '1 zone', '{n} zones')}</div>
                  </div>
                  <Btn className="xs ghost icon" icon={Pencil} title="Change" aria-label="Change" onClick={() => setAcc(a)} />
                  <Btn className="xs ghost icon" icon={Trash2} title="Remove" aria-label="Remove" onClick={() => removeAcc(a)} />
                </div>
              ))}
              {zs.data && zs.data.errors.map((e) => <div key={e.account} className="card-body"><Callout kind="warn">{`${e.name}: ${e.error}`}</Callout></div>)}
            </div>
            {ov.data.mail && (
              <div className="card">
                <div className="card-head"><Mail size={16} /><h3>Mail server records</h3><InfoTip pop title="Mail server records">MX, SPF, DKIM and DMARC from the extension “Mail server”. Records that are missing at your provider are set with one click; existing SPF/DMARC records are replaced, nothing else is touched.</InfoTip></div>
                <MailRecords onApplied={() => recs.reload({ silent: true })} />
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <ListChecks size={16} /><h3>Records</h3>
              <div className="right row-tight">
                {zones.length > 0 && <select className="select dns-zone" aria-label="Zone" value={zone ? `${zone.account}/${zone.id}` : ''} onChange={(e) => setZoneKey(e.target.value)}>{zones.map((z) => <option key={`${z.account}/${z.id}`} value={`${z.account}/${z.id}`}>{z.name}</option>)}</select>}
                <Btn className="xs ghost icon" icon={RefreshCw} title="Reload" aria-label="Reload" onClick={() => { zs.reload(); recs.reload(); }} />
              </div>
            </div>
            {!zs.data ? (zs.error ? <div className="card-body"><Callout kind="err">{zs.error}</Callout></div> : <div className="card-body"><Loading /></div>)
              : !zone ? <Empty icon={Globe} title="No zones" text="The connected accounts have no domains with DNS at the provider (or the key may not read them)." />
                : recs.error ? <div className="card-body"><Callout kind="err">{recs.error}</Callout></div>
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
          </div>
        </div>
      )}

      {acc !== undefined && <AccountForm providers={providers} account={acc} onClose={() => setAcc(undefined)} onSaved={reloadAll} />}
      {rec !== undefined && zone && <RecordForm zone={zone} record={rec} proxy={proxy} router={ov.data.router} onClose={() => setRec(undefined)} onSaved={() => recs.reload({ silent: true })} />}
      {check && <VerifyResult rec={check.rec} result={check.result} onClose={() => setCheck(null)} />}
    </div>
  );
}

export default {
  pages: { main: DnsPage },
};

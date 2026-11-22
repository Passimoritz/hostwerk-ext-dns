/** Natural order of the records: the zone itself (@) first, then by name (host-2 before host-10), then by type and value. */
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortRecords(list, zone) {
  const key = (r) => (r.name === zone ? '' : r.name.endsWith(`.${zone}`) ? r.name.slice(0, -(zone.length + 1)) : r.name);
  return [...list].sort((a, b) => natural.compare(key(a), key(b)) || natural.compare(a.type, b.type) || natural.compare(String(a.content), String(b.content)));
}

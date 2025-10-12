import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import Chart from 'chart.js/auto';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

import {
  ensureHousehold, listMyHouseholds, createHousehold,
  setActiveHousehold
} from '../household';
import {
  listTransactions, addTransaction, updateTransaction, deleteTransaction,
  listBudgets, type Txn, toISO, parseNumber, fingerprint
} from '../data';
import {
  listCategories, createCategory, deleteCategoryIfUnused,
  renameCategoryAndMigrate, seedDefaultCategories, updateCategoryColor, type Category
} from '../categories';

/** ======= UI helpers ======= */
const row = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(12, 1fr)', alignItems: 'end' } as const;
const box = { border: '1px solid #eee', borderRadius: 8, padding: 12 } as const;

const LS_NEG_SPEND = 'negatives_are_spend';

/** Normalize header names for matching */
function norm(s: string) {
  return (s || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function guessCols(headers: string[]) {
  const H = headers.map(h => ({ raw: h, k: norm(h) }));
  const pick = (cands: string[]) => H.find(x => cands.includes(x.k))?.raw;
  const date = pick(['date','transaction_date','txn_date','posted_date','value_date','effective_date']);
  const desc = pick(['description','details','narration','memo','particulars','transaction_details','transaction_description','reference']);
  const amount = pick(['amount','transaction_amount','aud','amt','value']);
  const debit  = pick(['debit','withdrawal','debit_amount']);
  const credit = pick(['credit','deposit','credit_amount']);
  return { date, desc, amount, debit, credit };
}
type ImportMapping = { date?: string; desc?: string; amount?: string; debit?: string; credit?: string; };

/** Default fallback colors (used when a category has no color yet) */
const DEFAULT_PALETTE = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948',
  '#b07aa1','#ff9da7','#9c755f','#bab0ab','#86a5d9','#f2c14e'
];

function colorFor(_category: string, orderIndex: number, colorFromDb?: string | null) {
  if (colorFromDb && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colorFromDb)) return colorFromDb;
  return DEFAULT_PALETTE[orderIndex % DEFAULT_PALETTE.length];
}

export default function Tracker() {
  /** ---------- Household ---------- */
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [households, setHouseholds] = useState<{id:string; name:string}[]>([]);
  const [householdError, setHouseholdError] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);

  /** ---------- Categories ---------- */
  const [cats, setCats] = useState<Category[]>([]);
  const [newCat, setNewCat] = useState('');

  /** ---------- Data ---------- */
  const [txns, setTxns] = useState<Txn[]>([]);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [onlySpending, setOnlySpending] = useState(true);
  const [, setBudgets] = useState<Record<string, number>>({});
  const [negativesAreSpend, setNegativesAreSpend] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_NEG_SPEND) ? localStorage.getItem(LS_NEG_SPEND) === '1' : true; } catch { return true; }
  });

  /** ---------- Manual add form ---------- */
  const [form, setForm] = useState<Partial<Txn>>({
    date: new Date().toISOString().slice(0,10),
    person: 'Both',
    amount: 0,
    category: 'Uncategorized',
    source: 'manual'
  });

  /** ---------- Import preview modal (single declaration) ---------- */
  const [showPreview, setShowPreview] = useState(false);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<any[]>([]);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [importBusy, setImportBusy] = useState(false);

  /** ---------- Bootstrap ---------- */
  useEffect(() => {
    (async () => {
      try {
        setBootLoading(true);
        const hid = await ensureHousehold();
        setHouseholdId(hid);
        const list = await listMyHouseholds();
        setHouseholds(list);

        const today = new Date();
        const aMonthAgo = new Date(today.getTime() - 31*86400000);
        setFrom(aMonthAgo.toISOString().slice(0,10));
        setTo(today.toISOString().slice(0,10));
      } catch (e: any) {
        console.error('Household bootstrap failed:', e);
        setHouseholdError(e?.message || 'Failed to create/join household.');
      } finally {
        setBootLoading(false);
      }
    })();
  }, []);

  /** ---------- Load data when household/date range changes ---------- */
  useEffect(() => {
    if (!householdId) return;
    (async () => {
      try {
        const [rows, b, c] = await Promise.all([
          listTransactions(householdId, from || undefined, to || undefined),
          listBudgets(householdId),
          listCategories(householdId),
        ]);
        setTxns(rows);
        const map: Record<string, number> = {};
        b.forEach(x => map[x.category] = Number(x.amount));
        setBudgets(map);
        setCats(c);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [householdId, from, to]);

  /** Persist preference */
  useEffect(() => { try { localStorage.setItem(LS_NEG_SPEND, negativesAreSpend ? '1' : '0'); } catch {} }, [negativesAreSpend]);

  /** ---------- Derived ---------- */
  const categoryNames = useMemo(() => ['Uncategorized', ...cats.map(c => c.name)], [cats]);

  const catColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    const ordered = cats.length ? cats : [];
    ordered.forEach((c, idx) => { map[c.name] = colorFor(c.name, idx, c.color ?? undefined); });
    map['Uncategorized'] = map['Uncategorized'] || '#999999';
    return map;
  }, [cats]);

  const filtered = useMemo(() => {
    return txns
      .filter(t => (onlySpending ? t.amount > 0 : true))
      .sort((a,b) => a.date.localeCompare(b.date));
  }, [txns, onlySpending]);

  const totals = useMemo(() => {
    const totalOut = filtered.reduce((s,t) => s + Math.max(0, t.amount), 0);
    const byCat: Record<string, number> = {};
    filtered.forEach(t => {
      const c = t.category || 'Uncategorized';
      byCat[c] = (byCat[c] || 0) + Math.max(0, t.amount);
    });
    const catRows = Object.entries(byCat)
      .map(([category, spend]) => ({ category, spend, pct: totalOut ? (spend/totalOut*100) : 0 }))
      .sort((a,b)=>b.spend-a.spend);
    return { totalOut, catRows };
  }, [filtered]);

  /** ---------- Household actions ---------- */
  async function onSelectHousehold(id: string) {
    setActiveHousehold(id);
    setHouseholdId(id);
  }
  async function onCreateHousehold() {
    const name = prompt('Household name', 'Family')?.trim();
    if (!name) return;
    const id = await createHousehold(name);
    const list = await listMyHouseholds();
    setHouseholds(list);
    await onSelectHousehold(id);
    await seedDefaultCategories(id);
    setCats(await listCategories(id));
  }

  /** ---------- Manual add ---------- */
  async function onAdd() {
    try {
      if (!householdId) throw new Error('Household not ready yet.');
      if (!form.date || !form.amount) throw new Error('Please enter a date and amount.');
      const t: Txn = {
        household_id: householdId,
        date: form.date!,
        person: (form.person as any) || 'Both',
        merchant: form.merchant || '',
        description: form.description || '',
        amount: Number(form.amount),
        category: form.category || 'Uncategorized',
        tags: [],
        notes: form.notes || '',
        source: 'manual',
        external_id: null
      };
      const saved = await addTransaction(t);
      if (saved) setTxns(prev => [...prev, saved].sort((a,b)=>a.date.localeCompare(b.date)));
      setForm({
        date: new Date().toISOString().slice(0,10),
        person: form.person || 'Both',
        amount: 0,
        category: form.category || 'Uncategorized',
        source: 'manual'
      });
    } catch (e: any) {
      alert(e?.message || 'Failed to add transaction');
      console.error(e);
    }
  }

  /** ---------- Inline updates ---------- */
  async function onChangeCategory(id: string, cat: string) {
    try {
      const saved = await updateTransaction(id, { category: cat });
      setTxns(prev => prev.map(x => x.id === id ? saved : x));
    } catch (e: any) {
      alert(e?.message || 'Failed to update category');
      console.error(e);
    }
  }
  async function onChangeDescription(id: string, desc: string) {
    try {
      const saved = await updateTransaction(id, { description: desc });
      setTxns(prev => prev.map(x => x.id === id ? saved : x));
    } catch (e: any) {
      alert(e?.message || 'Failed to update description');
      console.error(e);
    }
  }
  async function onDelete(id: string) {
    try {
      await deleteTransaction(id);
      setTxns(prev => prev.filter(x => x.id !== id));
    } catch (e: any) {
      alert(e?.message || 'Failed to delete');
      console.error(e);
    }
  }

  /** ---------- Import (preview + mapping) ---------- */
  function openPreview(headers: string[], rows: any[]) {
    setPreviewHeaders(headers);
    setPreviewRows(rows);
    setMapping(guessCols(headers));
    setShowPreview(true);
  }

  async function onImport(file: File) {
    try {
      if (!householdId) throw new Error('Household not ready yet.');
      const isExcel = /\.xlsx?$/i.test(file.name);
      if (isExcel) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
        if (!rows.length) throw new Error('No rows found in the Excel sheet.');
        const headers = Object.keys(rows[0]);
        openPreview(headers, rows);
        return;
      }
Papa.parse<any>(file as unknown as Papa.LocalFile, {
  header: true,
  skipEmptyLines: true,
  complete: (res: Papa.ParseResult<any>) => {
    const rows = res.data as any[];
    if (!rows.length) { alert('No rows found.'); return; }
    const headers = res.meta.fields || Object.keys(rows[0]);
    openPreview(headers, rows);
  },
  // ⬇️ change this bit
  error: (error: Error, _file: Papa.LocalFile | string) => {
    const msg = (error as any)?.message || String(error);
    alert('CSV parse error: ' + msg);
    console.error(error);
  }
});
    } catch (e: any) {
      alert(e?.message || 'Import failed'); console.error(e);
    }
  }

  function validateMapping(m: ImportMapping) {
    if (!m.date) return 'Please map the Date column.';
    if (!m.amount && !(m.debit && m.credit)) return 'Please map Amount or Debit and Credit columns.';
    if (!m.desc) return 'Please map the Description column.';
    return null;
  }

  async function commitImport() {
    if (!householdId) return;
    const err = validateMapping(mapping);
    if (err) { alert(err); return; }
    setImportBusy(true);
    let added = 0, skipped = 0;

    try {
      for (const r of previewRows) {
        const rawDate = r[mapping.date!];
        const dateISO = toISO(rawDate);
        if (!dateISO) { skipped++; continue; }

        const desc = String(r[mapping.desc! ] ?? '').trim();
        const merchant = desc.split(' ').slice(0, 6).join(' ');

        let amount = 0;
        if (mapping.debit && mapping.credit) {
          const debit  = parseNumber(r[mapping.debit]);
          const credit = parseNumber(r[mapping.credit]);
          amount = (isFinite(debit) ? Math.max(0, debit) : 0) - (isFinite(credit) ? Math.max(0, credit) : 0);
          amount = Math.max(0, amount);
        } else if (mapping.amount) {
          const a = parseNumber(r[mapping.amount]);
          if (isFinite(a)) amount = (localStorage.getItem('negatives_are_spend') === '1')
            ? Math.max(0, -a) : Math.max(0, a);
        }
        if (!(amount > 0)) { skipped++; continue; }

        const ext = fingerprint(dateISO, amount, merchant, desc);
        const t: Txn = {
          household_id: householdId,
          date: dateISO,
          person: 'Both',
          merchant,
          description: desc,
          amount,
          category: 'Uncategorized',
          tags: [],
          notes: '',
          source: 'import',
          external_id: ext
        };

        try {
          const saved = await addTransaction(t);
          if (saved) { added++; setTxns(prev => [...prev, saved].sort((a,b)=>a.date.localeCompare(b.date))); }
          else { skipped++; }
        } catch { skipped++; }
      }
      alert(`Import complete: added ${added}, skipped ${skipped} (includes credits/payments & duplicates)`);
      setShowPreview(false);
    } finally {
      setImportBusy(false);
    }
  }

  /** ---------- Category actions ---------- */
  async function onAddCategory() {
    if (!householdId || !newCat.trim()) return;
    const created = await createCategory(householdId, newCat.trim());
    if (created === null) { alert('Category already exists.'); return; }
    setCats(await listCategories(householdId));
    setNewCat('');
  }

  async function onRenameCategory(c: Category) {
    const name = prompt('Rename category', c.name)?.trim();
    if (!name || name === c.name) return;
    await renameCategoryAndMigrate(c.household_id, c.id, c.name, name);
    setCats(await listCategories(c.household_id));
    // refresh txns/budgets in view
    setTxns(await listTransactions(c.household_id, from || undefined, to || undefined));
    const b = await listBudgets(c.household_id);
    const map: Record<string, number> = {}; b.forEach(x => map[x.category] = Number(x.amount));
    setBudgets(map);
  }

  async function onDeleteCategory(c: Category) {
    try {
      await deleteCategoryIfUnused(c.household_id, c.id, c.name);
      setCats(await listCategories(c.household_id));
    } catch (e: any) {
      alert(e?.message || 'Cannot delete category');
    }
  }

  async function onSetColor(c: Category, hex: string) {
    await updateCategoryColor(c.id, hex || null);
    setCats(await listCategories(c.household_id));
  }

  /** ---------- Chart & PDF ---------- */
  const pieRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<Chart | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const pieData = useMemo(() => {
    const labels = totals.catRows.map(r => r.category);
    const values = totals.catRows.map(r => r.spend);
    const colors = totals.catRows.map((r) => catColorMap[r.category] || '#999');
    return { labels, values, colors };
  }, [totals.catRows, catColorMap]);

  useEffect(() => {
    if (!pieRef.current) return;

    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }

    const ctx = pieRef.current.getContext('2d');
    if (!ctx) return;

    chartInstanceRef.current = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: pieData.labels,
        datasets: [{
          data: pieData.values,
          backgroundColor: pieData.colors
        }]
      },
      options: {
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              label: (item) => {
                const label = item.label || '';
                const v = item.parsed as number;
                return `${label}: $${v.toFixed(2)}`;
              }
            }
          }
        }
      }
    });

    return () => { chartInstanceRef.current?.destroy(); };
  }, [pieData.labels.join(','), pieData.values.join(','), pieData.colors.join(',')]);

  async function exportSummaryPDF() {
    if (!summaryRef.current) return;
    const node = summaryRef.current;
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });

    const pageW = pdf.internal.pageSize.getWidth();
    const contentW = pageW - 48; // 24pt margin each side
    const scale = contentW / canvas.width;
    const imgW = contentW;
    const imgH = canvas.height * scale;

    let y = 36;
    pdf.setFontSize(14);
    pdf.text('Spending Summary', 24, y);
    y += 12;
    pdf.setFontSize(10);
    pdf.text(`Period: ${from || '…'} to ${to || '…'}`, 24, y);
    y += 16;

    pdf.addImage(imgData, 'PNG', 24, y, imgW, imgH);
    const filename = `Spending-Summary-${(from||'').slice(0,7)}.pdf`;
    pdf.save(filename || 'Spending-Summary.pdf');
  }

  /** ---------- Render ---------- */
  return (
    <div style={{ padding: 16, maxWidth: 960, margin: '0 auto', boxSizing: 'border-box' }}>
      <div style={{ padding: 12, borderBottom: '1px solid #eee', display:'flex', justifyContent:'space-between' }}>
        <div><strong>Spending Tracker</strong></div>
        <div />
      </div>

      <h2 style={{ fontWeight: 700, fontSize: 22, textAlign:'center' }}>Spending Tracker — Cloud Sync</h2>

      {bootLoading && <div style={{marginTop:8, padding:8, background:'#fffbe6', border:'1px solid #ffe58f', borderRadius:6}}>Setting up your household…</div>}
      {householdError && <div style={{marginTop:8, padding:8, background:'#fff1f0', border:'1px solid #ffa39e', borderRadius:6}}>{householdError}</div>}
      {householdId && (
  <div
  style={{
    ...box,
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap', // ✅ allows wrapping on mobile
  }}
  className="card"
>
  <div style={{ minWidth: '120px' }}>Active household:</div>
  <select
    value={householdId}
    onChange={e => onSelectHousehold(e.target.value)}
    style={{ flex: '1 1 auto', minWidth: '150px' }}
  >
    {households.map(h => (
      <option key={h.id} value={h.id}>
        {h.name} ({h.id.slice(0, 8)})
      </option>
    ))}
  </select>

  <button style={{ flex: '0 0 auto' }} onClick={onCreateHousehold}>
    Create new household
  </button>

  <label
    className="wrap"
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginLeft: 'auto',
      flex: '1 1 100%', // ✅ pushes checkbox to new line on mobile
    }}
  >
    <input
      type="checkbox"
      checked={negativesAreSpend}
      onChange={e => {
        setNegativesAreSpend(e.target.checked);
        localStorage.setItem('negatives_are_spend', e.target.checked ? '1' : '0');
      }}
    />
    Negatives are spending (ignore credits)
  </label>
</div>
      )}

      {/* Entry row */}
      <section style={{ marginTop: 16, ...row }}>
        <div style={{ gridColumn: 'span 2' }}>
          <label>Date</label>
          <input type="date" value={form.date || ''} onChange={e=>setForm(f=>({ ...f, date: e.target.value }))} />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label>Person</label>
          <select value={(form.person as any) || 'Both'} onChange={e=>setForm(f=>({ ...f, person: e.target.value as any }))}>
            <option>Ken</option><option>Wife</option><option>Both</option>
          </select>
        </div>
        <div style={{ gridColumn: 'span 3' }}>
          <label>Merchant</label>
          <input value={form.merchant || ''} onChange={e=>setForm(f=>({ ...f, merchant: e.target.value }))} placeholder="Chemist Warehouse" />
        </div>
        <div style={{ gridColumn: 'span 3' }}>
          <label>Description</label>
          <input value={form.description || ''} onChange={e=>setForm(f=>({ ...f, description: e.target.value }))} placeholder="Skin serum" />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label>Amount (AUD)</label>
          <input type="number" step="0.01" value={(form.amount as any) || 0} onChange={e=>setForm(f=>({ ...f, amount: Number(e.target.value) }))} />
        </div>
        <div style={{ gridColumn: 'span 3' }}>
          <label>Category</label>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ width:12, height:12, borderRadius:999, background: catColorMap[form.category || 'Uncategorized'] }} />
            <select value={form.category || 'Uncategorized'} onChange={e=>setForm(f=>({ ...f, category: e.target.value }))}>
              {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div style={{ gridColumn: 'span 5', display: 'flex', alignItems: 'end', gap: 8 }}>
          <button onClick={onAdd}>Add</button>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={e=>{ const f=e.target.files?.[0]; if (f) onImport(f); }} />
          <label style={{ display:'flex', alignItems:'center', gap:6, marginLeft: 8 }}>
            <input type="checkbox" checked={onlySpending} onChange={e=>setOnlySpending(e.target.checked)} />
            Show only spending
          </label>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label>From</label>
          <input type="date" value={from} onChange={e=>setFrom(e.target.value)} />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label>To</label>
          <input type="date" value={to} onChange={e=>setTo(e.target.value)} />
        </div>
      </section>

      {/* Totals */}
      <section style={{ marginTop: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Total spend: ${totals.totalOut.toFixed(2)}</div>
      </section>

      {/* Summary with Pie + Table + Export */}
      <section ref={summaryRef} style={{ marginTop: 20, ...box }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 8 }}>
          <h3 style={{ margin:0 }}>Spending Summary</h3>
          <button onClick={exportSummaryPDF}>Export as PDF</button>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <div style={{ minHeight: 280 }}>
            <canvas ref={pieRef} />
          </div>
          <div>
            <table style={{ width:'100%', fontSize: 14, borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign:'left', borderBottom:'1px solid #eee', padding:'6px' }}>Category</th>
                  <th style={{ textAlign:'right', borderBottom:'1px solid #eee', padding:'6px' }}>Spend (AUD)</th>
                  <th style={{ textAlign:'right', borderBottom:'1px solid #eee', padding:'6px' }}>%</th>
                </tr>
              </thead>
              <tbody>
                {totals.catRows.map((r) => (
                  <tr key={r.category}>
                    <td style={{ padding:'6px' }}>
                      <span style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
                        <span style={{ width:10, height:10, borderRadius:999, background: catColorMap[r.category] }} />
                        {r.category}
                      </span>
                    </td>
                    <td style={{ padding:'6px', textAlign:'right' }}>${r.spend.toFixed(2)}</td>
                    <td style={{ padding:'6px', textAlign:'right' }}>{r.pct.toFixed(1)}%</td>
                  </tr>
                ))}
                {!totals.catRows.length && (
                  <tr><td colSpan={3} style={{ padding:'8px', color:'#888' }}>No data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Transactions table */}
      <section style={{ marginTop: 20 }}>
        <h3>Transactions</h3>
        <div style={{ maxHeight: '60vh', overflow: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
          <table style={{ width: '100%', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={{ padding: '8px 6px' }}>Date</th>
                <th style={{ padding: '8px 6px' }}>Merchant</th>
                <th style={{ padding: '8px 6px' }}>Description (editable)</th>
                <th style={{ padding: '8px 6px', textAlign:'right' }}>Amount</th>
                <th style={{ padding: '8px 6px' }}>Category</th>
                <th style={{ padding: '8px 6px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '8px 6px', whiteSpace:'nowrap' }}>{t.date}</td>
                  <td style={{ padding: '8px 6px' }}>{t.merchant}</td>
                  <td style={{ padding: '8px 6px' }}>
                    <input
                      style={{ width:'100%' }}
                      defaultValue={t.description || ''}
                      onBlur={e => {
                        const v = e.currentTarget.value;
                        if (v !== (t.description || '')) onChangeDescription(t.id!, v);
                      }}
                    />
                  </td>
                  <td style={{ padding: '8px 6px', textAlign:'right' }}>${t.amount.toFixed(2)}</td>
                  <td style={{ padding: '8px 6px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ width:10, height:10, borderRadius:999, background: catColorMap[t.category || 'Uncategorized'] }} />
                      <select value={t.category || 'Uncategorized'} onChange={e=>onChangeCategory(t.id!, e.target.value)}>
                        {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </td>
                  <td style={{ padding: '8px 6px' }}>
                    <button onClick={()=>onDelete(t.id!)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={6} style={{ padding:12, textAlign:'center', color:'#999' }}>
                    No transactions yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Categories manager */}
      <section style={{ marginTop: 24 }}>
        <h3>Categories</h3>
        <div style={{ ...box }}>
          {!cats.length && (
            <div style={{ marginBottom: 8 }}>
              <button onClick={async ()=>{
                if (!householdId) return;
                await seedDefaultCategories(householdId);
                setCats(await listCategories(householdId));
              }}>Seed default categories</button>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr auto auto auto', gap:8, alignItems:'center' }}>
            {cats.map((c, idx) => (
              <div key={c.id} style={{ display:'contents' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ width:12, height:12, borderRadius:999, background: colorFor(c.name, idx, c.color ?? undefined) }} />
                  {c.name}
                </div>
                <input
                  type="color"
                  value={(c.color as string) || colorFor(c.name, idx, c.color ?? undefined)}
                  onChange={e=>onSetColor(c, e.target.value)}
                  title="Pick color"
                  style={{ width:36, height:28, padding:0, border:'1px solid #ddd', borderRadius:6, background:'#fff' }}
                />
                <button onClick={()=>onRenameCategory(c)}>Rename</button>
                <button onClick={()=>onDeleteCategory(c)}>Delete</button>
              </div>
            ))}
            <div style={{ display:'contents', marginTop: 6 }}>
              <input
                placeholder="New category name"
                value={newCat}
                onChange={e=>setNewCat(e.target.value)}
              />
              <div />
              <button onClick={onAddCategory}>Add</button>
              <div />
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color:'#777' }}>
            • You can’t delete a category that’s used by any transactions or budgets.
            • Renaming will migrate existing transactions and the matching budget row.
          </div>
        </div>
      </section>

      {/* Import preview modal */}
      {showPreview && (
        <div style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,0.35)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000
        }}>
          <div style={{ background:'#fff', borderRadius:10, width:'min(980px, 96vw)', maxHeight:'90vh', overflow:'auto', padding:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <h3 style={{ margin:0 }}>Preview & Map Columns</h3>
              <button onClick={()=>setShowPreview(false)} disabled={importBusy}>Close</button>
            </div>
            <p style={{ marginTop:8 }}>Map your CSV/XLSX columns, then Import. Negatives treated as spending when that setting is enabled.</p>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginTop:8 }}>
              <div>
                <div style={{ fontWeight:600 }}>Date</div>
                <select value={mapping.date || ''} onChange={e=>setMapping(m=>({ ...m, date: e.target.value || undefined }))}>
                  <option value="">-- choose --</option>
                  {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontWeight:600 }}>Description</div>
                <select value={mapping.desc || ''} onChange={e=>setMapping(m=>({ ...m, desc: e.target.value || undefined }))}>
                  <option value="">-- choose --</option>
                  {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontWeight:600 }}>Amount (single)</div>
                <select value={mapping.amount || ''} onChange={e=>setMapping(m=>({ ...m, amount: e.target.value || undefined, debit: undefined, credit: undefined }))}>
                  <option value="">-- none / use Debit+Credit --</option>
                  {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div />
              <div>
                <div style={{ fontWeight:600 }}>Debit (if separate)</div>
                <select value={mapping.debit || ''} onChange={e=>setMapping(m=>({ ...m, debit: e.target.value || undefined, amount: undefined }))}>
                  <option value="">-- none --</option>
                  {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontWeight:600 }}>Credit (if separate)</div>
                <select value={mapping.credit || ''} onChange={e=>setMapping(m=>({ ...m, credit: e.target.value || undefined, amount: undefined }))}>
                  <option value="">-- none --</option>
                  {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div style={{ gridColumn:'span 2', display:'flex', alignItems:'center', gap:8 }}>
                <label style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <input
                    type="checkbox"
                    checked={negativesAreSpend}
                    onChange={e=>setNegativesAreSpend(e.target.checked)}
                  />
                  Negatives are spending (ignore credits)
                </label>
              </div>
            </div>

            <div style={{ ...box, marginTop:12 }}>
              <div style={{ fontWeight:600, marginBottom:8 }}>First 10 rows</div>
              <div style={{ overflow:'auto', maxHeight: 320 }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr>
                      {previewHeaders.map(h => (
                        <th key={h} style={{ borderBottom:'1px solid #eee', textAlign:'left', padding:6 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0,10).map((r, i) => (
                      <tr key={i}>
                        {previewHeaders.map(h => (
                          <td key={h} style={{ borderBottom:'1px solid #f7f7f7', padding:6 }}>
                            {String(r[h] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ marginTop:12, display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button onClick={()=>setShowPreview(false)} disabled={importBusy}>Cancel</button>
              <button onClick={commitImport} disabled={importBusy} style={{ padding:'8px 14px' }}>
                {importBusy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
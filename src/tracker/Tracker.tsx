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

// ---- TS-safe wrappers to ensure string args ----
function safeListTxns(hid?: string | null, from?: string | null, to?: string | null) {
  return listTransactions(String(hid ?? ''), String(from ?? ''), String(to ?? ''));
}
function safeListBudgets(hid?: string | null) {
  return listBudgets(String(hid ?? ''));
}
function safeListCategories(hid?: string | null) {
  return listCategories(String(hid ?? ''));
}

const LS_NEG_SPEND = 'negatives_are_spend';

function rulesKey(hid?: string | null) { return `spendr_learn_rules_${hid || 'none'}`; }
function loadLearnRules(hid?: string | null): Record<string, string> {
  try {
    const raw = localStorage.getItem(rulesKey(hid));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveLearnRules(hid: string | null, rules: Record<string, string>) {
  try { localStorage.setItem(rulesKey(hid), JSON.stringify(rules)); } catch {}
}
function normKey(s?: string | null) {
  return (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
}
function suggestCategory(merchant: string, description: string, rules: Record<string, string>) {
  const keys = [merchant, description].map(normKey).filter(Boolean);
  for (const k of keys) { if (rules[k]) return rules[k]; }
  return null;
}

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
  '#10b981','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#06b6d4',
  '#ec4899','#84cc16','#f97316','#6366f1','#14b8a6','#a855f7'
];

function colorFor(_category: string, orderIndex: number, colorFromDb?: string | null) {
  if (colorFromDb && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colorFromDb)) return colorFromDb;
  return DEFAULT_PALETTE[orderIndex % DEFAULT_PALETTE.length];
}

export default function Tracker() {
  // Collapsible state for Categories section
  const [catsOpen, setCatsOpen] = useState(false);
  /** ---------- Household ---------- */
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [households, setHouseholds] = useState<{id:string; name:string}[]>([]);
  const [householdError, setHouseholdError] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);

  /** ---------- Categories ---------- */
  const [cats, setCats] = useState<Category[]>([]);
  const [newCat, setNewCat] = useState('');

// sorting
const [sortBy, setSortBy] = useState<'date' | 'merchant' | 'amount' | 'category'>('date');
const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

// amount input as text to preserve decimal typing on iOS
const [amountText, setAmountText] = useState<string>('');

// simple learn-to-categorize (per household) stored in localStorage
const [learnRules, setLearnRules] = useState<Record<string, string>>({});

  /** ---------- Data ---------- */
  const [txns, setTxns] = useState<Txn[]>([]);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [onlySpending, setOnlySpending] = useState(true);
  const [, setBudgets] = useState<Record<string, number>>({});
  const [negativesAreSpend, setNegativesAreSpend] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_NEG_SPEND) ? localStorage.getItem(LS_NEG_SPEND) === '1' : true; } catch { return true; }
  });

  /** ---------- Monthly dashboard state ---------- */
  const [dashTab, setDashTab] = useState<'current' | 'archive'>('current');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));

  function yyyymm(d: string) { return (d || '').slice(0, 7); }
  function formatMonth(ym: string) {
    if (!ym || ym.length < 7) return ym || '';
    const [y, m] = ym.split('-');
    const dt = new Date(Number(y), Number(m) - 1, 1);
    return dt.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  }

  /** ---------- Manual add form ---------- */
  const [form, setForm] = useState<Partial<Txn>>({
    date: new Date().toISOString().slice(0,10),
    person: 'Both',
    amount: undefined,
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
setLearnRules(loadLearnRules(hid));
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
          safeListTxns(householdId, from, to),
          safeListBudgets(householdId),
          safeListCategories(householdId),
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

/** ---------- Reload learned rules when household changes ---------- */
useEffect(() => {
  setLearnRules(loadLearnRules(householdId));
}, [householdId]);

  /** Persist preference */
  useEffect(() => { try { localStorage.setItem(LS_NEG_SPEND, negativesAreSpend ? '1' : '0'); } catch {} }, [negativesAreSpend]);

  /** ---------- Derived ---------- */
  const categoryNames = useMemo(() => ['Uncategorized', ...cats.map(c => c.name)], [cats]);

  const catColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    const ordered = cats.length ? cats : [];
    ordered.forEach((c, idx) => { map[c.name] = colorFor(c.name, idx, c.color ?? undefined); });
    map['Uncategorized'] = map['Uncategorized'] || '#6b7280';
    return map;
  }, [cats]);

  const filtered = useMemo(() => {
  const rows = txns.filter(t => (onlySpending ? t.amount > 0 : true));
  const dir = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    switch (sortBy) {
      case 'merchant':
        return (a.merchant || '').localeCompare(b.merchant || '') * dir;
      case 'category':
        return (a.category || '').localeCompare(b.category || '') * dir;
      case 'amount':
        return (a.amount - b.amount) * dir;
      case 'date':
      default:
        return a.date.localeCompare(b.date) * dir;
    }
  });
  return rows;
}, [txns, onlySpending, sortBy, sortDir]);

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

  /** ---------- Monthly groupings ---------- */
  const spendingTxns = useMemo(() => txns.filter(t => (onlySpending ? t.amount > 0 : true)), [txns, onlySpending]);

  const monthsList = useMemo(() => {
    const map: Record<string, { total: number; byCat: Record<string, number> }> = {};
    for (const t of spendingTxns) {
      const m = yyyymm(t.date);
      if (!m) continue;
      if (!map[m]) map[m] = { total: 0, byCat: {} };
      const amt = Math.max(0, t.amount);
      map[m].total += amt;
      const c = t.category || 'Uncategorized';
      map[m].byCat[c] = (map[m].byCat[c] || 0) + amt;
    }
    const arr = Object.entries(map).map(([month, data]) => ({ month, total: data.total, byCat: data.byCat }));
    arr.sort((a, b) => b.month.localeCompare(a.month)); // newest first
    return arr;
  }, [spendingTxns]);

  const currentMonthData = useMemo(() => {
    const found = monthsList.find(m => m.month === selectedMonth) || { month: selectedMonth, total: 0, byCat: {} as Record<string, number> };
    const catRows = Object.entries(found.byCat)
      .map(([category, spend]) => ({ category, spend, pct: found.total ? (spend / found.total * 100) : 0 }))
      .sort((a, b) => b.spend - a.spend);
    return { totalOut: found.total, catRows };
  }, [monthsList, selectedMonth]);

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
      if (!form.date || form.amount == null || isNaN(Number(form.amount))) throw new Error('Please enter a date and amount.');
      const suggested = suggestCategory(form.merchant || '', form.description || '', learnRules);
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
      if (suggested && !form.category) t.category = suggested;
      console.log('Auto-category suggestion used:', suggested);
      const saved = await addTransaction(t);
      if (saved) setTxns(prev => [...prev, saved].sort((a,b)=>a.date.localeCompare(b.date)));
      setForm({
        date: new Date().toISOString().slice(0,10),
        person: form.person || 'Both',
        amount: undefined,
        category: form.category || 'Uncategorized',
        source: 'manual'
      });
      setAmountText('');
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
      const key = normKey(saved.merchant || saved.description);
      const updatedRules = { ...learnRules, [key]: cat };
      setLearnRules(updatedRules);
      saveLearnRules(householdId, updatedRules);
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
    const safeHouseholdId: string = householdId ? String(householdId) : '';
    const created = await createCategory(safeHouseholdId, newCat.trim());
    if (created === null) { alert('Category already exists.'); return; }
    setCats(await safeListCategories(safeHouseholdId));
    setNewCat('');
  }

  async function onRenameCategory(c: Category) {
    const name = prompt('Rename category', c.name)?.trim();
    if (!name || name === c.name) return;
    await renameCategoryAndMigrate(c.household_id, c.id, c.name, name);
    const safeHouseholdId: string = String(c.household_id ?? '');
    setCats(await safeListCategories(safeHouseholdId));
    const refreshedTxns = await safeListTxns(safeHouseholdId, from, to);
    setTxns(refreshedTxns);
    const b = await safeListBudgets(safeHouseholdId);
    const map: Record<string, number> = {};
    b.forEach(x => map[x.category] = Number(x.amount));
    setBudgets(map);
  }

  async function onDeleteCategory(c: Category) {
    try {
      const safeHouseholdId: string = c.household_id ? String(c.household_id) : '';
      await deleteCategoryIfUnused(safeHouseholdId, c.id, c.name);
      setCats(await safeListCategories(safeHouseholdId));
    } catch (e: any) {
      alert(e?.message || 'Cannot delete category');
    }
  }

  async function onSetColor(c: Category, hex: string) {
    await updateCategoryColor(c.id, hex || null);
    const safeHouseholdId: string = c.household_id ? String(c.household_id) : '';
    setCats(await safeListCategories(safeHouseholdId));
  }

  /** ---------- Chart & PDF ---------- */
  const pieRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<Chart | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const pieData = useMemo(() => {
    const labels = currentMonthData.catRows.map(r => r.category);
    const values = currentMonthData.catRows.map(r => r.spend);
    const colors = currentMonthData.catRows.map((r) => catColorMap[r.category] || '#999');
    return { labels, values, colors };
  }, [currentMonthData.catRows, catColorMap]);

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
    const contentW = pageW - 48;
    const scale = contentW / canvas.width;
    const imgW = contentW;
    const imgH = canvas.height * scale;

    let y = 36;
    pdf.setFontSize(14);
    pdf.text('Spending Summary', 24, y);
    y += 12;
    pdf.setFontSize(10);
    pdf.text(`Period: ${from || '...'} to ${to || '...'}`, 24, y);
    y += 16;

    pdf.addImage(imgData, 'PNG', 24, y, imgW, imgH);
    const filename = `Spending-Summary-${(from||'').slice(0,7)}.pdf`;
    pdf.save(filename || 'Spending-Summary.pdf');
  }

  /** ---------- Render ---------- */
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #f8fafc, #eff6ff)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
        {/* Header */}
        <div style={{ 
          background: '#fff', 
          borderRadius: 16, 
          boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)', 
          padding: 24, 
          marginBottom: 24,
          border: '1px solid #e2e8f0'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ 
                fontSize: 30, 
                fontWeight: 700, 
                background: 'linear-gradient(to right, #2563eb, #4f46e5)', 
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                margin: 0
              }}>
                Spending Tracker
              </h1>
              <p style={{ color: '#64748b', fontSize: 14, marginTop: 4 }}>Cloud Sync Enabled • Build: 2025-10-13g</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: '#d1fae5', color: '#065f46', borderRadius: 9999, border: '1px solid #86efac', fontSize: 14, fontWeight: 500 }}>
              <span>✓</span>
              <span>Synced</span>
            </div>
          </div>
        </div>

        {bootLoading && <div style={{marginTop:8, padding:16, background:'#fef3c7', border:'1px solid #fde047', borderRadius:12, color:'#92400e'}}>Setting up your household...</div>}
        {householdError && <div style={{marginTop:8, padding:16, background:'#fee2e2', border:'1px solid #fca5a5', borderRadius:12, color:'#991b1b'}}>{householdError}</div>}
        
        {/* Household Selector */}
        {householdId && (
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1)', padding: 24, marginBottom: 24, border: '1px solid #e2e8f0' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'end' }}>
                <div style={{ flex: '1 1 300px', minWidth: 200 }}>
                  <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Active Household</label>
                  <select
                    value={householdId}
                    onChange={e => onSelectHousehold(e.target.value)}
                    style={{ width: '100%', padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                  >
                    {households.map(h => (
                      <option key={h.id} value={h.id}>
                        {h.name} ({h.id.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                </div>
                <button 
                  onClick={onCreateHousehold}
                  style={{ padding: '10px 24px', background: 'linear-gradient(to right, #2563eb, #4f46e5)', color: '#fff', fontWeight: 600, border: 'none', borderRadius: 8, cursor: 'pointer', boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1)', transition: 'all 0.2s' }}
                  onMouseOver={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                  onMouseOut={e => e.currentTarget.style.transform = 'translateY(0)'}
                >
                  Create New Household
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  id="neg-spend"
                  checked={negativesAreSpend}
                  onChange={e => {
                    setNegativesAreSpend(e.target.checked);
                    localStorage.setItem('negatives_are_spend', e.target.checked ? '1' : '0');
                  }}
                  style={{ width: 16, height: 16 }}
                />
                <label htmlFor="neg-spend" style={{ fontSize: 14, color: '#334155' }}>Negatives are spending (ignore credits)</label>
              </div>
            </div>
          </div>
        )}

        {/* Add Transaction Form */}
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1)', padding: 24, marginBottom: 24, border: '1px solid #e2e8f0' }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 16 }}>Add Transaction</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Date</label>
              <input type="date" value={form.date || ''} onChange={e=>setForm(f=>({ ...f, date: e.target.value }))} style={{ width: '100%', padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 16 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Person</label>
              <select value={(form.person as any) || 'Both'} onChange={e=>setForm(f=>({ ...f, person: e.target.value as any }))} style={{ width: '100%', padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 16 }}>
                <option>Ken</option><option>Wife</option><option>Both</option>
              </select>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Merchant</label>
              <input value={form.merchant || ''} onChange={e=>setForm(f=>({ ...f, merchant: e.target.value }))} placeholder="Chemist Warehouse" style={{ width: '100%', padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 16 }} />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Description</label>
              <input value={form.description || ''} onChange={e=>setForm(f=>({ ...f, description: e.target.value }))} placeholder="Skin serum" style={{ width: '100%', padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 16 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Amount (AUD)</label>
              <input
                type="text"
                name="amount"
                autoComplete="off"
                inputMode="decimal"
                enterKeyHint="done"
                pattern="[0-9]*[.,]?[0-9]*"
                placeholder="0.00"
                value={amountText}
                onFocus={e => e.currentTarget.select()}
                onChange={e => {
                  const raw = e.target.value.replace(/[^0-9.,]/g, '');
                  setAmountText(raw);
                }}
                onBlur={() => {
                  const normalized = amountText.replace(',', '.');
                  if (normalized === '' || normalized === '.' || normalized === ',') {
                    setForm(f => ({ ...f, amount: undefined }));
                    return;
                  }
                  const num = Number(normalized);
                  if (!isNaN(num)) setForm(f => ({ ...f, amount: num }));
                }}
                style={{ width: '100%', padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 16 }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 8 }}>Category</label>
              <div style={{ display:'flex', alignItems:'center', gap:8, padding: '10px 16px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8 }}>
                <span style={{ width:12, height:12, borderRadius:999, background: catColorMap[form.category || 'Uncategorized'], flexShrink: 0 }} />
                <select value={form.category || 'Uncategorized'} onChange={e=>setForm(f=>({ ...f, category: e.target.value }))} style={{ flex: 1, background: 'transparent', border: 'none', fontSize:
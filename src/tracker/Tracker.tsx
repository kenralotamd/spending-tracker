import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
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

// TS-safe wrappers to ensure string args
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

const DEFAULT_PALETTE = [
  '#10b981','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#06b6d4',
  '#ec4899','#84cc16','#f97316','#6366f1','#14b8a6','#a855f7'
];

const supa = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
);

function colorFor(_category: string, orderIndex: number, colorFromDb?: string | null) {
  if (colorFromDb && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colorFromDb)) return colorFromDb;
  return DEFAULT_PALETTE[orderIndex % DEFAULT_PALETTE.length];
}

export default function Tracker() {
  const [catsOpen, setCatsOpen] = useState(false);
  const [txnsOpen, setTxnsOpen] = useState(true);
  const [editingTxn, setEditingTxn] = useState<string | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [households, setHouseholds] = useState<{id:string; name:string}[]>([]);
  const [householdError, setHouseholdError] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [cats, setCats] = useState<Category[]>([]);
  const [newCat, setNewCat] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'merchant' | 'amount' | 'category'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [amountText, setAmountText] = useState<string>('');
  const [learnRules, setLearnRules] = useState<Record<string, string>>({});
  const [txns, setTxns] = useState<Txn[]>([]);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [onlySpending, setOnlySpending] = useState(true);
  const [, setBudgets] = useState<Record<string, number>>({});
  const [negativesAreSpend, setNegativesAreSpend] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_NEG_SPEND) ? localStorage.getItem(LS_NEG_SPEND) === '1' : true; } catch { return true; }
  });
  const [selectedMonth, setSelectedMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [clearBusy, setClearBusy] = useState(false);
  const [deleteHHBusy, setDeleteHHBusy] = useState(false);
  const [showHH, setShowHH] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [joinId, setJoinId] = useState('');
  
  function yyyymm(d: string) { return (d || '').slice(0, 7); }
  function formatMonth(ym: string) {
    if (!ym || ym.length < 7) return ym || '';
    const [y, m] = ym.split('-');
    const dt = new Date(Number(y), Number(m) - 1, 1);
    return dt.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  }

  const [form, setForm] = useState<Partial<Txn>>({
    date: new Date().toISOString().slice(0,10),
    person: 'Both',
    amount: undefined,
    category: 'Uncategorized',
    source: 'manual'
  });

  const [showPreview, setShowPreview] = useState(false);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<any[]>([]);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [importBusy, setImportBusy] = useState(false);

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

  useEffect(() => {
    setLearnRules(loadLearnRules(householdId));
  }, [householdId]);

  useEffect(() => { 
    try { localStorage.setItem(LS_NEG_SPEND, negativesAreSpend ? '1' : '0'); } catch {} 
  }, [negativesAreSpend]);

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
        case 'merchant': return (a.merchant || '').localeCompare(b.merchant || '') * dir;
        case 'category': return (a.category || '').localeCompare(b.category || '') * dir;
        case 'amount': return (a.amount - b.amount) * dir;
        case 'date':
        default: return a.date.localeCompare(b.date) * dir;
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
    arr.sort((a, b) => b.month.localeCompare(a.month));
    return arr;
  }, [spendingTxns]);

  const currentMonthData = useMemo(() => {
    const found = monthsList.find(m => m.month === selectedMonth) || { month: selectedMonth, total: 0, byCat: {} as Record<string, number> };
    const catRows = Object.entries(found.byCat)
      .map(([category, spend]) => ({ category, spend, pct: found.total ? (spend / found.total * 100) : 0 }))
      .sort((a, b) => b.spend - a.spend);
    return { totalOut: found.total, catRows };
  }, [monthsList, selectedMonth]);

  async function joinHouseholdById() {
    try {
      if (!joinId.trim()) { alert('Enter a household ID to join.'); return; }
      const { data: userData, error: userErr } = await supa.auth.getUser();
      if (userErr || !userData?.user?.id) throw new Error('Not signed in.');
      const myId = userData.user.id;
      const { error } = await supa.from('household_members').insert({
        household_id: joinId.trim(),
        user_id: myId,
        role: 'member'
      });
      if (error) throw error;
      const list = await listMyHouseholds();
      setHouseholds(list);
      const joined = list.find(h => h.id === joinId.trim());
      if (joined) {
        await onSelectHousehold(joined.id);
        setShowHH(false);
        setJoinId('');
        alert('Joined household successfully.');
      } else {
        alert('Joined, but could not find household in list. Try refreshing.');
      }
    } catch (e: any) {
      alert(e?.message || 'Failed to join household. Make sure the ID is correct and policies allow joining.');
      console.error(e);
    }
  }

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

  async function onDeleteHousehold() {
    if (!householdId) return;
    const name = households.find(h => h.id === householdId)?.name || 'this household';
    if (!confirm(`This will permanently delete "${name}" and all its data for everyone in it.\n\nType DELETE to confirm.`)) return;
    const typed = prompt('Type DELETE to confirm:');
    if (typed !== 'DELETE') return;
    try {
      setDeleteHHBusy(true);
      let ok = false;
      try {
        const mod: any = await import('../household');
        if (typeof mod.deleteHousehold === 'function') {
          await mod.deleteHousehold(householdId);
          ok = true;
        }
      } catch {}
      if (!ok) {
        const url = import.meta.env.VITE_SUPABASE_URL as string;
        const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
        if (!url || !key) throw new Error('Missing Supabase URL/Anon key env vars.');
        const resp = await fetch(`${url}/rest/v1/households?id=eq.${encodeURIComponent(householdId)}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' }
        });
        if (!resp.ok) {
          const msg = await resp.text();
          throw new Error(`Delete failed (${resp.status}): ${msg || 'RLS may block DELETE. Add a delete policy.'}`);
        }
      }
      const updated = await listMyHouseholds();
      setHouseholds(updated);
      setHouseholdId(updated[0]?.id ?? null);
      setTxns([]);
      setCats([]);
    } catch (e: any) {
      alert(e?.message || 'Failed to delete household. Check RLS delete policy on public.households.');
      console.error(e);
    } finally {
      setDeleteHHBusy(false);
    }
  }

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

  async function onChangeCategory(id: string, cat: string) {
    try {
      const saved = await updateTransaction(id, { category: cat });
      setTxns(prev => prev.map(x => x.id === id ? saved : x));
      const key = normKey(saved.merchant || saved.description);
      const updatedRules = { ...learnRules, [key]: cat };
      setLearnRules(updatedRules);
      saveLearnRules(householdId, updatedRules);
      setEditingTxn(null);
    } catch (e: any) {
      alert(e?.message || 'Failed to update category');
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

  async function onClearTransactionsInView() {
    try {
      if (!householdId) throw new Error('Household not ready yet.');
      const label = from && to ? `${from} → ${to}` : 'current view';
      if (!confirm(`Delete ALL transactions in ${label}? This cannot be undone.`)) return;
      setClearBusy(true);
      const toWipe = await listTransactions(String(householdId), from || undefined, to || undefined);
      for (const t of toWipe) {
        if (t.id) {
          try { await deleteTransaction(t.id); } catch {}
        }
      }
      const refreshed = await listTransactions(String(householdId), from || undefined, to || undefined);
      setTxns(refreshed);
    } catch (e: any) {
      alert(e?.message || 'Failed to clear transactions');
      console.error(e);
    } finally {
      setClearBusy(false);
    }
  }

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
      alert(e?.message || 'Import failed'); 
      console.error(e);
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

        const desc = String(r[mapping.desc!] ?? '').trim();
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

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #f8fafc, #eff6ff, #faf5ff)' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '20px 16px' }}>
        
        {/* Glassmorphic Header */}
        <div style={{ 
          background: 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.7) 100%)', 
          backdropFilter: 'blur(20px)',
          borderRadius: 24, 
          boxShadow: '0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)', 
          padding: '32px 24px',
          marginBottom: 24,
          border: '1px solid rgba(255,255,255,0.3)',
          position: 'relative',
          overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(59,130,246,0.03) 0%, rgba(139,92,246,0.03) 100%)', pointerEvents: 'none' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h1 style={{ 
                  fontSize: 32, 
                  fontWeight: 800, 
                  background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 50%, #db2777 100%)', 
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  marginBottom: 8,
                  letterSpacing: '-0.02em'
                }}>
                  💰 UmaYagi Spending Tracker
                </h1>
                <p style={{ color: '#64748b', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' }} />
                  Cloud Sync Enabled • Build: 2025-10-13g
                </p>
              </div>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: 10, 
                padding: '12px 20px', 
                background: 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)', 
                color: '#065f46', 
                borderRadius: 16, 
                border: '2px solid #86efac', 
                fontSize: 14, 
                fontWeight: 700,
                boxShadow: '0 4px 12px rgba(16,185,129,0.15)'
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>Synced</span>
              </div>
            </div>
          </div>
        </div>

        {bootLoading && (
          <div className="animate-in" style={{marginTop:8, padding:20, background:'linear-gradient(135deg, #fef3c7 0%, #fde047 100%)', border:'2px solid #facc15', borderRadius:16, color:'#92400e', fontWeight:600, boxShadow: '0 4px 12px rgba(250,204,21,0.2)'}}>
            ⏳ Setting up your household...
          </div>
        )}
        
        {householdError && (
          <div className="animate-in" style={{marginTop:8, padding:20, background:'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)', border:'2px solid #fca5a5', borderRadius:16, color:'#991b1b', fontWeight:600, boxShadow: '0 4px 12px rgba(252,165,165,0.2)'}}>
            ❌ {householdError}
          </div>
        )}
        
        {householdId && (
          <>
            <div className="card" style={{ padding: 16, marginBottom: 16, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <span className="status-dot status-online" />
                <div style={{ fontWeight: 700, color:'#0f172a' }}>
                  Active: {households.find(h => h.id === householdId)?.name || '—'} ({householdId.slice(0,8)})
                </div>
              </div>
              <button onClick={()=>setShowHH(true)} className="inline-button" style={{ background:'linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)', color:'#fff' }}>
                Household settings
              </button>
            </div>

            {showHH && (
              <div style={{
                position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', display:'flex',
                alignItems:'center', justifyContent:'center', zIndex:10000, padding:20
              }}>
                <div className="card" style={{ width:'min(720px, 96vw)', padding:24 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                    <h2 style={{ fontSize:18 }}>🏠 Household Settings</h2>
                    <button onClick={()=>setShowHH(false)} className="inline-button">Close</button>
                  </div>

                  <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                    <div>
                      <label style={{ display:'block', fontSize:14, fontWeight:600, color:'#475569', marginBottom:8 }}>Select household</label>
                      <select
                        value={householdId}
                        onChange={e => onSelectHousehold(e.target.value)}
                        style={{ width:'100%' }}
                      >
                        {households.map(h => (
                          <option key={h.id} value={h.id}>{h.name} ({h.id.slice(0, 8)})</option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                      <button 
                        onClick={onCreateHousehold}
                        style={{ background:'linear-gradient(135deg, #10b981 0%, #059669 100%)', color:'#fff' }}
                      >
                        ➕ Create new household
                      </button>
                      <button
                        onClick={onDeleteHousehold}
                        disabled={deleteHHBusy}
                        style={{ background: deleteHHBusy ? '#cbd5e1' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)', color:'#fff' }}
                        title="Delete the active household (cascades transactions &amp; budgets)"
                      >
                        {deleteHHBusy ? 'Deleting…' : '🗑️ Delete household'}
                      </button>
                    </div>

                    <div className="card" style={{ padding:16 }}>
                      <h3 style={{ fontSize:14, marginBottom:8, color:'#1e293b' }}>Share / Join</h3>
                      <div style={{ fontSize:13, color:'#475569', marginBottom:8 }}>
                        Share this ID with your wife to join the same workspace: <strong>{householdId}</strong>
                      </div>
                      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                        <input
                          value={joinId}
                          onChange={e=>setJoinId(e.target.value)}
                          placeholder="Enter household ID to join"
                          style={{ flex:'1 1 260px' }}
                        />
                        <button onClick={joinHouseholdById} style={{ background:'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color:'#fff' }}>
                          Join household
                        </button>
                      </div>
                    </div>

                    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', background:'#f8fafc', borderRadius:12, border:'1px solid #e2e8f0' }}>
                      <input
                        type="checkbox"
                        id="neg-spend"
                        checked={negativesAreSpend}
                        onChange={e => {
                          setNegativesAreSpend(e.target.checked);
                          localStorage.setItem('negatives_are_spend', e.target.checked ? '1' : '0');
                        }}
                        style={{ width:20, height:20 }}
                      />
                      <label htmlFor="neg-spend" style={{ fontSize:14, color:'#334155', fontWeight:500, cursor:'pointer' }}>
                        Treat negative amounts as spending (ignore credits/refunds)
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* Stats Cards Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 24 }}>
          <div style={{ 
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', 
            borderRadius: 20, 
            padding: 24, 
            color: '#fff',
            boxShadow: '0 10px 30px rgba(37,99,235,0.3)',
            transform: 'translateY(0)',
            transition: 'all 0.3s',
            cursor: 'pointer'
          }}
          onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-4px)'}
          onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.9 }}>Total Spending</span>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.7"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
            </div>
            <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4 }}>
              ${totals.totalOut.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {from} → {to}
            </div>
          </div>

          <div style={{ 
            background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)', 
            borderRadius: 20, 
            padding: 24, 
            color: '#fff',
            boxShadow: '0 10px 30px rgba(139,92,246,0.3)',
            transform: 'translateY(0)',
            transition: 'all 0.3s',
            cursor: 'pointer'
          }}
          onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-4px)'}
          onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.9 }}>Transactions</span>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.7"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
            </div>
            <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4 }}>
              {filtered.length}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Filtered & Sorted
            </div>
          </div>

          <div style={{ 
            background: 'linear-gradient(135deg, #ec4899 0%, #db2777 100%)', 
            borderRadius: 20, 
            padding: 24, 
            color: '#fff',
            boxShadow: '0 10px 30px rgba(236,72,153,0.3)',
            transform: 'translateY(0)',
            transition: 'all 0.3s',
            cursor: 'pointer'
          }}
          onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-4px)'}
          onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.9 }}>Categories</span>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.7"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
            </div>
            <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4 }}>
              {totals.catRows.length}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Active Categories
            </div>
          </div>
        </div>

        {/* Category Breakdown */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            📊 <span>Category Breakdown</span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {totals.catRows.slice(0, 8).map((row, idx) => (
              <div key={idx} style={{ position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ 
                      width: 14, 
                      height: 14, 
                      borderRadius: '50%', 
                      background: catColorMap[row.category],
                      boxShadow: `0 0 12px ${catColorMap[row.category]}40`,
                      transition: 'all 0.3s'
                    }} />
                    <span style={{ fontSize: 15, fontWeight: 600, color: '#334155' }}>{row.category}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                      ${row.spend.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
                      {row.pct.toFixed(1)}% of total
                    </div>
                  </div>
                </div>
                <div style={{ width: '100%', height: 10, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden', position: 'relative' }}>
                  <div style={{ 
                    height: '100%', 
                    background: `linear-gradient(90deg, ${catColorMap[row.category]} 0%, ${catColorMap[row.category]}dd 100%)`,
                    width: `${row.pct}%`,
                    borderRadius: 999,
                    transition: 'width 0.6s ease-out, opacity 0.3s',
                    boxShadow: `0 0 8px ${catColorMap[row.category]}60`
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Add Spending */}
        <div className="card" style={{ padding: 16, marginBottom: 24, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', margin: 0, display:'flex', alignItems:'center', gap:8 }}>
            ➕ <span>Add Spending</span>
          </h2>
          <button onClick={()=>setShowAdd(true)} style={{ background:'linear-gradient(135deg, #10b981 0%, #059669 100%)', color:'#fff' }}>
            Add Spending
          </button>
        </div>

        {showAdd && (
          <div style={{
            position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', display:'flex',
            alignItems:'center', justifyContent:'center', zIndex:10000, padding:20
          }}>
            <div className="card" style={{ width:'min(720px, 96vw)', padding:24 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <h2 style={{ fontSize:18 }}>Add Spending</h2>
                <button onClick={()=>setShowAdd(false)} className="inline-button">Close</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:16 }}>
                <div>
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:'#475569', marginBottom:8 }}>Date</label>
                  <input 
                    type="date" 
                    value={form.date || ''} 
                    onChange={e=>setForm(f=>({ ...f, date: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:'#475569', marginBottom:8 }}>Merchant</label>
                  <input
                    value={form.merchant || ''}
                    onChange={e=>setForm(f=>({ ...f, merchant: e.target.value }))}
                    placeholder="Woolworths, Coles, etc."
                  />
                </div>
                <div>
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:'#475569', marginBottom:8 }}>Description</label>
                  <input
                    value={form.description || ''}
                    onChange={e=>setForm(f=>({ ...f, description: e.target.value }))}
                    placeholder="Weekly groceries"
                  />
                </div>
                <div>
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:'#475569', marginBottom:8 }}>Amount (AUD)</label>
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
                  />
                </div>
                <div>
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:'#475569', marginBottom:8 }}>Category</label>
                  <div style={{ position:'relative' }}>
                    <div style={{
                      position:'absolute', left:16, top:'50%', transform:'translateY(-50%)',
                      width:12, height:12, borderRadius:'50%', background: catColorMap[form.category || 'Uncategorized'],
                      pointerEvents:'none', zIndex:1
                    }} />
                    <select 
                      value={form.category || 'Uncategorized'} 
                      onChange={e=>setForm(f=>({ ...f, category: e.target.value }))}
                      style={{ paddingLeft:40 }}
                    >
                      {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <button
                onClick={async ()=>{
                  await onAdd();
                  setShowAdd(false);
                }}
                style={{ marginTop:16, width:'100%', background:'linear-gradient(135deg, #10b981 0%, #059669 100%)', color:'#fff' }}
              >
                💾 Save Transaction
              </button>
            </div>
          </div>
        )}

        {/* Import Section */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            📤 <span>Import Transactions</span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={e => e.target.files?.[0] && onImport(e.target.files[0])}
              style={{ 
                padding: 12, 
                border: '2px dashed #cbd5e1', 
                borderRadius: 12, 
                background: '#f8fafc',
                cursor: 'pointer'
              }}
            />
            <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
              💡 Supports CSV and Excel files from your bank statements
            </p>
          </div>
        </div>

        {/* Filters & Sorting */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            🔍 <span>Filters & Sorting</span>
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>From Date</label>
              <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{ width: '100%', fontSize: 16 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>To Date</label>
              <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{ width: '100%', fontSize: 16 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>Sort By</label>
              <select value={sortBy} onChange={e=>setSortBy(e.target.value as any)} style={{ width: '100%', fontSize: 16 }}>
                <option value="date">Date</option>
                <option value="amount">Amount</option>
                <option value="merchant">Merchant</option>
                <option value="category">Category</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>Direction</label>
              <button
                onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                style={{ 
                  width: '100%', 
                  padding: '12px', 
                  background: sortDir === 'desc' ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)',
                  color: sortDir === 'desc' ? '#fff' : '#334155',
                  fontWeight: 600,
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8
                }}
              >
                {sortDir === 'desc' ? '⬇️' : '⬆️'} {sortDir === 'desc' ? 'Descending' : 'Ascending'}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0' }}>
            <input
              type="checkbox"
              id="only-spend"
              checked={onlySpending}
              onChange={e => setOnlySpending(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            <label htmlFor="only-spend" style={{ fontSize: 14, color: '#334155', fontWeight: 500, cursor: 'pointer' }}>
              Show spending only (hide refunds/credits)
            </label>
          </div>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={onClearTransactionsInView}
              disabled={clearBusy || !householdId}
              style={{
                padding: '12px 20px',
                background: clearBusy ? '#cbd5e1' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                color: '#fff',
                fontWeight: 700,
                borderRadius: 12
              }}
            >
              {clearBusy ? 'Clearing…' : '🧹 Clear All in View'}
            </button>
          </div>
        </div>

        {/* Transactions List */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <div 
            onClick={() => setTxnsOpen(!txnsOpen)}
            style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              cursor: 'pointer',
              padding: '4px 0',
              marginBottom: txnsOpen ? 20 : 0
            }}
          >
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              💳 <span>Recent Transactions ({filtered.length})</span>
            </h2>
            <span style={{ fontSize: 24, transition: 'transform 0.3s', transform: txnsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
              ⌄
            </span>
          </div>
          {txnsOpen && (
            <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {filtered.map(txn => (
                <div 
                  key={txn.id}
                  style={{ 
                    padding: 16, 
                    background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                    border: '2px solid #e2e8f0',
                    borderRadius: 16,
                    transition: 'all 0.3s',
                    cursor: 'pointer'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#3b82f6';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(59,130,246,0.15)';
                    e.currentTarget.style.transform = 'translateX(4px)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = '#e2e8f0';
                    e.currentTarget.style.boxShadow = 'none';
                    e.currentTarget.style.transform = 'translateX(0)';
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ 
                          width: 10, 
                          height: 10, 
                          borderRadius: '50%', 
                          background: catColorMap[txn.category || 'Uncategorized'],
                          flexShrink: 0,
                          boxShadow: `0 0 8px ${catColorMap[txn.category || 'Uncategorized']}60`
                        }} />
                        <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {txn.merchant}
                        </span>
                        <span style={{ 
                          fontSize: 11, 
                          padding: '2px 8px', 
                          background: '#f1f5f9', 
                          color: '#64748b', 
                          borderRadius: 6, 
                          fontWeight: 600,
                          flexShrink: 0
                        }}>
                          {txn.person}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {txn.description}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, color: '#94a3b8' }}>
                        <span>📅 {new Date(txn.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>
                        <span>•</span>
                        <span>🏷️ {txn.category || 'Uncategorized'}</span>
                        <span>•</span>
                        <span style={{ fontSize: 10, padding: '1px 6px', background: txn.source === 'import' ? '#dbeafe' : '#fef3c7', color: txn.source === 'import' ? '#1e40af' : '#92400e', borderRadius: 4, fontWeight: 600 }}>
                          {txn.source}
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: txn.amount > 0 ? '#ef4444' : '#10b981', marginBottom: 4 }}>
                        ${Math.abs(txn.amount).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        {editingTxn === txn.id ? (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <select
                              value={txn.category || 'Uncategorized'}
                              onChange={e => onChangeCategory(txn.id!, e.target.value)}
                              onClick={e => e.stopPropagation()}
                              style={{
                                padding: '4px 8px',
                                fontSize: 11,
                                background: '#fff',
                                border: '2px solid #3b82f6',
                                color: '#334155',
                                fontWeight: 600,
                                borderRadius: 6,
                                minWidth: 120
                              }}
                            >
                              {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingTxn(null);
                              }}
                              style={{ 
                                padding: '4px 8px', 
                                fontSize: 11, 
                                background: '#f1f5f9', 
                                color: '#475569',
                                fontWeight: 600,
                                borderRadius: 6
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingTxn(txn.id!);
                              }}
                              style={{ 
                                padding: '4px 8px', 
                                fontSize: 11, 
                                background: '#f1f5f9', 
                                color: '#475569',
                                fontWeight: 600,
                                borderRadius: 6
                              }}
                            >
                              Edit
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm('Delete this transaction?')) onDelete(txn.id!);
                              }}
                              style={{ 
                                padding: '4px 8px', 
                                fontSize: 11, 
                                background: '#fee2e2', 
                                color: '#991b1b',
                                fontWeight: 600,
                                borderRadius: 6
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>🔭</div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>No transactions found</div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>Add a transaction or import from your bank</div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Categories Management */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <div 
            onClick={() => setCatsOpen(!catsOpen)}
            style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              cursor: 'pointer',
              padding: '4px 0'
            }}
          >
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              🎨 <span>Manage Categories</span>
            </h2>
            <span style={{ fontSize: 24, transition: 'transform 0.3s', transform: catsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
              ⌄
            </span>
          </div>
          {catsOpen && (
            <div className="animate-in" style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input
                  value={newCat}
                  onChange={e => setNewCat(e.target.value)}
                  placeholder="New category name..."
                  onKeyDown={e => e.key === 'Enter' && onAddCategory()}
                  style={{ flex: 1, fontSize: 16 }}
                />
                <button
                  onClick={onAddCategory}
                  style={{ 
                    padding: '12px 24px', 
                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', 
                    color: '#fff', 
                    fontWeight: 600,
                    borderRadius: 12
                  }}
                >
                  ➕ Add
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                {cats.map(c => (
                  <div 
                    key={c.id}
                    style={{ 
                      padding: 12, 
                      background: 'linear-gradient(135deg, #f8fafc 0%, #ffffff 100%)',
                      border: '2px solid #e2e8f0',
                      borderRadius: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10
                    }}
                  >
                    <input
                      type="color"
                      value={c.color || colorFor(c.name, 0, c.color)}
                      onChange={e => onSetColor(c, e.target.value)}
                      style={{ width: 32, height: 32, cursor: 'pointer', border: '2px solid #cbd5e1', borderRadius: 8, padding: 2, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#0f172a',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        {c.name}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        onClick={() => onRenameCategory(c)}
                        style={{ padding: '4px 8px', fontSize: 11, background: '#f1f5f9', color: '#475569', fontWeight: 600, borderRadius: 6 }}
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => onDeleteCategory(c)}
                        style={{ padding: '4px 8px', fontSize: 11, background: '#fee2e2', color: '#991b1b', fontWeight: 600, borderRadius: 6 }}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Chart Section */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }} ref={summaryRef}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            📈 <span>Spending Chart for {formatMonth(selectedMonth)}</span>
          </h2>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              style={{ flex: 1, minWidth: 200, fontSize: 16 }}
            >
              {monthsList.map(m => (
                <option key={m.month} value={m.month}>{formatMonth(m.month)}</option>
              ))}
            </select>
            <button
              onClick={exportSummaryPDF}
              style={{ 
                padding: '12px 24px', 
                background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)', 
                color: '#fff', 
                fontWeight: 600,
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8
              }}
            >
              📄 Export PDF
            </button>
          </div>
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            <canvas ref={pieRef} />
          </div>
        </div>

        {/* Import Preview Modal */}
        {showPreview && (
          <div style={{ 
            position: 'fixed', 
            inset: 0, 
            background: 'rgba(0,0,0,0.6)', 
            backdropFilter: 'blur(8px)',
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            zIndex: 9999,
            padding: 20
          }}>
            <div style={{ 
              background: '#fff', 
              borderRadius: 24, 
              maxWidth: 900, 
              width: '100%', 
              maxHeight: '90vh', 
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              padding: 32
            }}>
              <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20, color: '#1e293b' }}>
                📋 Preview & Map Columns
              </h2>
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 14, color: '#64748b', marginBottom: 16 }}>
                  Map your CSV columns to the correct fields:
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Date Column</label>
                    <select value={mapping.date || ''} onChange={e => setMapping(m => ({ ...m, date: e.target.value }))} style={{ width: '100%', fontSize: 14 }}>
                      <option value="">-- Select --</option>
                      {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Description</label>
                    <select value={mapping.desc || ''} onChange={e => setMapping(m => ({ ...m, desc: e.target.value }))} style={{ width: '100%', fontSize: 14 }}>
                      <option value="">-- Select --</option>
                      {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Amount</label>
                    <select value={mapping.amount || ''} onChange={e => setMapping(m => ({ ...m, amount: e.target.value }))} style={{ width: '100%', fontSize: 14 }}>
                      <option value="">-- Select --</option>
                      {previewHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 20, maxHeight: 300, overflow: 'auto', background: '#f8fafc', borderRadius: 12, padding: 12 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
                  Preview (first 5 rows):
                </p>
                <table style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {previewHeaders.slice(0, 5).map(h => <th key={h} style={{ padding: 6, textAlign: 'left', background: '#e2e8f0', borderRadius: 6 }}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        {previewHeaders.slice(0, 5).map(h => <td key={h} style={{ padding: 6, borderBottom: '1px solid #e2e8f0' }}>{String(r[h] || '')}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowPreview(false)}
                  disabled={importBusy}
                  style={{ 
                    padding: '12px 24px', 
                    background: '#f1f5f9', 
                    color: '#475569', 
                    fontWeight: 600,
                    borderRadius: 12
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={commitImport}
                  disabled={importBusy}
                  style={{ 
                    padding: '12px 24px', 
                    background: importBusy ? '#cbd5e1' : 'linear-gradient(135deg, #10b981 0%, #059669 100%)', 
                    color: '#fff', 
                    fontWeight: 600,
                    borderRadius: 12
                  }}
                >
                  {importBusy ? '⏳ Importing...' : '✅ Import'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '24px 0', color: '#94a3b8', fontSize: 13 }}>
          <p style={{ margin: 0 }}>💰 Enhanced Spending Tracker • Made with ❤️</p>
        </div>
      </div>
    </div>
  );
}
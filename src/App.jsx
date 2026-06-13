import { useState, useEffect, useRef, useMemo } from "react";
import { Play, Pause, Check, Plus, Trash2, ChevronDown, ChevronRight, Clock, MapPin, Film, X, Calendar, AlertTriangle, Circle, CheckCircle2, Settings, RotateCcw, Loader2, Pin, GripVertical, ListOrdered, Image as ImageIcon, Maximize2 } from "lucide-react";

const KEY = "filmcrew:schedule:v1";
const imgKeyFor = (shotId) => "filmcrew:img:" + shotId;
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 9);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const seed = () => ({
  title: "Untitled Shoot",
  shootDate: todayISO(),
  dayStartTime: "08:00",
  wrapTime: "18:00",
  updatedAt: Date.now(),
  clientId: "seed",
  locations: [
    { id: uid("loc"), name: "Warehouse — Stage A", setupMinutes: 30, shots: [
      { id: uid("shot"), number: "1A", description: "Wide establishing — hero enters", durationMinutes: 25, status: "pending", startOverride: null, actualRunning: false, actualStartTs: null, actualElapsedMs: 0, actualFinalMs: null, notes: "", imgUpdatedAt: null },
      { id: uid("shot"), number: "1B", description: "Medium — dialogue over shoulder", durationMinutes: 20, status: "pending", startOverride: null, actualRunning: false, actualStartTs: null, actualElapsedMs: 0, actualFinalMs: null, notes: "", imgUpdatedAt: null },
    ]},
    { id: uid("loc"), name: "Rooftop — Golden hour", setupMinutes: 20, shots: [
      { id: uid("shot"), number: "2A", description: "Sunset two-shot", durationMinutes: 30, status: "pending", startOverride: null, actualRunning: false, actualStartTs: null, actualElapsedMs: 0, actualFinalMs: null, notes: "Hard time — light dependent", imgUpdatedAt: null },
    ]},
  ],
});

// ---- time helpers ----
const atTime = (isoDate, hhmm) => {
  const [y, m, d] = (isoDate || todayISO()).split("-").map(Number);
  const [hh, mm] = (hhmm || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
};

const fmtDur = (ms) => {
  ms = Math.max(0, Math.floor(ms));
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

const fmtClock = (d) => {
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
};

const fmtMins = (min) => {
  min = Math.round(min || 0);
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

const liveElapsed = (s, nowMs) => (s.actualRunning && s.actualStartTs ? (s.actualElapsedMs || 0) + (nowMs - s.actualStartTs) : (s.actualElapsedMs || 0));

const timerColor = (rem, planned) => {
  if (rem <= 0) return "text-rose-400";
  if (planned > 0 && rem < planned * 0.15) return "text-amber-300";
  return "text-emerald-300";
};

// Resize an image file to a compact reference frame (data URL).
function fileToThumb(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL("image/jpeg", quality)); } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function computeSchedule(data) {
  const out = { locations: [] };
  let cursor = atTime(data.shootDate, data.dayStartTime);
  for (const loc of data.locations) {
    const setupStart = new Date(cursor);
    cursor = new Date(cursor.getTime() + (Number(loc.setupMinutes) || 0) * 60000);
    const shootStart = new Date(cursor);
    let overlap = false;
    const shots = [];
    for (const shot of loc.shots) {
      if (shot.startOverride) {
        const ov = atTime(data.shootDate, shot.startOverride);
        if (ov.getTime() < cursor.getTime()) overlap = true;
        cursor = ov;
      }
      const start = new Date(cursor);
      cursor = new Date(cursor.getTime() + (Number(shot.durationMinutes) || 0) * 60000);
      const end = new Date(cursor);
      shots.push({ id: shot.id, start, end });
    }
    out.locations.push({ id: loc.id, setupStart, shootStart, blockEnd: new Date(cursor), overlap, shots });
  }
  out.dayStart = atTime(data.shootDate, data.dayStartTime);
  out.scheduledEnd = new Date(cursor);
  return out;
}

function computeProgress(data, nowMs) {
  let varianceMs = 0;
  let remainingMs = 0;
  for (const loc of data.locations) {
    const anyStarted = loc.shots.some((s) => s.status === "active" || s.status === "done" || (s.actualElapsedMs || 0) > 0 || s.actualRunning);
    if (!anyStarted) remainingMs += (Number(loc.setupMinutes) || 0) * 60000;
    for (const s of loc.shots) {
      const planned = (Number(s.durationMinutes) || 0) * 60000;
      if (s.status === "done") {
        const actual = s.actualFinalMs != null ? s.actualFinalMs : (s.actualElapsedMs || 0);
        if (actual > 0) varianceMs += actual - planned;
      } else {
        const live = liveElapsed(s, nowMs);
        remainingMs += Math.max(planned - live, 0);
      }
    }
  }
  return { varianceMs, remainingMs, projectedWrap: new Date(nowMs + remainingMs) };
}

export default function App() {
  const [data, setData] = useState(null);
  const [syncState, setSyncState] = useState("loading");
  const [lastSyncTs, setLastSyncTs] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [collapsed, setCollapsed] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const [confirmDelLoc, setConfirmDelLoc] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [images, setImages] = useState({});      // shotId -> dataURL
  const [uploading, setUploading] = useState({}); // shotId -> bool
  const [lightbox, setLightbox] = useState(null); // dataURL | null

  const clientId = useRef(Math.random().toString(36).slice(2, 10));
  const dataRef = useRef(null);
  const dirtyRef = useRef(false);
  const changeCounter = useRef(0);
  const lastWriteAt = useRef(0);
  const saveTimer = useRef(null);
  const imgVersions = useRef({}); // shotId -> imgUpdatedAt already loaded

  // drag refs
  const dragInfo = useRef(null);
  const lastPos = useRef({ x: 0, y: 0 });
  const appliedRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => { dataRef.current = data; }, [data]);

  async function saveNow(payload) {
    const startCount = changeCounter.current;
    try {
      setSyncState("saving");
      const stamped = { ...payload, updatedAt: Date.now(), clientId: clientId.current };
      await window.storage.set(KEY, JSON.stringify(stamped), true);
      lastWriteAt.current = stamped.updatedAt;
      if (changeCounter.current === startCount) dirtyRef.current = false;
      setSyncState("synced"); setLastSyncTs(Date.now());
    } catch (e) {
      setSyncState("error");
    }
  }

  function scheduleSave() {
    dirtyRef.current = true;
    changeCounter.current++;
    setSyncState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNow(dataRef.current), 800);
  }

  function updateData(updater) {
    setData((prev) => (typeof updater === "function" ? updater(prev) : updater));
    scheduleSave();
  }

  async function pollRemote() {
    if (dragInfo.current) return;
    try {
      const res = await window.storage.get(KEY, true);
      if (res && res.value) {
        const remote = JSON.parse(res.value);
        if ((remote.updatedAt || 0) > lastWriteAt.current && remote.clientId !== clientId.current) {
          if (!dirtyRef.current) {
            lastWriteAt.current = remote.updatedAt;
            setData(remote);
            setSyncState("synced"); setLastSyncTs(Date.now());
          }
        }
      }
    } catch (e) { /* key missing — ignore */ }
  }

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await window.storage.get(KEY, true);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          lastWriteAt.current = parsed.updatedAt || 0;
          if (mounted) { setData(parsed); setSyncState("synced"); setLastSyncTs(Date.now()); }
        } else {
          const s = seed();
          if (mounted) setData(s);
          await saveNow(s);
        }
      } catch (e) {
        try { const s = seed(); if (mounted) setData(s); await saveNow(s); }
        catch (e2) { if (mounted) setSyncState("error"); }
      }
    })();
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    const poll = setInterval(() => pollRemote(), 7000);
    return () => { mounted = false; clearInterval(tick); clearInterval(poll); if (saveTimer.current) clearTimeout(saveTimer.current); if (scrollRef.current) clearInterval(scrollRef.current); };
  }, []);

  // ---- images ----
  async function syncImages(d) {
    for (const l of d.locations) {
      for (const s of l.shots) {
        if (s.imgUpdatedAt && imgVersions.current[s.id] !== s.imgUpdatedAt) {
          try {
            const r = await window.storage.get(imgKeyFor(s.id), true);
            if (r && r.value) { imgVersions.current[s.id] = s.imgUpdatedAt; setImages((prev) => ({ ...prev, [s.id]: r.value })); }
          } catch (e) { /* not available yet */ }
        }
      }
    }
    const present = new Set();
    d.locations.forEach((l) => l.shots.forEach((s) => { if (s.imgUpdatedAt) present.add(s.id); }));
    Object.keys(imgVersions.current).forEach((id) => {
      if (!present.has(id)) { delete imgVersions.current[id]; setImages((prev) => { const n = { ...prev }; delete n[id]; return n; }); }
    });
  }
  useEffect(() => { if (data) syncImages(data); }, [data]);

  async function uploadImage(locId, shotId, file) {
    setUploading((p) => ({ ...p, [shotId]: true }));
    try {
      const url = await fileToThumb(file, 768, 0.62);
      const ts = Date.now();
      await window.storage.set(imgKeyFor(shotId), url, true);
      imgVersions.current[shotId] = ts;
      setImages((prev) => ({ ...prev, [shotId]: url }));
      updateShot(locId, shotId, { imgUpdatedAt: ts });
    } catch (e) {
      setSyncState("error");
    } finally {
      setUploading((p) => { const n = { ...p }; delete n[shotId]; return n; });
    }
  }
  async function removeImage(locId, shotId) {
    try { await window.storage.delete(imgKeyFor(shotId), true); } catch (e) {}
    delete imgVersions.current[shotId];
    setImages((prev) => { const n = { ...prev }; delete n[shotId]; return n; });
    updateShot(locId, shotId, { imgUpdatedAt: null });
  }

  // ---- mutations ----
  const setField = (k, v) => updateData((p) => ({ ...p, [k]: v }));
  const clampInt = (v) => (v === "" ? 0 : Math.max(0, parseInt(v, 10) || 0));

  const addLocation = () => updateData((p) => ({ ...p, locations: [...p.locations, { id: uid("loc"), name: "New location", setupMinutes: 20, shots: [] }] }));
  const updateLocation = (locId, patch) => updateData((p) => ({ ...p, locations: p.locations.map((l) => (l.id === locId ? { ...l, ...patch } : l)) }));
  const removeLocation = (locId) => { updateData((p) => ({ ...p, locations: p.locations.filter((l) => l.id !== locId) })); setConfirmDelLoc(null); };

  const addShot = (locId) => updateData((p) => ({ ...p, locations: p.locations.map((l) => (l.id === locId ? { ...l, shots: [...l.shots, { id: uid("shot"), number: String(l.shots.length + 1), description: "New shot", durationMinutes: 15, status: "pending", startOverride: null, actualRunning: false, actualStartTs: null, actualElapsedMs: 0, actualFinalMs: null, notes: "", imgUpdatedAt: null }] } : l)) }));
  const updateShot = (locId, shotId, patch) => updateData((p) => ({ ...p, locations: p.locations.map((l) => (l.id !== locId ? l : { ...l, shots: l.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)) })) }));
  const removeShot = (locId, shotId) => { updateData((p) => ({ ...p, locations: p.locations.map((l) => (l.id !== locId ? l : { ...l, shots: l.shots.filter((s) => s.id !== shotId) })) })); if (imgVersions.current[shotId]) { window.storage.delete(imgKeyFor(shotId), true).catch(() => {}); delete imgVersions.current[shotId]; setImages((prev) => { const n = { ...prev }; delete n[shotId]; return n; }); } };

  const startShot = (locId, shotId) => updateData((p) => ({ ...p, locations: p.locations.map((loc) => ({ ...loc, shots: loc.shots.map((s) => {
    if (loc.id === locId && s.id === shotId) return { ...s, status: "active", actualRunning: true, actualStartTs: Date.now() };
    if (s.actualRunning && s.actualStartTs) return { ...s, actualRunning: false, actualElapsedMs: (s.actualElapsedMs || 0) + (Date.now() - s.actualStartTs), actualStartTs: null, status: s.status === "done" ? "done" : "active" };
    return s;
  }) })) }));
  const pauseShot = (locId, shotId) => updateData((p) => ({ ...p, locations: p.locations.map((l) => (l.id !== locId ? l : { ...l, shots: l.shots.map((s) => (s.id !== shotId ? s : (s.actualRunning && s.actualStartTs ? { ...s, actualRunning: false, actualElapsedMs: (s.actualElapsedMs || 0) + (Date.now() - s.actualStartTs), actualStartTs: null } : s))) })) }));
  const doneShot = (locId, shotId) => updateData((p) => ({ ...p, locations: p.locations.map((l) => (l.id !== locId ? l : { ...l, shots: l.shots.map((s) => {
    if (s.id !== shotId) return s;
    const finalMs = s.actualRunning && s.actualStartTs ? (s.actualElapsedMs || 0) + (Date.now() - s.actualStartTs) : (s.actualElapsedMs || 0);
    return { ...s, status: "done", actualRunning: false, actualStartTs: null, actualElapsedMs: finalMs, actualFinalMs: finalMs };
  }) })) }));
  const resetShot = (locId, shotId) => updateShot(locId, shotId, { status: "pending", actualRunning: false, actualStartTs: null, actualElapsedMs: 0, actualFinalMs: null });
  const resetDay = () => { updateData((p) => ({ ...p, locations: p.locations.map((l) => ({ ...l, shots: l.shots.map((s) => ({ ...s, status: "pending", actualRunning: false, actualStartTs: null, actualElapsedMs: 0, actualFinalMs: null })) })) })); setConfirmReset(false); };
  const renumberAll = () => updateData((p) => { let n = 0; return { ...p, locations: p.locations.map((l) => ({ ...l, shots: l.shots.map((s) => { n++; return { ...s, number: String(n) }; }) })) }; });

  // ---- drag & drop ----
  function dragShot(x, y) {
    const el = document.elementFromPoint(x, y);
    const targetEl = el && el.closest("[data-locid]");
    if (!targetEl) return;
    const targetLocId = targetEl.dataset.locid;
    const shotEls = Array.from(targetEl.querySelectorAll("[data-shotid]")).filter((n) => n.dataset.shotid !== dragInfo.current.id);
    let beforeId = null;
    for (const n of shotEls) { const r = n.getBoundingClientRect(); if (y < r.top + r.height / 2) { beforeId = n.dataset.shotid; break; } }
    const key = targetLocId + "|" + (beforeId || "END");
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    updateData((prev) => {
      let dragged = null;
      for (const l of prev.locations) { const f = l.shots.find((s) => s.id === dragInfo.current.id); if (f) { dragged = f; break; } }
      if (!dragged) return prev;
      let locs = prev.locations.map((l) => ({ ...l, shots: l.shots.filter((s) => s.id !== dragInfo.current.id) }));
      locs = locs.map((l) => {
        if (l.id !== targetLocId) return l;
        const idx = beforeId ? l.shots.findIndex((s) => s.id === beforeId) : l.shots.length;
        const arr = [...l.shots]; arr.splice(idx < 0 ? arr.length : idx, 0, dragged); return { ...l, shots: arr };
      });
      return { ...prev, locations: locs };
    });
  }

  function dragLoc(x, y) {
    const el = document.elementFromPoint(x, y);
    const targetEl = el && el.closest("[data-locblock]");
    if (!targetEl) return;
    const targetId = targetEl.dataset.locblock;
    const r = targetEl.getBoundingClientRect();
    const before = y < r.top + r.height / 2;
    const key = targetId + "|" + (before ? "B" : "A");
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    updateData((prev) => {
      const arr = [...prev.locations];
      const fromIdx = arr.findIndex((l) => l.id === dragInfo.current.id);
      if (fromIdx < 0) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      const targetIdx = arr.findIndex((l) => l.id === targetId);
      if (targetIdx < 0) { arr.splice(fromIdx, 0, moved); return { ...prev, locations: arr }; }
      arr.splice(before ? targetIdx : targetIdx + 1, 0, moved);
      return { ...prev, locations: arr };
    });
  }

  const doDrag = (x, y) => { const i = dragInfo.current; if (!i) return; if (i.type === "shot") dragShot(x, y); else dragLoc(x, y); };

  function startDrag(e, type, id) {
    e.preventDefault(); e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    dragInfo.current = { type, id };
    appliedRef.current = null;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setDragId(id);
    if (scrollRef.current) clearInterval(scrollRef.current);
    scrollRef.current = setInterval(() => {
      if (!dragInfo.current) return;
      const { x, y } = lastPos.current; const h = window.innerHeight;
      if (y < 90) { window.scrollBy(0, -14); doDrag(x, y); }
      else if (y > h - 90) { window.scrollBy(0, 14); doDrag(x, y); }
    }, 16);
  }
  function moveDrag(e) {
    if (!dragInfo.current) return;
    e.preventDefault();
    lastPos.current = { x: e.clientX, y: e.clientY };
    doDrag(e.clientX, e.clientY);
  }
  function endDrag(e) {
    if (!dragInfo.current) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    dragInfo.current = null; appliedRef.current = null; setDragId(null);
    if (scrollRef.current) { clearInterval(scrollRef.current); scrollRef.current = null; }
  }
  const dragHandlers = (type, id) => ({
    onPointerDown: (e) => startDrag(e, type, id),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    style: { touchAction: "none" },
  });

  // ---- derived ----
  const computed = useMemo(() => (data ? computeSchedule(data) : null), [data]);
  const timesMap = useMemo(() => { const m = {}; if (computed) computed.locations.forEach((l) => l.shots.forEach((s) => { m[s.id] = s; })); return m; }, [computed]);
  const locMap = useMemo(() => { const m = {}; if (computed) computed.locations.forEach((l) => { m[l.id] = l; }); return m; }, [computed]);

  if (!data || !computed) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        <div className="flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Loading schedule…</div>
      </div>
    );
  }

  let running = null, upNext = null;
  for (const loc of data.locations) { for (const s of loc.shots) { if (s.actualRunning) running = { loc, s }; } }
  for (const loc of data.locations) { let f = false; for (const s of loc.shots) { if (s.status !== "done") { upNext = { loc, s }; f = true; break; } } if (f) break; }

  const prog = computeProgress(data, nowMs);
  const wrapSet = !!data.wrapTime;
  const effectiveWrap = wrapSet ? atTime(data.shootDate, data.wrapTime) : computed.scheduledEnd;
  const wrapRemMs = effectiveWrap.getTime() - nowMs;
  const wrapColor = wrapRemMs <= 0 ? "text-rose-400" : wrapRemMs < 30 * 60000 ? "text-amber-300" : "text-emerald-300";

  const diffMs = prog.projectedWrap.getTime() - effectiveWrap.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const span = effectiveWrap.getTime() - computed.dayStart.getTime();
  const frac = span > 0 ? Math.min(1, Math.max(0, (nowMs - computed.dayStart.getTime()) / span)) : 0;
  const totalShots = data.locations.reduce((a, l) => a + l.shots.length, 0);
  const doneShots = data.locations.reduce((a, l) => a + l.shots.filter((s) => s.status === "done").length, 0);

  const syncDot = syncState === "synced" ? "bg-emerald-400" : syncState === "saving" ? "bg-amber-400" : syncState === "error" ? "bg-rose-500" : "bg-slate-500";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-16" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", userSelect: dragId ? "none" : undefined }}>
      {/* Header */}
      <div className="sticky top-0 z-20 backdrop-blur bg-slate-950/85 border-b border-slate-800">
        <div className="max-w-3xl mx-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <Film className="text-amber-400 shrink-0" size={20} />
            <input value={data.title} onChange={(e) => setField("title", e.target.value)} onFocus={(e) => e.target.select()} className="flex-1 bg-transparent text-lg font-semibold outline-none placeholder-slate-500 min-w-0" placeholder="Shoot title" />
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className={`inline-block w-2 h-2 rounded-full ${syncDot} ${syncState === "saving" ? "animate-pulse" : ""}`} />
              <span className="hidden sm:inline">{syncState === "saving" ? "Saving" : syncState === "error" ? "Offline" : lastSyncTs ? `Synced ${fmtClock(new Date(lastSyncTs))}` : "Synced"}</span>
            </div>
            <button onClick={() => setShowSettings((v) => !v)} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-300"><Settings size={17} /></button>
          </div>

          {showSettings && (
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2"><Calendar size={15} className="text-slate-400" /><span className="text-slate-400">Date</span>
                  <input type="date" value={data.shootDate} onChange={(e) => setField("shootDate", e.target.value)} className="bg-slate-800 rounded-md px-2 py-1 outline-none" /></label>
                <label className="flex items-center gap-2"><Clock size={15} className="text-slate-400" /><span className="text-slate-400">Day start</span>
                  <input type="time" value={data.dayStartTime} onChange={(e) => setField("dayStartTime", e.target.value)} className="bg-slate-800 rounded-md px-2 py-1 outline-none" /></label>
                <label className="flex items-center gap-2"><Clock size={15} className="text-amber-400" /><span className="text-slate-400">Wrap target</span>
                  <input type="time" value={data.wrapTime || ""} onChange={(e) => setField("wrapTime", e.target.value || "")} className="bg-slate-800 rounded-md px-2 py-1 outline-none" /></label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {confirmReset ? (
                  <>
                    <button onClick={resetDay} className="inline-flex items-center gap-1 rounded-lg bg-rose-600 hover:bg-rose-500 px-3 py-1.5 text-xs font-medium"><RotateCcw size={14} /> Confirm reset</button>
                    <button onClick={() => setConfirmReset(false)} className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs">Cancel</button>
                    <span className="text-xs text-slate-400">Clears timers & statuses. Plan stays.</span>
                  </>
                ) : (
                  <button onClick={() => setConfirmReset(true)} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs"><RotateCcw size={14} /> Reset day (clear timers)</button>
                )}
                <button onClick={renumberAll} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs"><ListOrdered size={14} /> Renumber shots 1…{totalShots}</button>
              </div>
              <p className="text-xs text-amber-300/80 flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> This schedule and its photos are shared. Everyone with the link sees and edits the same data in real time.</p>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4">
        {/* WRAP COUNTDOWN — main timer */}
        <div className="mt-4 rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 overflow-hidden">
          <div className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">Time to wrap</div>
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <Clock size={13} /> target
                <input type="time" value={data.wrapTime || ""} onChange={(e) => setField("wrapTime", e.target.value || "")} className="bg-slate-800 rounded-md px-2 py-1 text-slate-100 outline-none" />
              </label>
            </div>
            <div className={`mt-1 font-mono tabular-nums text-6xl sm:text-7xl leading-none ${wrapColor}`}>{wrapRemMs >= 0 ? fmtDur(wrapRemMs) : `+${fmtDur(-wrapRemMs)}`}</div>
            <div className="mt-1 text-xs text-slate-400">
              {wrapRemMs >= 0 ? `until ${fmtClock(effectiveWrap)} wrap` : `past ${fmtClock(effectiveWrap)} wrap`}
              {!wrapSet && <span className="text-slate-500"> · auto from schedule — set a target above</span>}
            </div>
          </div>

          {/* Active shot bar */}
          <div className="border-t border-slate-800 bg-slate-950/40 px-4 py-3">
            {running ? (() => {
              const planned = (Number(running.s.durationMinutes) || 0) * 60000;
              const live = liveElapsed(running.s, nowMs);
              const rem = planned - live;
              return (
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-400 truncate">Now shooting · {running.loc.name} · {running.s.number}</div>
                    <div className="text-sm font-medium truncate">{running.s.description || "Untitled shot"}</div>
                  </div>
                  <div className={`font-mono tabular-nums text-xl shrink-0 ${timerColor(rem, planned)}`}>{rem >= 0 ? fmtDur(rem) : `+${fmtDur(-rem)}`}</div>
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => pauseShot(running.loc.id, running.s.id)} className="inline-flex items-center gap-1 rounded-lg bg-amber-500/20 text-amber-200 border border-amber-500/40 hover:bg-amber-500/30 px-2.5 py-1.5 text-xs font-medium"><Pause size={14} /> Pause</button>
                    <button onClick={() => doneShot(running.loc.id, running.s.id)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 px-2.5 py-1.5 text-xs font-medium"><Check size={14} /> Wrap</button>
                  </div>
                </div>
              );
            })() : upNext ? (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="inline-block w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-sky-300 truncate">Up next · {upNext.loc.name} · {upNext.s.number}</div>
                  <div className="text-sm font-medium truncate">{upNext.s.description || "Untitled shot"}{timesMap[upNext.s.id] ? ` · ${fmtClock(timesMap[upNext.s.id].start)}` : ""} · {fmtMins(upNext.s.durationMinutes)}</div>
                </div>
                <button onClick={() => startShot(upNext.loc.id, upNext.s.id)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-4 py-2 text-sm font-semibold shrink-0"><Play size={15} /> {(upNext.s.actualElapsedMs || 0) > 0 ? "Resume" : "Start"}</button>
              </div>
            ) : (
              <div className="text-center text-sm text-slate-300 py-1">All {totalShots} shots wrapped 🎬</div>
            )}
          </div>

          {/* Day strip */}
          <div className="border-t border-slate-800 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              <div><span className="text-slate-500">Target</span> <span className="font-medium">{fmtClock(effectiveWrap)}</span></div>
              <div><span className="text-slate-500">Projected</span> <span className={`font-medium ${diffMs > 60000 ? "text-rose-300" : diffMs < -60000 ? "text-emerald-300" : "text-slate-200"}`}>{fmtClock(prog.projectedWrap)}</span></div>
              <div className={`px-2 py-0.5 rounded-full font-medium ${diffMin > 1 ? "bg-rose-500/15 text-rose-300" : diffMin < -1 ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/50 text-slate-300"}`}>
                {diffMin > 1 ? `${diffMin}m over target` : diffMin < -1 ? `${-diffMin}m under target` : "on target"}
              </div>
              <div className="ml-auto text-slate-400">{doneShots}/{totalShots} shots</div>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-amber-400 to-emerald-400" style={{ width: `${frac * 100}%` }} />
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span className="flex items-center gap-1"><Circle size={9} className="fill-slate-500 text-slate-500" /> Pending</span>
          <span className="flex items-center gap-1"><Circle size={9} className="fill-amber-400 text-amber-400" /> In progress</span>
          <span className="flex items-center gap-1"><CheckCircle2 size={11} className="text-emerald-400" /> Done</span>
          <span className="flex items-center gap-1"><Pin size={11} className="text-sky-400" /> Pinned time</span>
          <span className="flex items-center gap-1"><GripVertical size={12} /> Drag to reorder</span>
        </div>

        {/* Locations */}
        <div className="mt-3 space-y-4">
          {data.locations.map((loc) => {
            const lc = locMap[loc.id];
            const isCollapsed = !!collapsed[loc.id];
            const locDone = loc.shots.length > 0 && loc.shots.every((s) => s.status === "done");
            const dragging = dragId === loc.id;
            return (
              <div key={loc.id} data-locblock={loc.id} data-locid={loc.id} className={`rounded-2xl border bg-slate-900/40 transition-shadow ${dragging ? "border-amber-400 ring-2 ring-amber-400 shadow-2xl shadow-black/60 relative z-10" : "border-slate-800"}`}>
                {/* Location header */}
                <div className="p-3 sm:p-4">
                  <div className="flex items-center gap-1.5">
                    <div {...dragHandlers("loc", loc.id)} className="cursor-grab active:cursor-grabbing p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 shrink-0" title="Drag to reorder location"><GripVertical size={17} /></div>
                    <button onClick={() => setCollapsed((c) => ({ ...c, [loc.id]: !c[loc.id] }))} className="p-1 rounded-md hover:bg-slate-800 text-slate-400">{isCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}</button>
                    <MapPin size={16} className={locDone ? "text-emerald-400" : "text-amber-400"} />
                    <input value={loc.name} onChange={(e) => updateLocation(loc.id, { name: e.target.value })} onFocus={(e) => e.target.select()} className="flex-1 bg-transparent font-semibold outline-none min-w-0" placeholder="Location name" />
                    <button onClick={() => setConfirmDelLoc(loc.id)} className="p-1 rounded-md hover:bg-rose-500/20 text-rose-400/80 shrink-0"><Trash2 size={15} /></button>
                  </div>
                  <div className="mt-2 ml-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
                    <label className="flex items-center gap-1.5">Setup
                      <input type="number" inputMode="numeric" min="0" value={loc.setupMinutes} onChange={(e) => updateLocation(loc.id, { setupMinutes: clampInt(e.target.value) })} onFocus={(e) => e.target.select()} className="w-14 bg-slate-800 rounded-md px-2 py-0.5 text-center text-slate-100 outline-none" /> min
                    </label>
                    {lc && <span className="flex items-center gap-1"><Clock size={12} /> {fmtClock(lc.setupStart)} – {fmtClock(lc.blockEnd)}</span>}
                    {lc && <span className="text-slate-500">shoot from {fmtClock(lc.shootStart)}</span>}
                    {lc && lc.overlap && <span className="flex items-center gap-1 text-amber-300"><AlertTriangle size={12} /> pinned time overlaps prior block</span>}
                  </div>

                  {confirmDelLoc === loc.id && (
                    <div className="mt-2 ml-8 flex items-center gap-2 text-xs flex-wrap">
                      <span className="text-rose-300">Delete this location and its {loc.shots.length} shot{loc.shots.length === 1 ? "" : "s"}?</span>
                      <button onClick={() => removeLocation(loc.id)} className="rounded-md bg-rose-600 hover:bg-rose-500 px-2.5 py-1 font-medium">Delete</button>
                      <button onClick={() => setConfirmDelLoc(null)} className="rounded-md bg-slate-700 hover:bg-slate-600 px-2.5 py-1">Cancel</button>
                    </div>
                  )}
                </div>

                {/* Shots */}
                {!isCollapsed && (
                  <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2">
                    {loc.shots.length === 0 && (
                      <div className="rounded-xl border border-dashed border-slate-800 text-xs text-slate-500 text-center py-3">No shots yet — add one, or drag a shot here.</div>
                    )}
                    {loc.shots.map((s) => {
                      const t = timesMap[s.id];
                      const planned = (Number(s.durationMinutes) || 0) * 60000;
                      const isRunning = s.actualRunning;
                      const live = liveElapsed(s, nowMs);
                      const rem = planned - live;
                      const dot = s.status === "done" ? "fill-emerald-400 text-emerald-400" : (s.status === "active" || isRunning) ? "fill-amber-400 text-amber-400" : "fill-slate-600 text-slate-600";
                      const sDrag = dragId === s.id;
                      const photo = images[s.id];
                      return (
                        <div key={s.id} data-shotid={s.id} className={`rounded-xl border p-3 transition-shadow ${sDrag ? "border-amber-400 ring-2 ring-amber-400 shadow-2xl shadow-black/60 scale-105 relative z-10 bg-slate-900" : isRunning ? "border-amber-500/50 bg-amber-500/5" : s.status === "done" ? "border-slate-800 bg-slate-900/30" : "border-slate-800 bg-slate-900/50"}`}>
                          <div className="flex items-start gap-1.5">
                            <div {...dragHandlers("shot", s.id)} className="cursor-grab active:cursor-grabbing p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 shrink-0 mt-0.5" title="Drag to reorder shot"><GripVertical size={15} /></div>
                            {s.status === "done" ? <CheckCircle2 size={16} className="text-emerald-400 mt-1 shrink-0" /> : <Circle size={12} className={`mt-1.5 shrink-0 ${dot}`} />}
                            <input value={s.number} onChange={(e) => updateShot(loc.id, s.id, { number: e.target.value })} onFocus={(e) => e.target.select()} className="w-12 bg-slate-800 rounded-md px-1.5 py-1 text-center text-xs font-mono outline-none shrink-0" placeholder="#" />
                            <input value={s.description} onChange={(e) => updateShot(loc.id, s.id, { description: e.target.value })} onFocus={(e) => e.target.select()} className={`flex-1 bg-transparent text-sm outline-none min-w-0 ${s.status === "done" ? "text-slate-400" : ""}`} placeholder="Shot description" />
                            <button onClick={() => removeShot(loc.id, s.id)} className="p-1 rounded text-rose-400/70 hover:bg-rose-500/20 shrink-0"><Trash2 size={13} /></button>
                          </div>

                          <div className="mt-2 ml-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                            <label className="flex items-center gap-1 text-slate-400">Dur
                              <input type="number" inputMode="numeric" min="0" value={s.durationMinutes} onChange={(e) => updateShot(loc.id, s.id, { durationMinutes: clampInt(e.target.value) })} onFocus={(e) => e.target.select()} className="w-12 bg-slate-800 rounded-md px-1.5 py-0.5 text-center text-slate-100 outline-none" /> m
                            </label>
                            {t && <span className="text-slate-400 flex items-center gap-1"><Clock size={11} /> {fmtClock(t.start)}–{fmtClock(t.end)}</span>}
                            <label className={`flex items-center gap-1 ${s.startOverride ? "text-sky-300" : "text-slate-500"}`}>
                              <Pin size={11} /> <input type="time" value={s.startOverride || ""} onChange={(e) => updateShot(loc.id, s.id, { startOverride: e.target.value || null })} className="bg-slate-800 rounded-md px-1.5 py-0.5 text-slate-100 outline-none" />
                              {s.startOverride && <button onClick={() => updateShot(loc.id, s.id, { startOverride: null })} className="p-0.5 rounded hover:bg-slate-700"><X size={12} /></button>}
                            </label>
                            {(isRunning || (s.actualElapsedMs || 0) > 0) && (
                              <span className={`font-mono tabular-nums ${isRunning ? timerColor(rem, planned) : "text-slate-400"}`}>
                                {isRunning ? (rem >= 0 ? `${fmtDur(rem)} left` : `+${fmtDur(-rem)} over`) : `${fmtDur(s.actualFinalMs != null ? s.actualFinalMs : s.actualElapsedMs)} logged`}
                              </span>
                            )}
                          </div>

                          {/* Reference photo */}
                          <div className="mt-2 ml-6 flex items-center gap-2 flex-wrap">
                            {photo && (
                              <button onClick={() => setLightbox(photo)} className="relative group rounded-lg overflow-hidden border border-slate-700 shrink-0" title="View larger">
                                <img src={photo} alt="reference" className="h-14 w-14 object-cover block" />
                                <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors"><Maximize2 size={14} className="opacity-0 group-hover:opacity-100 text-white" /></span>
                              </button>
                            )}
                            {uploading[s.id] ? (
                              <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Loader2 size={13} className="animate-spin" /> Processing photo…</span>
                            ) : (
                              <label className="inline-flex items-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-xs text-slate-300 cursor-pointer">
                                <ImageIcon size={13} /> {photo ? "Replace photo" : "Add photo"}
                                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) uploadImage(loc.id, s.id, f); e.target.value = ""; }} />
                              </label>
                            )}
                            {photo && !uploading[s.id] && (
                              <button onClick={() => removeImage(loc.id, s.id)} className="text-xs text-rose-400/80 hover:text-rose-300 px-1">Remove</button>
                            )}
                          </div>

                          <div className="mt-2 ml-6 flex items-center gap-2 flex-wrap">
                            <input value={s.notes} onChange={(e) => updateShot(loc.id, s.id, { notes: e.target.value })} className="flex-1 min-w-0 bg-transparent text-xs text-slate-400 outline-none border-b border-transparent focus:border-slate-700" placeholder="Notes — camera, lens, talent…" />
                            <div className="flex gap-1.5 shrink-0">
                              {s.status === "done" ? (
                                <button onClick={() => resetShot(loc.id, s.id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-xs text-slate-300"><RotateCcw size={13} /> Reopen</button>
                              ) : isRunning ? (
                                <>
                                  <button onClick={() => pauseShot(loc.id, s.id)} className="inline-flex items-center gap-1 rounded-lg bg-amber-500/20 text-amber-200 border border-amber-500/40 hover:bg-amber-500/30 px-2.5 py-1.5 text-xs font-medium"><Pause size={13} /> Pause</button>
                                  <button onClick={() => doneShot(loc.id, s.id)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 px-2.5 py-1.5 text-xs font-medium"><Check size={13} /> Wrap</button>
                                </>
                              ) : (
                                <>
                                  <button onClick={() => startShot(loc.id, s.id)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-2.5 py-1.5 text-xs font-semibold"><Play size={13} /> {(s.actualElapsedMs || 0) > 0 ? "Resume" : "Start"}</button>
                                  <button onClick={() => doneShot(loc.id, s.id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-xs text-slate-300"><Check size={13} /> Done</button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <button onClick={() => addShot(loc.id)} className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-700 hover:border-slate-500 hover:bg-slate-800/40 py-2 text-sm text-slate-400"><Plus size={15} /> Add shot</button>
                  </div>
                )}
              </div>
            );
          })}

          <button onClick={addLocation} className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-700 hover:border-amber-500/60 hover:bg-amber-500/5 py-3 text-sm font-medium text-slate-300"><Plus size={17} /> Add location</button>
        </div>

        <p className="mt-6 text-center text-xs text-slate-600">Shared & synced across your crew · auto-saves continuously</p>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="reference" className="max-h-full max-w-full rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 p-2 rounded-full bg-slate-900/80 text-slate-200 hover:bg-slate-800"><X size={20} /></button>
        </div>
      )}
    </div>
  );
}

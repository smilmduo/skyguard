import { useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer
} from 'recharts';

function cn(...inputs) {
  return twMerge(clsx(inputs));
}

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function App() {
  const [clock, setClock] = useState('');
  const [activeTab, setActiveTab] = useState('telemetry'); // 'telemetry' | 'multi_station' | 'anomaly_history' | 'sensor_health'

  // Data states
  const [telemetry, setTelemetry] = useState([]);
  const [multiStationData, setMultiStationData] = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [sensorHealth, setSensorHealth] = useState(null);

  // Simulation & Selection states
  const [activeFault, setActiveFault] = useState(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const [selectedHistoricalAnomaly, setSelectedHistoricalAnomaly] = useState(null);
  const [showDrawer, setShowDrawer] = useState(true);

  // Anomaly filter states
  const [anomalySearch, setAnomalySearch] = useState('');
  const [anomalyFilterFlag, setAnomalyFilterFlag] = useState('ALL');

  // IMD Weather & Forecasting States (API-3, API-1/2, API-4/7, API-9)
  const [imdStation, setImdStation] = useState('lucknow');
  const [imdCurrent, setImdCurrent] = useState(null);
  const [imdForecast, setImdForecast] = useState(null);
  const [imdNowcast, setImdNowcast] = useState(null);
  const [imdAws, setImdAws] = useState(null);
  const [imdStatus, setImdStatus] = useState(null);
  const [imdLoading, setImdLoading] = useState(false);
  const [showImdModal, setShowImdModal] = useState(false);
  const [imdApiKeyInput, setImdApiKeyInput] = useState('');
  const [imdJwtTokenInput, setImdJwtTokenInput] = useState('');
  const [imdConfigStatus, setImdConfigStatus] = useState(null);
  const [isIngestingImd, setIsIngestingImd] = useState(false);

  // Clock timer
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      setClock(`${hours}:${minutes}:${seconds}`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch telemetry history
  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/telemetry/history?hours=24`);
      if (res.ok) {
        const data = await res.json();
        setTelemetry(data);
      }
    } catch (err) {
      console.error('Failed to fetch telemetry', err);
    }
  }, []);

  // Fetch multi-station consensus
  const fetchMultiStation = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/telemetry/multi-station?hours=24`);
      if (res.ok) {
        const data = await res.json();
        setMultiStationData(data);
      }
    } catch (err) {
      console.error('Failed to fetch multi-station telemetry', err);
    }
  }, []);

  // Fetch historical anomalies
  const fetchAnomalies = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/telemetry/anomalies?limit=100`);
      if (res.ok) {
        const data = await res.json();
        setAnomalies(data);
      }
    } catch (err) {
      console.error('Failed to fetch anomalies', err);
    }
  }, []);

  // Fetch sensor health & predictive maintenance
  const fetchSensorHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sensor/health`);
      if (res.ok) {
        const data = await res.json();
        setSensorHealth(data);
      }
    } catch (err) {
      console.error('Failed to fetch sensor health', err);
    }
  }, []);

  // Fetch IMD data
  const fetchImdData = useCallback(async (stn = imdStation) => {
    try {
      setImdLoading(true);
      const [resCurr, resFc, resNc, resAws, resSt] = await Promise.allSettled([
        fetch(`${API_BASE}/api/imd/current?station=${stn}`),
        fetch(`${API_BASE}/api/imd/forecast?station=${stn}`),
        fetch(`${API_BASE}/api/imd/nowcast?station=${stn}`),
        fetch(`${API_BASE}/api/imd/aws?state_id=5`),
        fetch(`${API_BASE}/api/imd/status`)
      ]);
      if (resCurr.status === 'fulfilled' && resCurr.value.ok) setImdCurrent(await resCurr.value.json());
      if (resFc.status === 'fulfilled' && resFc.value.ok) setImdForecast(await resFc.value.json());
      if (resNc.status === 'fulfilled' && resNc.value.ok) setImdNowcast(await resNc.value.json());
      if (resAws.status === 'fulfilled' && resAws.value.ok) setImdAws(await resAws.value.json());
      if (resSt.status === 'fulfilled' && resSt.value.ok) setImdStatus(await resSt.value.json());
    } catch (err) {
      console.error('Failed to fetch IMD data', err);
    } finally {
      setImdLoading(false);
    }
  }, [imdStation]);

  const handleSelectImdStation = (stn) => {
    setImdStation(stn);
    fetchImdData(stn);
  };

  const handleConfigureImd = async (e) => {
    e.preventDefault();
    try {
      setImdConfigStatus('Saving...');
      const res = await fetch(`${API_BASE}/api/imd/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: imdApiKeyInput, jwt_token: imdJwtTokenInput })
      });
      if (res.ok) {
        setImdConfigStatus('Credentials Updated Successfully!');
        setTimeout(() => {
          setShowImdModal(false);
          setImdConfigStatus(null);
        }, 1200);
        fetchImdData(imdStation);
      } else {
        setImdConfigStatus('Failed to update credentials.');
      }
    } catch (err) {
      setImdConfigStatus('Error connecting to backend.');
    }
  };

  const handleIngestImdToBuffer = async () => {
    try {
      setIsIngestingImd(true);
      const res = await fetch(`${API_BASE}/api/imd/poll-cluster`, { method: 'POST' });
      if (res.ok) {
        await fetchAll();
      }
    } catch (err) {
      console.error('Failed to ingest IMD telemetry', err);
    } finally {
      setIsIngestingImd(false);
    }
  };

  // Fetch all endpoints concurrently
  const fetchAll = useCallback(async () => {
    await Promise.allSettled([
      fetchTelemetry(),
      fetchMultiStation(),
      fetchAnomalies(),
      fetchSensorHealth(),
      fetchImdData(imdStation)
    ]);
  }, [fetchTelemetry, fetchMultiStation, fetchAnomalies, fetchSensorHealth, fetchImdData, imdStation]);

  // Initial & periodic load
  useEffect(() => {
    fetchAll();
    const timer = setInterval(fetchAll, 30000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  // Fault injection simulation
  const triggerFault = async (type, param, magnitude, faultLabel) => {
    try {
      setIsTriggering(true);
      setActiveFault(faultLabel);
      await fetch(`${API_BASE}/api/fault/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ station: 'lucknow', type, param, magnitude })
      });
      await fetchAll();
    } catch (err) {
      console.error('Failed to inject fault', err);
    } finally {
      setIsTriggering(false);
    }
  };

  // Reset to live pristine data
  const resetData = async () => {
    try {
      setIsTriggering(true);
      setActiveFault(null);
      setSelectedHistoricalAnomaly(null);
      await fetch(`${API_BASE}/api/fault/reset`, { method: 'POST' });
      await fetchAll();
    } catch (err) {
      console.error('Failed to reset', err);
    } finally {
      setIsTriggering(false);
    }
  };

  // Clear forensic audit log
  const clearAnomalies = async () => {
    try {
      await fetch(`${API_BASE}/api/telemetry/anomalies/clear`, { method: 'POST' });
      setSelectedHistoricalAnomaly(null);
      await fetchAnomalies();
    } catch (err) {
      console.error('Failed to clear anomalies', err);
    }
  };

  // Export anomalies audit log to CSV
  const exportToCSV = () => {
    if (!anomalies.length) return;
    const headers = [
      'Timestamp (UTC)',
      'Root Cause',
      'QC Flag',
      'Anomaly Score',
      'Confidence (%)',
      'Raw Temp (C)',
      'Healed Temp (C)',
      'Raw Pres (hPa)',
      'Healed Pres (hPa)',
      'Raw RH (%)',
      'Healed RH (%)',
      'Top Driver',
      'Top Driver SHAP'
    ];

    const rows = anomalies.map(a => {
      const topD = a.top_drivers?.[0];
      return [
        `"${a.timestamp || ''}"`,
        `"${(a.root_cause || '').replace(/"/g, '""')}"`,
        a.qc_flag ?? 0,
        a.anomaly_score ?? '',
        a.confidence ?? '',
        a.raw_temp ?? '',
        a.healed_temp ?? '',
        a.raw_pres ?? '',
        a.healed_pres ?? '',
        a.raw_rh ?? '',
        a.healed_rh ?? '',
        `"${(topD?.label || topD?.feature || '').replace(/"/g, '""')}"`,
        topD?.attribution ?? ''
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `skyguard_anomaly_audit_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filtered anomalies for Tab 3
  const filteredAnomalies = useMemo(() => {
    return anomalies.filter(item => {
      if (anomalyFilterFlag !== 'ALL' && String(item.qc_flag) !== anomalyFilterFlag) {
        return false;
      }
      if (anomalySearch.trim()) {
        const q = anomalySearch.toLowerCase();
        const rc = (item.root_cause || '').toLowerCase();
        const drivers = (item.top_drivers || []).map(d => d.label || d.feature).join(' ').toLowerCase();
        const ts = (item.timestamp || '').toLowerCase();
        if (!rc.includes(q) && !drivers.includes(q) && !ts.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [anomalies, anomalyFilterFlag, anomalySearch]);

  const latest = telemetry.length > 0 ? telemetry[telemetry.length - 1] : null;

  // Active record for the Diagnostic SHAP Drawer:
  // If user selected a historical anomaly in Tab 3, inspect that; otherwise inspect latest live record.
  const activeInspection = selectedHistoricalAnomaly || latest;

  if (telemetry.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-slate-400 bg-slate-950 font-data-mono-lg gap-3">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        <span>Initializing SkyGuard Fast Specialist & SHAP Pipeline...</span>
      </div>
    );
  }

  // Max SHAP attribution for scaling bar chart
  const maxShapAttr = activeInspection?.top_drivers?.length
    ? Math.max(...activeInspection.top_drivers.map(d => Math.abs(d.attribution || 0)), 0.1)
    : 1.0;

  // Multi-station latest record for residuals and badges
  const msLatest = multiStationData.length > 0 ? multiStationData[multiStationData.length - 1] : null;

  return (
    <div className="bg-slate-950 text-on-surface antialiased font-body-sm h-screen flex flex-col relative overflow-hidden">
      {/* Top Header */}
      <header className="bg-surface border-b border-outline-variant flex justify-between items-center w-full px-panel-padding h-12 z-50 shrink-0">
        <div className="flex items-center gap-4">
          <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>monitor_heart</span>
          <h1 className="font-headline-md font-bold text-primary tracking-tight">SkyGuard AI</h1>
          <span className="font-label-caps text-on-surface-variant ml-4 border-l border-outline-variant pl-4">LUCKNOW_CLUSTER_V2</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className={cn(
              "w-2.5 h-2.5 rounded-full",
              latest?.sensor_health_status === 'HEALTHY' ? "bg-wmo-emerald glow-emerald" :
                latest?.sensor_health_status === 'WATCH' ? "bg-wmo-amber glow-amber" :
                  "bg-wmo-rose glow-rose-pulse"
            )}></span>
            <span className={cn(
              "font-label-caps font-bold text-xs",
              latest?.sensor_health_status === 'HEALTHY' ? "text-wmo-emerald" :
                latest?.sensor_health_status === 'WATCH' ? "text-wmo-amber" : "text-wmo-rose"
            )}>
              {latest?.sensor_health_status ? `SYS_${latest.sensor_health_status}` : 'CLUSTER_HEALTH_0'}
            </span>
          </div>
          <div className="font-data-mono-lg text-primary text-sm font-semibold">{clock}</div>
        </div>
      </header>

      {/* WMO Quality Flag Legend & Active Fault Bar */}
      <div className="bg-surface-container-lowest border-b border-outline-variant/30 px-4 py-1.5 flex justify-between items-center text-[11px] font-label-caps shrink-0">
        <div className="flex gap-6 items-center">
          <span className="text-on-surface-variant font-semibold">WMO 306 FLAGS:</span>
          <div className="flex items-center gap-1.5" title="Pristine Data"><span className="w-1.5 h-1.5 rounded-full bg-wmo-emerald"></span> Flag 0 (Pristine)</div>
          <div className="flex items-center gap-1.5" title="Suspect Data"><span className="w-1.5 h-1.5 rounded-full bg-wmo-amber"></span> Flag 1 (Suspect)</div>
          <div className="flex items-center gap-1.5" title="Spatial IDW Healed"><span className="w-1.5 h-1.5 rounded-full bg-wmo-skyblue"></span> Flag 2 (Spatial IDW)</div>
          <div className="flex items-center gap-1.5" title="Cubic Spline Healed"><span className="w-1.5 h-1.5 rounded-full bg-wmo-violet"></span> Flag 3 (Cubic Spline)</div>
        </div>
        {activeFault && (
          <div className="flex items-center gap-2 bg-wmo-rose/10 border border-wmo-rose/30 px-2 py-0.5 rounded text-wmo-rose text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-wmo-rose animate-ping"></span>
            <span>ACTIVE SIMULATION: {activeFault}</span>
          </div>
        )}
      </div>

      {/* 3-Column Dashboard Body */}
      <main className="dashboard-grid relative flex-1" style={{ gridTemplateColumns: `240px 1fr ${showDrawer ? '380px' : '0px'}` }}>
        {/* Left Navigation Panel with Tabs */}
        <nav className="dashboard-panel flex flex-col relative z-40 bg-surface-container-lowest border-r border-outline-variant/40">
          <div className="p-3.5 border-b border-outline-variant/40 shrink-0">
            <h2 className="font-label-caps text-on-surface-variant text-[11px] tracking-wider">OPERATIONAL_VIEWS</h2>
          </div>

          <div className="flex-1 overflow-y-auto py-2 flex flex-col gap-1 px-2">
            {/* Tab 1: Live Stream */}
            <button
              id="tab-telemetry"
              onClick={() => setActiveTab('telemetry')}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded text-left transition-all font-label-caps text-xs",
                activeTab === 'telemetry'
                  ? "bg-secondary-container/20 text-secondary border-l-2 border-secondary font-bold"
                  : "text-slate-400 hover:text-on-surface hover:bg-slate-900/60"
              )}
            >
              <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: activeTab === 'telemetry' ? "'FILL' 1" : "'FILL' 0" }}>
                analytics
              </span>
              <span>Live Stream & Detection</span>
            </button>

            {/* Tab 2: Mesonetwork Consensus */}
            <button
              id="tab-btn-consensus"
              data-testid="tab-multi_station"
              onClick={() => setActiveTab('multi_station')}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded text-left transition-all font-label-caps text-xs",
                activeTab === 'multi_station'
                  ? "bg-primary-container/20 text-primary border-l-2 border-primary font-bold"
                  : "text-slate-400 hover:text-on-surface hover:bg-slate-900/60"
              )}
            >
              <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: activeTab === 'multi_station' ? "'FILL' 1" : "'FILL' 0" }}>
                hub
              </span>
              <span>Mesonetwork Consensus</span>
            </button>

            {/* Tab 3: Anomaly History & Audit Log */}
            <button
              id="tab-btn-history"
              data-testid="tab-anomaly_history"
              onClick={() => setActiveTab('anomaly_history')}
              className={cn(
                "flex items-center justify-between px-3 py-2.5 rounded text-left transition-all font-label-caps text-xs",
                activeTab === 'anomaly_history'
                  ? "bg-wmo-amber/20 text-wmo-amber border-l-2 border-wmo-amber font-bold"
                  : "text-slate-400 hover:text-on-surface hover:bg-slate-900/60"
              )}
            >
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: activeTab === 'anomaly_history' ? "'FILL' 1" : "'FILL' 0" }}>
                  history
                </span>
                <span>Anomaly Audit Log</span>
              </div>
              {anomalies.length > 0 && (
                <span className="bg-wmo-amber/30 text-wmo-amber text-[10px] px-1.5 py-0.2 rounded-full font-data-mono-lg">
                  {anomalies.length}
                </span>
              )}
            </button>

            {/* Tab 4: Sensor Health & Maintenance */}
            <button
              id="tab-btn-health"
              data-testid="tab-sensor_health"
              onClick={() => setActiveTab('sensor_health')}
              className={cn(
                "flex items-center justify-between px-3 py-2.5 rounded text-left transition-all font-label-caps text-xs",
                activeTab === 'sensor_health'
                  ? "bg-wmo-emerald/20 text-wmo-emerald border-l-2 border-wmo-emerald font-bold"
                  : "text-slate-400 hover:text-on-surface hover:bg-slate-900/60"
              )}
            >
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: activeTab === 'sensor_health' ? "'FILL' 1" : "'FILL' 0" }}>
                  health_and_safety
                </span>
                <span>Sensor Health & Maint.</span>
              </div>
              {sensorHealth?.health_indices && (
                <span className="text-[10px] font-data-mono-lg text-wmo-emerald">
                  {sensorHealth.health_indices.cluster_composite}%
                </span>
              )}
            </button>

            {/* Tab 5: IMD Real-Time Weather Forecasting & Telemetry */}
            <button
              id="tab-btn-imd"
              data-testid="tab-imd_forecast"
              onClick={() => { setActiveTab('imd_forecast'); fetchImdData(imdStation); }}
              className={cn(
                "flex items-center justify-between px-3 py-2.5 rounded text-left transition-all font-label-caps text-xs",
                activeTab === 'imd_forecast'
                  ? "bg-sky-500/20 text-sky-400 border-l-2 border-sky-400 font-bold"
                  : "text-slate-400 hover:text-on-surface hover:bg-slate-900/60"
              )}
            >
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: activeTab === 'imd_forecast' ? "'FILL' 1" : "'FILL' 0" }}>
                  cloud
                </span>
                <span>IMD Forecast & WX</span>
              </div>
              <span className="bg-sky-500/20 text-sky-300 text-[9px] px-1.5 py-0.5 rounded font-data-mono-lg">
                API-3
              </span>
            </button>
          </div>

          {/* Nav Footer: Station Metadata */}
          <div className="p-3 border-t border-outline-variant/40 bg-slate-950/60 text-[10px] font-data-mono-lg text-slate-400 flex flex-col gap-1">
            <div className="font-semibold text-slate-300">MESONETWORK CLUSTER</div>
            <div className="text-primary truncate font-bold">Lucknow (Target AWS)</div>
            <div className="truncate text-slate-400">Neighbors: Kanpur, Barabanki, Sitapur</div>
            <div className="mt-1 pt-1 border-t border-slate-800 text-[9px] text-slate-500">
              Dual Thresholds: T_mod: 0.494 | T_ext: 0.565
            </div>
          </div>
        </nav>

        {/* Center Panel (Switchable Views) */}
        <div className="dashboard-panel relative bg-slate-950 flex flex-col overflow-hidden">
          {/* Top Bar for View Title & Drawer Toggle */}
          <div className="h-10 border-b border-slate-800/80 bg-slate-900/40 px-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 text-xs font-label-caps font-semibold text-slate-300">
              {activeTab === 'telemetry' && (
                <>
                  <span className="material-symbols-outlined text-sm text-secondary">analytics</span>
                  <span>LIVE TELEMETRY STREAM & CALIBRATED DETECTION</span>
                </>
              )}
              {activeTab === 'multi_station' && (
                <>
                  <span className="material-symbols-outlined text-sm text-primary">hub</span>
                  <span>MESONETWORK CONSENSUS: 4 TIME-ALIGNED STATIONS (3 CONSOLIDATED CHARTS)</span>
                </>
              )}
              {activeTab === 'anomaly_history' && (
                <>
                  <span className="material-symbols-outlined text-sm text-wmo-amber">history</span>
                  <span>ANOMALY AUDIT TRAIL & POST-MORTEM FORENSIC LOG</span>
                </>
              )}
              {activeTab === 'sensor_health' && (
                <>
                  <span className="material-symbols-outlined text-sm text-wmo-emerald">health_and_safety</span>
                  <span>SENSOR HEALTH, DRIFT & THERMODYNAMIC COUPLING</span>
                </>
              )}
              {activeTab === 'imd_forecast' && (
                <>
                  <span className="material-symbols-outlined text-sm text-sky-400">cloud</span>
                  <span>IMD REAL-TIME FORECASTING & SYNOP OBSERVATION (API-3, API-1/2, API-4/7)</span>
                </>
              )}
            </div>

            <button
              onClick={() => setShowDrawer(!showDrawer)}
              title={showDrawer ? "Collapse SHAP Drawer" : "Expand SHAP Drawer"}
              className="text-xs text-slate-400 hover:text-on-surface flex items-center gap-1 px-2 py-1 rounded bg-slate-800/60 hover:bg-slate-800 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">
                {showDrawer ? 'chevron_right' : 'view_sidebar'}
              </span>
              <span className="text-[10px] font-label-caps">{showDrawer ? 'Hide Drawer' : 'Show SHAP'}</span>
            </button>
          </div>

          {/* VIEW 1: Live Telemetry Stream */}
          {activeTab === 'telemetry' && (
            <div className="flex-1 overflow-y-auto flex flex-col p-4 gap-4">
              {/* Floating Consensus Map Card */}
              <div className="glass-panel rounded-lg p-3 flex justify-between items-center border border-outline-variant/20 shadow-md">
                <div className="flex items-center gap-3 text-xs font-data-mono-lg">
                  <span className={cn("w-2.5 h-2.5 rounded-full", latest?.is_anomaly ? "bg-wmo-rose glow-rose-pulse" : "bg-wmo-emerald glow-emerald")}></span>
                  <span className={latest?.is_anomaly ? "text-wmo-rose font-bold" : "text-wmo-emerald font-bold"}>
                    LUCKNOW AWS: {latest?.is_anomaly ? "ANOMALOUS / SUPPRESSED" : "NOMINAL / IN-BOUNDS"}
                  </span>
                  <span className="text-slate-400 text-[11px] border-l border-slate-700 pl-3">
                    WMO Flag: <strong className="text-on-surface">{latest?.qc_flag ?? 0}</strong>
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-data-mono-lg flex gap-4">
                  <span>ΔT: <strong className="text-amber-400">{((latest?.raw_temp || 0) - (latest?.healed_temp || 0)).toFixed(1)}°C</strong></span>
                  <span>ΔP: <strong className="text-sky-400">{((latest?.raw_pres || 0) - (latest?.healed_pres || 0)).toFixed(1)} hPa</strong></span>
                  <span>ΔRH: <strong className="text-emerald-400">{((latest?.raw_rh || 0) - (latest?.healed_rh || 0)).toFixed(1)}%</strong></span>
                </div>
              </div>

              {/* Dual Trace Overlay 1: Temperature */}
              <div className="h-44 border border-slate-800 bg-slate-900/50 rounded-lg p-2.5 relative shadow-sm">
                <div className="absolute top-2 left-3 font-data-mono-lg text-xs text-wmo-amber z-10 flex items-center gap-3">
                  <span className="font-bold">AMBIENT TEMPERATURE (°C)</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    Dashed: Raw Corrupted | Solid: Healed Spatial IDW
                  </span>
                </div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={telemetry} margin={{ top: 24, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="timestamp" tick={false} axisLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#88929b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} labelStyle={{ display: 'none' }} />
                    <Line type="monotone" dataKey="raw_temp" name="Raw Temp" stroke="#f43f5e" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="healed_temp" name="Healed Temp" stroke="#10b981" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Dual Trace Overlay 2: Pressure */}
              <div className="h-44 border border-slate-800 bg-slate-900/50 rounded-lg p-2.5 relative shadow-sm">
                <div className="absolute top-2 left-3 font-data-mono-lg text-xs text-wmo-skyblue z-10 flex items-center gap-3">
                  <span className="font-bold">ATMOSPHERIC PRESSURE (hPa)</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    Dashed: Raw Corrupted | Solid: Healed Spatial IDW
                  </span>
                </div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={telemetry} margin={{ top: 24, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="timestamp" tick={false} axisLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#88929b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} labelStyle={{ display: 'none' }} />
                    <Line type="monotone" dataKey="raw_pres" name="Raw Pres" stroke="#f43f5e" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="healed_pres" name="Healed Pres" stroke="#38bdf8" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Dual Trace Overlay 3: Humidity */}
              <div className="h-44 border border-slate-800 bg-slate-900/50 rounded-lg p-2.5 relative shadow-sm">
                <div className="absolute top-2 left-3 font-data-mono-lg text-xs text-wmo-violet z-10 flex items-center gap-3">
                  <span className="font-bold">RELATIVE HUMIDITY (%)</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    Dashed: Raw Corrupted | Solid: Healed Spatial IDW
                  </span>
                </div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={telemetry} margin={{ top: 24, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="timestamp" tick={false} axisLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#88929b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} labelStyle={{ display: 'none' }} />
                    <Line type="monotone" dataKey="raw_rh" name="Raw RH" stroke="#f43f5e" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="healed_rh" name="Healed RH" stroke="#a855f7" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* VIEW 2: Mesonetwork Consensus (4 Stations, Exactly 3 Consolidated Charts) */}
          {activeTab === 'multi_station' && (
            <div className="flex-1 overflow-y-auto flex flex-col p-4 gap-4">
              {/* Station Spatial Residuals Summary Bar */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-emerald-400 font-bold">TARGET: LUCKNOW</span>
                    <span className={cn("w-2 h-2 rounded-full", latest?.is_anomaly ? "bg-emerald-400 animate-pulse" : "bg-emerald-400")}></span>
                  </div>
                  <div className="text-xs font-data-mono-lg font-bold text-emerald-400 mt-1">
                    {msLatest?.temp_lucknow}°C | {msLatest?.pres_lucknow} hPa
                  </div>
                  <div className="text-[10px] text-slate-400 font-data-mono-lg mt-0.5">
                    ΔT vs Med: <strong className={Math.abs(msLatest?.spatial_delta_temp || 0) > 3 ? "text-wmo-amber font-bold" : "text-slate-300"}>{msLatest?.spatial_delta_temp > 0 ? `+${msLatest?.spatial_delta_temp}` : msLatest?.spatial_delta_temp}°C</strong>
                  </div>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-sky-400 font-bold">NEIGHBOR: KANPUR</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400"></span>
                  </div>
                  <div className="text-xs font-data-mono-lg font-bold text-sky-400 mt-1">
                    {msLatest?.temp_kanpur}°C | {msLatest?.pres_kanpur} hPa
                  </div>
                  <div className="text-[10px] text-slate-400 font-data-mono-lg mt-0.5">
                    RH: {msLatest?.rh_kanpur}% | Weight: 0.35
                  </div>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-amber-400 font-bold">NEIGHBOR: BARABANKI</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                  </div>
                  <div className="text-xs font-data-mono-lg font-bold text-amber-400 mt-1">
                    {msLatest?.temp_barabanki}°C | {msLatest?.pres_barabanki} hPa
                  </div>
                  <div className="text-[10px] text-slate-400 font-data-mono-lg mt-0.5">
                    RH: {msLatest?.rh_barabanki}% | Weight: 0.38
                  </div>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-purple-400 font-bold">NEIGHBOR: SITAPUR</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
                  </div>
                  <div className="text-xs font-data-mono-lg font-bold text-purple-400 mt-1">
                    {msLatest?.temp_sitapur}°C | {msLatest?.pres_sitapur} hPa
                  </div>
                  <div className="text-[10px] text-slate-400 font-data-mono-lg mt-0.5">
                    RH: {msLatest?.rh_sitapur}% | Weight: 0.27
                  </div>
                </div>
              </div>

              {/* Chart 1 of 3: Consolidated Temperature Chart (All 4 Stations) */}
              <div className="h-56 border border-slate-800 bg-slate-900/50 rounded-lg p-3 relative shadow-sm">
                <div className="flex justify-between items-center mb-1">
                  <div className="font-data-mono-lg text-xs font-bold text-amber-400 flex items-center gap-2">
                    <span>1. CONSOLIDATED AMBIENT TEMPERATURE (°C)</span>
                    <span className="text-[10px] text-slate-400 font-normal">[4 STATIONS TIME-ALIGNED]</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-data-mono-lg">
                    <span className="text-emerald-400 font-semibold">● Lucknow (Target)</span>
                    <span className="text-sky-400 font-semibold">● Kanpur</span>
                    <span className="text-amber-400 font-semibold">● Barabanki</span>
                    <span className="text-purple-400 font-semibold">● Sitapur</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height="86%">
                  <LineChart data={multiStationData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="timestamp" tick={false} axisLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#88929b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} />
                    <Line type="monotone" dataKey="temp_lucknow" name="Lucknow (Target)" stroke="#10b981" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="temp_kanpur" name="Kanpur" stroke="#38bdf8" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="temp_barabanki" name="Barabanki" stroke="#fbbf24" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="temp_sitapur" name="Sitapur" stroke="#c084fc" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Chart 2 of 3: Consolidated Pressure Chart (All 4 Stations) */}
              <div className="h-56 border border-slate-800 bg-slate-900/50 rounded-lg p-3 relative shadow-sm">
                <div className="flex justify-between items-center mb-1">
                  <div className="font-data-mono-lg text-xs font-bold text-sky-400 flex items-center gap-2">
                    <span>2. CONSOLIDATED SURFACE PRESSURE (hPa)</span>
                    <span className="text-[10px] text-slate-400 font-normal">[4 STATIONS TIME-ALIGNED]</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-data-mono-lg">
                    <span className="text-emerald-400 font-semibold">● Lucknow (Target)</span>
                    <span className="text-sky-400 font-semibold">● Kanpur</span>
                    <span className="text-amber-400 font-semibold">● Barabanki</span>
                    <span className="text-purple-400 font-semibold">● Sitapur</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height="86%">
                  <LineChart data={multiStationData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="timestamp" tick={false} axisLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#88929b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} />
                    <Line type="monotone" dataKey="pres_lucknow" name="Lucknow (Target)" stroke="#10b981" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="pres_kanpur" name="Kanpur" stroke="#38bdf8" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="pres_barabanki" name="Barabanki" stroke="#fbbf24" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="pres_sitapur" name="Sitapur" stroke="#c084fc" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Chart 3 of 3: Consolidated Relative Humidity Chart (All 4 Stations) */}
              <div className="h-56 border border-slate-800 bg-slate-900/50 rounded-lg p-3 relative shadow-sm">
                <div className="flex justify-between items-center mb-1">
                  <div className="font-data-mono-lg text-xs font-bold text-emerald-400 flex items-center gap-2">
                    <span>3. CONSOLIDATED RELATIVE HUMIDITY (%)</span>
                    <span className="text-[10px] text-slate-400 font-normal">[4 STATIONS TIME-ALIGNED]</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-data-mono-lg">
                    <span className="text-emerald-400 font-semibold">● Lucknow (Target)</span>
                    <span className="text-sky-400 font-semibold">● Kanpur</span>
                    <span className="text-amber-400 font-semibold">● Barabanki</span>
                    <span className="text-purple-400 font-semibold">● Sitapur</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height="86%">
                  <LineChart data={multiStationData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="timestamp" tick={false} axisLine={false} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#88929b' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', fontSize: '11px' }} />
                    <Line type="monotone" dataKey="rh_lucknow" name="Lucknow (Target)" stroke="#10b981" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="rh_kanpur" name="Kanpur" stroke="#38bdf8" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="rh_barabanki" name="Barabanki" stroke="#fbbf24" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="rh_sitapur" name="Sitapur" stroke="#c084fc" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* VIEW 3: Anomaly History & Audit Log */}
          {activeTab === 'anomaly_history' && (
            <div className="flex-1 overflow-y-auto flex flex-col p-4 gap-4">
              {/* Summary KPI Cards */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <span className="text-[10px] font-label-caps text-slate-400">TOTAL ANOMALIES</span>
                  <span className="text-xl font-data-mono-lg font-bold text-wmo-amber mt-1">
                    {anomalies.length}
                  </span>
                  <span className="text-[9px] text-slate-500 mt-0.5">Recorded in rolling buffer</span>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <span className="text-[10px] font-label-caps text-slate-400">ANOMALY INCIDENCE RATE</span>
                  <span className="text-xl font-data-mono-lg font-bold text-primary mt-1">
                    {((anomalies.length / Math.max(1, telemetry.length)) * 100).toFixed(1)}%
                  </span>
                  <span className="text-[9px] text-slate-500 mt-0.5">Threshold: Moderate 0.494</span>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <span className="text-[10px] font-label-caps text-slate-400">TRIAGE BREAKDOWN</span>
                  <div className="flex gap-2 text-[10px] font-data-mono-lg mt-2 flex-wrap">
                    <span className="text-wmo-amber">Spk: {anomalies.filter(a => (a.root_cause || '').includes('Spike')).length}</span>
                    <span className="text-wmo-violet">Frz: {anomalies.filter(a => (a.root_cause || '').includes('Freeze') || (a.root_cause || '').includes('Stagnation')).length}</span>
                    <span className="text-wmo-skyblue">Drf: {anomalies.filter(a => (a.root_cause || '').includes('Drift')).length}</span>
                    <span className="text-wmo-rose">WB: {anomalies.filter(a => (a.root_cause || '').includes('Wet-Bulb')).length}</span>
                  </div>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <span className="text-[10px] font-label-caps text-slate-400">AUTO-HEALING SUCCESS</span>
                  <span className="text-xl font-data-mono-lg font-bold text-wmo-emerald mt-1">
                    100.0%
                  </span>
                  <span className="text-[9px] text-slate-500 mt-0.5">WMO Flag 2 (Spatial IDW)</span>
                </div>
              </div>

              {/* Filter and Export Toolbar */}
              <div className="flex justify-between items-center gap-3 bg-slate-900/40 border border-slate-800/80 rounded-lg p-2.5">
                <div className="flex items-center gap-3 flex-1">
                  <div className="relative flex-1 max-w-xs">
                    <span className="material-symbols-outlined absolute left-2.5 top-2 text-slate-500 text-sm">search</span>
                    <input
                      id="input-anomaly-search"
                      type="text"
                      placeholder="Search diagnosis, drivers, timestamp..."
                      value={anomalySearch}
                      onChange={(e) => setAnomalySearch(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded pl-8 pr-3 py-1.5 text-xs text-on-surface font-data-mono-lg placeholder-slate-500 focus:outline-none focus:border-primary"
                    />
                  </div>

                  {/* Flag Filter */}
                  <div className="flex items-center gap-1 text-[11px] font-label-caps">
                    <span className="text-slate-400 mr-1">QC Flag:</span>
                    {['ALL', '1', '2', '3'].map((flag) => (
                      <button
                        key={flag}
                        onClick={() => setAnomalyFilterFlag(flag)}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-data-mono-lg transition-colors",
                          anomalyFilterFlag === flag
                            ? "bg-primary text-slate-950 font-bold"
                            : "bg-slate-800 text-slate-400 hover:text-on-surface"
                        )}
                      >
                        {flag === 'ALL' ? 'ALL' : `Flag ${flag}`}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    id="btn-clear-anomalies"
                    onClick={clearAnomalies}
                    disabled={anomalies.length === 0}
                    className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-rose-950/40 text-slate-400 hover:text-rose-300 border border-slate-800 rounded font-data-mono-lg text-xs flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:pointer-events-none active:scale-95"
                    title="Clear Forensic Anomaly Audit Log"
                  >
                    <span className="material-symbols-outlined text-sm">delete_sweep</span>
                    <span>Clear Log</span>
                  </button>

                  <button
                    id="btn-export-csv"
                    onClick={exportToCSV}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-data-mono-lg text-xs flex items-center gap-1.5 transition-colors active:scale-95"
                    title="Export WMO Standard CSV Audit Log"
                  >
                    <span className="material-symbols-outlined text-sm">download</span>
                    <span>Export CSV Log</span>
                  </button>
                </div>
              </div>

              {/* Anomaly Records Table */}
              <div className="border border-slate-800 bg-slate-900/30 rounded-lg overflow-hidden shadow-sm">
                <div className="overflow-x-auto max-h-[460px]">
                  <table className="w-full text-left border-collapse text-xs font-data-mono-lg">
                    <thead className="bg-slate-950/80 text-[10px] font-label-caps text-slate-400 uppercase tracking-wider sticky top-0 border-b border-slate-800 z-10">
                      <tr>
                        <th className="py-2.5 px-3">Timestamp (UTC)</th>
                        <th className="py-2.5 px-3">Diagnostic Triage</th>
                        <th className="py-2.5 px-3 text-center">QC Flag</th>
                        <th className="py-2.5 px-3 text-right">Raw vs Healed</th>
                        <th className="py-2.5 px-3">Top SHAP Driver</th>
                        <th className="py-2.5 px-3 text-center">Inspect</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {filteredAnomalies.length > 0 ? (
                        filteredAnomalies.map((item, idx) => {
                          const isSelected = selectedHistoricalAnomaly?.timestamp === item.timestamp;
                          const topD = item.top_drivers?.[0];
                          return (
                            <tr
                              key={idx}
                              onClick={() => {
                                setSelectedHistoricalAnomaly(item);
                                setShowDrawer(true);
                              }}
                              className={cn(
                                "cursor-pointer transition-colors hover:bg-slate-800/40",
                                isSelected ? "bg-primary/10 border-l-2 border-primary" : ""
                              )}
                            >
                              <td className="py-2 px-3 text-slate-300 whitespace-nowrap text-[11px]">
                                {item.timestamp ? item.timestamp.replace('T', ' ').slice(0, 19) : '—'}
                              </td>
                              <td className="py-2 px-3 max-w-[220px] truncate">
                                <span className={cn(
                                  "font-semibold text-xs",
                                  item.root_cause?.includes('Spike') ? "text-wmo-amber" :
                                    item.root_cause?.includes('Freeze') || item.root_cause?.includes('Stagnation') ? "text-wmo-violet" :
                                      item.root_cause?.includes('Drift') ? "text-wmo-skyblue" :
                                        item.root_cause?.includes('Wet-Bulb') ? "text-wmo-rose" : "text-slate-300"
                                )}>
                                  {item.root_cause || 'Suspect Observation'}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-center">
                                <span className={cn(
                                  "px-2 py-0.5 rounded text-[10px] font-bold",
                                  item.qc_flag === 0 ? "bg-wmo-emerald/20 text-wmo-emerald" :
                                    item.qc_flag === 1 ? "bg-wmo-amber/20 text-wmo-amber" :
                                      item.qc_flag === 2 ? "bg-wmo-skyblue/20 text-wmo-skyblue" : "bg-wmo-violet/20 text-wmo-violet"
                                )}>
                                  Flag {item.qc_flag ?? 0}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-right whitespace-nowrap text-[11px]">
                                {(item.root_cause?.includes('Drift') || item.root_cause?.includes('Freeze') || item.root_cause?.includes('Stagnation')) && item.raw_pres !== undefined ? (
                                  <span className="text-slate-400">
                                    <span className="text-wmo-rose">{item.raw_pres}</span> → <span className="text-wmo-emerald font-bold">{item.healed_pres} hPa</span>
                                  </span>
                                ) : (item.root_cause?.includes('Wet-Bulb') || item.root_cause?.includes('Humidity')) && item.raw_rh !== undefined ? (
                                  <span className="text-slate-400">
                                    <span className="text-wmo-rose">{item.raw_rh}%</span> → <span className="text-wmo-emerald font-bold">{item.healed_rh}% RH</span>
                                  </span>
                                ) : item.raw_temp !== undefined && item.healed_temp !== undefined ? (
                                  <span className="text-slate-400">
                                    <span className="text-wmo-rose">{item.raw_temp}°C</span> → <span className="text-wmo-emerald font-bold">{item.healed_temp}°C</span>
                                  </span>
                                ) : '—'}
                              </td>
                              <td className="py-2 px-3 text-[11px] text-slate-300 truncate max-w-[150px]">
                                {topD ? (
                                  <span>{topD.label || topD.feature} ({topD.attribution > 0 ? `+${topD.attribution}` : topD.attribution})</span>
                                ) : '—'}
                              </td>
                              <td className="py-2 px-3 text-center">
                                <button
                                  id={`btn-inspect-${idx}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedHistoricalAnomaly(item);
                                    setShowDrawer(true);
                                  }}
                                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-primary/20 text-primary text-[10px] transition-colors"
                                >
                                  Inspect SHAP
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-slate-500 font-data-mono-lg">
                            No anomalies matching current filter criteria.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 4: Sensor Health & Predictive Maintenance */}
          {activeTab === 'sensor_health' && (
            <div className="flex-1 overflow-y-auto flex flex-col p-4 gap-4">
              {/* Sensor Health Gauges (0 - 100%) */}
              <div className="grid grid-cols-4 gap-3">
                {/* Temperature Sensor Health */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-slate-400">THERMAL TRANSDUCER (T)</span>
                    <span className={cn(
                      "text-[10px] font-bold px-1.5 py-0.5 rounded",
                      (sensorHealth?.health_indices?.temperature || 100) >= 80 ? "bg-wmo-emerald/20 text-wmo-emerald" : "bg-wmo-amber/20 text-wmo-amber"
                    )}>
                      {(sensorHealth?.health_indices?.temperature || 100) >= 80 ? 'NOMINAL' : 'WATCH'}
                    </span>
                  </div>
                  <div className="text-2xl font-data-mono-lg font-bold text-amber-400 mt-2">
                    {sensorHealth?.health_indices?.temperature ?? 100}%
                  </div>
                  {/* Progress bar */}
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-2">
                    <div className="bg-amber-400 h-full rounded-full" style={{ width: `${sensorHealth?.health_indices?.temperature ?? 100}%` }}></div>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-2 font-data-mono-lg">
                    SHT31 / RTD Thermal Element | Step variance check
                  </div>
                </div>

                {/* Pressure Sensor Health */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-slate-400">BAROMETRIC TRANSDUCER (P)</span>
                    <span className={cn(
                      "text-[10px] font-bold px-1.5 py-0.5 rounded",
                      (sensorHealth?.health_indices?.pressure || 100) >= 80 ? "bg-wmo-emerald/20 text-wmo-emerald" : "bg-wmo-rose/20 text-wmo-rose"
                    )}>
                      {(sensorHealth?.health_indices?.pressure || 100) >= 80 ? 'NOMINAL' : 'DEGRADED'}
                    </span>
                  </div>
                  <div className="text-2xl font-data-mono-lg font-bold text-sky-400 mt-2">
                    {sensorHealth?.health_indices?.pressure ?? 100}%
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-2">
                    <div className="bg-sky-400 h-full rounded-full" style={{ width: `${sensorHealth?.health_indices?.pressure ?? 100}%` }}></div>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-2 font-data-mono-lg">
                    24h Drift Rate: <strong className="text-sky-300">{sensorHealth?.drift_rate_24h > 0 ? `+${sensorHealth?.drift_rate_24h}` : sensorHealth?.drift_rate_24h} hPa</strong>
                  </div>
                </div>

                {/* Humidity Sensor Health */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-slate-400">HYGROMETER ELEMENT (RH)</span>
                    <span className={cn(
                      "text-[10px] font-bold px-1.5 py-0.5 rounded",
                      (sensorHealth?.health_indices?.humidity || 100) >= 80 ? "bg-wmo-emerald/20 text-wmo-emerald" : "bg-wmo-amber/20 text-wmo-amber"
                    )}>
                      {(sensorHealth?.health_indices?.humidity || 100) >= 80 ? 'NOMINAL' : 'WATCH'}
                    </span>
                  </div>
                  <div className="text-2xl font-data-mono-lg font-bold text-emerald-400 mt-2">
                    {sensorHealth?.health_indices?.humidity ?? 100}%
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-2">
                    <div className="bg-emerald-400 h-full rounded-full" style={{ width: `${sensorHealth?.health_indices?.humidity ?? 100}%` }}></div>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-2 font-data-mono-lg">
                    Capacitive Polymer | Saturation overshoot audit
                  </div>
                </div>

                {/* Cluster Composite Reliability */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-label-caps text-slate-400">CLUSTER COMPOSITE</span>
                    <span className="w-2 h-2 rounded-full bg-primary glow-emerald"></span>
                  </div>
                  <div className="text-2xl font-data-mono-lg font-bold text-primary mt-2">
                    {sensorHealth?.health_indices?.cluster_composite ?? 100}%
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-2">
                    <div className="bg-primary h-full rounded-full" style={{ width: `${sensorHealth?.health_indices?.cluster_composite ?? 100}%` }}></div>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-2 font-data-mono-lg">
                    Combined Reliability Index across 4 AWS nodes
                  </div>
                </div>
              </div>

              {/* Magnus-Tetens Thermodynamic Consistency Card */}
              <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-4 shadow-sm">
                <div className="flex justify-between items-center border-b border-slate-800 pb-2 mb-3">
                  <div className="font-data-mono-lg text-xs font-bold text-secondary flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm">thermostat</span>
                    <span>MAGNUS-TETENS THERMODYNAMIC COUPLING INSPECTOR</span>
                  </div>
                  <span className={cn(
                    "text-[10px] font-data-mono-lg px-2 py-0.5 rounded font-bold",
                    sensorHealth?.is_thermo_safe ? "bg-wmo-emerald/20 text-wmo-emerald" : "bg-wmo-rose/20 text-wmo-rose glow-rose-pulse"
                  )}>
                    {sensorHealth?.is_thermo_safe ? 'COUPLED: PHYSICALLY SOUND' : 'ALERT: WET-BULB VIOLATION'}
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-4 text-center font-data-mono-lg">
                  <div className="bg-slate-950/60 border border-slate-800/80 rounded p-3">
                    <div className="text-[10px] text-slate-400 font-label-caps">CALCULATED DEW-POINT (Td)</div>
                    <div className="text-xl font-bold text-teal-400 mt-1">{sensorHealth?.dew_point ?? '—'}°C</div>
                    <div className="text-[9px] text-slate-500 mt-1">Magnus: α(T, RH)</div>
                  </div>

                  <div className="bg-slate-950/60 border border-slate-800/80 rounded p-3">
                    <div className="text-[10px] text-slate-400 font-label-caps">DEW-POINT SPREAD (T - Td)</div>
                    <div className={cn(
                      "text-xl font-bold mt-1",
                      (sensorHealth?.dew_point_spread || 0) < 1.5 ? "text-wmo-rose" : "text-amber-400"
                    )}>
                      {sensorHealth?.dew_point_spread ?? '—'}°C
                    </div>
                    <div className="text-[9px] text-slate-500 mt-1">Limit: ≥1.5°C when T &gt; 40°C</div>
                  </div>

                  <div className="bg-slate-950/60 border border-slate-800/80 rounded p-3">
                    <div className="text-[10px] text-slate-400 font-label-caps">VAPOR PRESSURE DEFICIT (VPD)</div>
                    <div className="text-xl font-bold text-sky-400 mt-1">{sensorHealth?.vpd_kpa ?? '—'} kPa</div>
                    <div className="text-[9px] text-slate-500 mt-1">esat(T) - eact(RH)</div>
                  </div>

                  <div className="bg-slate-950/60 border border-slate-800/80 rounded p-3">
                    <div className="text-[10px] text-slate-400 font-label-caps">ADC FLATLINE STEPS</div>
                    <div className={cn(
                      "text-xl font-bold mt-1",
                      (sensorHealth?.flatlines_detected || 0) >= 3 ? "text-wmo-rose" : "text-slate-300"
                    )}>
                      {sensorHealth?.flatlines_detected ?? 0}
                    </div>
                    <div className="text-[9px] text-slate-500 mt-1">Stagnation threshold: 3 steps</div>
                  </div>
                </div>
              </div>

              {/* Actionable Predictive Maintenance Work Orders */}
              <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-4 shadow-sm flex flex-col gap-3">
                <div className="font-data-mono-lg text-xs font-bold text-slate-300 flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-primary">build</span>
                  <span>PREDICTIVE MAINTENANCE WORK ORDERS & OPERATIONAL DIRECTIVES</span>
                </div>

                <div className="flex flex-col gap-2">
                  {sensorHealth?.advisories && sensorHealth.advisories.length > 0 ? (
                    sensorHealth.advisories.map((adv, i) => (
                      <div
                        key={i}
                        className={cn(
                          "p-3 rounded-lg border flex items-start gap-3 text-xs font-data-mono-lg",
                          adv.priority === 'CRITICAL' ? "bg-wmo-rose/10 border-wmo-rose/40 text-slate-200" :
                            adv.priority === 'HIGH' ? "bg-wmo-amber/10 border-wmo-amber/40 text-slate-200" :
                              adv.priority === 'MEDIUM' ? "bg-sky-500/10 border-sky-500/30 text-slate-200" :
                                "bg-slate-950/60 border-slate-800 text-slate-300"
                        )}
                      >
                        <span className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-bold shrink-0",
                          adv.priority === 'CRITICAL' ? "bg-wmo-rose text-slate-950" :
                            adv.priority === 'HIGH' ? "bg-wmo-amber text-slate-950" :
                              adv.priority === 'MEDIUM' ? "bg-sky-400 text-slate-950" :
                                "bg-wmo-emerald/20 text-wmo-emerald"
                        )}>
                          {adv.priority}
                        </span>
                        <div className="flex flex-col gap-0.5">
                          <div className="font-bold text-on-surface flex items-center gap-2">
                            <span>{adv.component}</span>
                            <span className="text-[10px] text-slate-400">[{adv.code}]</span>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                            {adv.message}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-500 text-xs py-4 text-center font-data-mono-lg">
                      No active maintenance advisories. All sensors within operational tolerances.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* VIEW 5: Official IMD Real-Time Weather Forecasting & Telemetry (API-3, API-1/2, API-4/7, API-9) */}
          {activeTab === 'imd_forecast' && (
            <div className="flex-1 overflow-y-auto flex flex-col p-4 gap-4">
              {/* IMD Operational Header & Controls */}
              <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3.5 flex flex-wrap justify-between items-center gap-3 backdrop-blur-sm shadow-md">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
                    <span className="material-symbols-outlined text-2xl">cloud</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-bold text-slate-100 font-label-caps">INDIA METEOROLOGICAL DEPARTMENT (IMD)</h2>
                      <span className="bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] px-2 py-0.5 rounded font-data-mono-lg">
                        MoES / GOVT OF INDIA
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Official API Gateway integration for Current Weather (API-3), 7-Day Forecast (API-1/2), and Nowcast (API-4/7)
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  {/* Status indicator */}
                  <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 px-3 py-1.5 rounded text-xs font-data-mono-lg">
                    <span className={cn(
                      "w-2 h-2 rounded-full",
                      imdStatus?.status?.connected ? "bg-emerald-400 animate-pulse shadow-[0_0_8px_#10b981]" : "bg-sky-400"
                    )}></span>
                    <span className={imdStatus?.status?.connected ? "text-emerald-400 font-bold" : "text-sky-300"}>
                      {imdStatus?.status?.connected ? "LIVE IMD GATEWAY" : "IMD SYNOP CALIBRATED"}
                    </span>
                  </div>

                  {/* Credentials Configuration Button */}
                  <button
                    onClick={() => setShowImdModal(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-xs font-label-caps transition-all"
                  >
                    <span className="material-symbols-outlined text-xs text-amber-400">key</span>
                    <span>API Key / JWT</span>
                  </button>

                  {/* Ingest to Anomaly Ring Buffer */}
                  <button
                    onClick={handleIngestImdToBuffer}
                    disabled={isIngestingImd}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs font-label-caps font-bold transition-all shadow-sm"
                  >
                    <span className={cn("material-symbols-outlined text-xs", isIngestingImd && "animate-spin")}>sync</span>
                    <span>{isIngestingImd ? "Ingesting..." : "Ingest to Ring Buffer"}</span>
                  </button>

                  {/* API Docs Link */}
                  <a
                    href="https://api.imd.gov.in/public/api_reference.html#api-3"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 text-slate-400 hover:text-sky-400 hover:bg-slate-800 rounded transition-all"
                    title="Open Official IMD API Reference"
                  >
                    <span className="material-symbols-outlined text-base">open_in_new</span>
                  </a>
                </div>
              </div>

              {/* Cluster Station Selector Tabs */}
              <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                <span className="text-[11px] font-label-caps text-slate-400 mr-2">SELECT STATION:</span>
                {[
                  { key: 'lucknow', label: 'Lucknow (Target AWS 42182)', dist: 'Lucknow / Amausi' },
                  { key: 'kanpur', label: 'Kanpur (42379)', dist: 'Kanpur Chakeri' },
                  { key: 'barabanki', label: 'Barabanki (42189)', dist: 'Barabanki' },
                  { key: 'sitapur', label: 'Sitapur (42178)', dist: 'Sitapur' },
                ].map((stn) => (
                  <button
                    key={stn.key}
                    onClick={() => handleSelectImdStation(stn.key)}
                    className={cn(
                      "px-3 py-1.5 rounded text-xs font-data-mono-lg transition-all flex items-center gap-2",
                      imdStation === stn.key
                        ? "bg-sky-500/20 text-sky-300 border border-sky-500/50 font-bold shadow-sm"
                        : "bg-slate-900/60 text-slate-400 hover:text-slate-200 border border-slate-800"
                    )}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full", imdStation === stn.key ? "bg-sky-400" : "bg-slate-600")}></span>
                    <span>{stn.label}</span>
                  </button>
                ))}
              </div>

              {/* Nowcast Warning Banner (API-4 / API-7) */}
              {imdNowcast?.data && (
                <div className={cn(
                  "border rounded-lg p-3 flex items-center justify-between text-xs",
                  imdNowcast.data.color === '4' ? "bg-red-950/40 border-red-500/50 text-red-200" :
                  imdNowcast.data.color === '3' ? "bg-orange-950/40 border-orange-500/50 text-orange-200" :
                  imdNowcast.data.color === '2' ? "bg-amber-950/40 border-amber-500/50 text-amber-200" :
                  "bg-emerald-950/30 border-emerald-500/30 text-emerald-200"
                )}>
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-xl">
                      {imdNowcast.data.color === '1' ? 'verified' : 'warning'}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold font-label-caps">IMD NOWCAST (3-HR VALIDITY):</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-data-mono-lg" style={{ backgroundColor: imdNowcast.data.color_hex || '#008000', color: '#fff' }}>
                          {imdNowcast.data.color_name || 'GREEN'}
                        </span>
                        <span className="text-[10px] text-slate-300 font-data-mono-lg">
                          Issued: {imdNowcast.data.toi || '0600'} IST | Valid Upto: {imdNowcast.data.Vupto || '0900'} IST
                        </span>
                      </div>
                      <p className="text-[11px] mt-0.5 text-slate-300 leading-relaxed font-sans">
                        {imdNowcast.data.message}
                      </p>
                    </div>
                  </div>

                  {imdNowcast.data.probabilities && (
                    <div className="flex items-center gap-4 text-[10px] font-data-mono-lg shrink-0">
                      <div>Lightning: <strong className="text-white">{imdNowcast.data.probabilities.lightning}</strong></div>
                      <div>Gusts: <strong className="text-white">{imdNowcast.data.probabilities.gust_speed}</strong></div>
                      <div>Rain Rate: <strong className="text-white">{imdNowcast.data.probabilities.rain_rate}</strong></div>
                    </div>
                  )}
                </div>
              )}

              {/* HERO CARD: API-3 Real-Time Current Weather */}
              <div className="bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 border border-sky-500/30 rounded-xl p-4 shadow-lg relative overflow-hidden">
                <div className="absolute top-0 right-0 w-96 h-96 bg-sky-500/5 rounded-full blur-3xl pointer-events-none"></div>

                <div className="flex flex-wrap justify-between items-start gap-4 mb-4 relative z-10">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-label-caps text-sky-400 font-bold">API-3 REAL-TIME CURRENT WEATHER</span>
                      <span className="text-slate-600">•</span>
                      <span className="text-[10px] text-slate-400 font-data-mono-lg">STATION ID: {imdCurrent?.data?.["Station Id"] || '42182'}</span>
                    </div>
                    <h3 className="text-xl font-bold text-slate-100 mt-0.5 tracking-tight font-headline-md">
                      {imdCurrent?.data?.Station || 'LUCKNOW / AMAUSI'}
                    </h3>
                    <div className="flex items-center gap-3 text-xs text-slate-400 font-data-mono-lg mt-1">
                      <span>Obs Date: {imdCurrent?.data?.["Date of Observation"]}</span>
                      <span>•</span>
                      <span>UTC: {imdCurrent?.data?.["Time of Observation UTC"]}</span>
                      <span>•</span>
                      <span className="text-sky-300">IST: {imdCurrent?.data?.["Time of Observation IST"]}</span>
                    </div>
                  </div>

                  {/* WMO Weather Code Pill */}
                  <div className="bg-slate-950/80 border border-slate-700/80 px-3.5 py-2 rounded-lg flex items-center gap-3 shadow-inner">
                    <span className="material-symbols-outlined text-2xl text-sky-400">partly_cloudy_day</span>
                    <div>
                      <div className="text-[10px] font-label-caps text-slate-400 font-semibold">WMO SYNOP CODE {imdCurrent?.data?.["Weather Code"] || '02'}</div>
                      <div className="text-xs font-bold text-slate-200">
                        {imdCurrent?.data?.["Weather Description"] || 'State of sky on the whole unchanged'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 6 Key IMD Parameters Grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 relative z-10">
                  {/* Metric 1: Temp */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-slate-400 text-xs font-label-caps">
                      <span>SURFACE TEMP</span>
                      <span className="material-symbols-outlined text-sm text-rose-400">thermostat</span>
                    </div>
                    <div className="text-2xl font-bold font-data-mono-lg text-rose-400 my-1">
                      {imdCurrent?.data?.["Temperature deg C"] || '29.4'}°C
                    </div>
                    <div className="text-[10px] text-slate-400 font-data-mono-lg">
                      Departure: <strong className="text-emerald-400">+1.2°C</strong>
                    </div>
                  </div>

                  {/* Metric 2: Atmospheric Pressure */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-slate-400 text-xs font-label-caps">
                      <span>STATION PRESSURE</span>
                      <span className="material-symbols-outlined text-sm text-sky-400">compress</span>
                    </div>
                    <div className="text-2xl font-bold font-data-mono-lg text-sky-400 my-1">
                      {imdCurrent?.data?.["M.S.L.P"] || '1008.2'} <span className="text-xs font-normal">hPa</span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-data-mono-lg">
                      Mean Sea Level (MSLP)
                    </div>
                  </div>

                  {/* Metric 3: Relative Humidity */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-slate-400 text-xs font-label-caps">
                      <span>HUMIDITY</span>
                      <span className="material-symbols-outlined text-sm text-purple-400">water_drop</span>
                    </div>
                    <div className="text-2xl font-bold font-data-mono-lg text-purple-400 my-1">
                      {imdCurrent?.data?.["Humidity %"] || '64'}%
                    </div>
                    <div className="text-[10px] text-slate-400 font-data-mono-lg">
                      Dew Point: ~21.5°C
                    </div>
                  </div>

                  {/* Metric 4: Surface Wind */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-slate-400 text-xs font-label-caps">
                      <span>SURFACE WIND</span>
                      <span className="material-symbols-outlined text-sm text-teal-400">air</span>
                    </div>
                    <div className="text-2xl font-bold font-data-mono-lg text-teal-400 my-1">
                      {imdCurrent?.data?.["Wind Speed KMPH"] || '8.0'} <span className="text-xs font-normal">km/h</span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-data-mono-lg">
                      {imdCurrent?.data?.["Wind Direction"] || '180° Southerly'}
                    </div>
                  </div>

                  {/* Metric 5: Cloud Nebulosity */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-slate-400 text-xs font-label-caps">
                      <span>NEBULOSITY</span>
                      <span className="material-symbols-outlined text-sm text-amber-400">cloud_queue</span>
                    </div>
                    <div className="text-2xl font-bold font-data-mono-lg text-amber-400 my-1">
                      {imdCurrent?.data?.Nebulosity || '3'} <span className="text-xs font-normal">/ 8</span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-data-mono-lg truncate">
                      {imdCurrent?.data?.["Nebulosity Description"] || 'Scattered clouds'}
                    </div>
                  </div>

                  {/* Metric 6: 24h Rainfall */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-slate-400 text-xs font-label-caps">
                      <span>PAST 24H RAIN</span>
                      <span className="material-symbols-outlined text-sm text-blue-400">rainy</span>
                    </div>
                    <div className="text-2xl font-bold font-data-mono-lg text-blue-400 my-1">
                      {imdCurrent?.data?.["Last 24 hrs Rainfall mm"] || '0.0'} <span className="text-xs font-normal">mm</span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-data-mono-lg">
                      Category: No Rain (NR)
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION 3: API-1 / API-2 City Weather Forecast for 7 Days */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-amber-400">calendar_month</span>
                    <h4 className="text-xs font-bold text-slate-200 font-label-caps">
                      7-DAY CITY WEATHER FORECAST (API-1 / API-2: CITYFORECASTLOC)
                    </h4>
                  </div>
                  {imdForecast?.data && (
                    <div className="flex items-center gap-4 text-[10px] font-data-mono-lg text-slate-400">
                      <span>Sunrise: <strong className="text-amber-300">{imdForecast.data.Sunrise_time}</strong></span>
                      <span>Sunset: <strong className="text-orange-400">{imdForecast.data.Sunset_time}</strong></span>
                      <span>Moonrise: <strong className="text-slate-300">{imdForecast.data.Moonrise_time}</strong></span>
                      <span>Moonset: <strong className="text-slate-300">{imdForecast.data.Moonset_time}</strong></span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
                  {(imdForecast?.days_forecast || []).map((day) => (
                    <div
                      key={day.day_number}
                      className={cn(
                        "bg-slate-950/80 border rounded-lg p-2.5 flex flex-col justify-between transition-all hover:border-sky-500/40",
                        day.day_number === 1 ? "border-sky-500/40 bg-sky-950/10 shadow-sm" : "border-slate-800"
                      )}
                    >
                      <div>
                        <div className="flex justify-between items-center">
                          <span className={cn("text-[11px] font-bold font-label-caps", day.day_number === 1 ? "text-sky-300" : "text-slate-300")}>
                            {day.day_label}
                          </span>
                          {day.day_number === 1 && (
                            <span className="text-[9px] bg-sky-500/20 text-sky-400 px-1 py-0.2 rounded font-data-mono-lg">
                              TODAY
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1 min-h-[32px] line-clamp-2 leading-tight">
                          {day.condition}
                        </div>
                      </div>

                      <div className="mt-3 pt-2 border-t border-slate-800/80 flex flex-col gap-1">
                        <div className="flex justify-between items-baseline font-data-mono-lg">
                          <span className="text-xs font-bold text-rose-400">{day.max_temp}°C</span>
                          <span className="text-xs text-sky-400">{day.min_temp}°C</span>
                        </div>
                        <div className="flex justify-between items-center text-[9px] font-data-mono-lg text-slate-400">
                          <span>Dep: <strong className={day.departure.startsWith('+') ? "text-amber-400" : "text-slate-300"}>{day.departure}</strong></span>
                          <span>Rain: {day.rainfall} mm</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* SECTION 4: Regional AWS Mesonetwork Ingestion Grid (API-9) */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-teal-400">sensors</span>
                    <h4 className="text-xs font-bold text-slate-200 font-label-caps">
                      REGIONAL AUTOMATIC WEATHER STATIONS (AWS/ARG - API-9 UTTAR PRADESH CLUSTER)
                    </h4>
                  </div>
                  <span className="text-[10px] text-slate-400 font-data-mono-lg">
                    State ID 5: 4 Synchronized Mesonetwork Nodes
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                  {(imdAws?.data || []).map((node) => (
                    <div key={node.CALL_SIGN} className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 flex flex-col gap-2">
                      <div className="flex justify-between items-center">
                        <div>
                          <span className="text-[10px] font-data-mono-lg text-teal-400 font-bold">[{node.CALL_SIGN}] {node.DISTRICT}</span>
                          <div className="text-xs font-bold text-slate-200">{node.STATION}</div>
                        </div>
                        <span className="w-2 h-2 rounded-full bg-teal-400 shadow-[0_0_6px_#2dd4bf]"></span>
                      </div>

                      <div className="grid grid-cols-3 gap-1.5 py-1 text-center font-data-mono-lg">
                        <div className="bg-slate-900/80 rounded p-1">
                          <div className="text-[9px] text-slate-400">TEMP</div>
                          <div className="text-xs font-bold text-rose-400">{node.CURR_TEMP}°C</div>
                        </div>
                        <div className="bg-slate-900/80 rounded p-1">
                          <div className="text-[9px] text-slate-400">RH</div>
                          <div className="text-xs font-bold text-purple-400">{node.RH}%</div>
                        </div>
                        <div className="bg-slate-900/80 rounded p-1">
                          <div className="text-[9px] text-slate-400">MSLP</div>
                          <div className="text-xs font-bold text-sky-400">{node.MSLP}</div>
                        </div>
                      </div>

                      <div className="flex justify-between items-center text-[10px] font-data-mono-lg text-slate-400 pt-1 border-t border-slate-800/80">
                        <span>Wind: {node.WIND_SPEED} km/h</span>
                        <span>Feels: {node["Feel Like"]}°C</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Drawer: Diagnostic SHAP Drawer */}
        {showDrawer && (
          <aside className="dashboard-panel flex flex-col border-l border-outline-variant/40 bg-surface-container-lowest overflow-hidden">
            <div className="p-3.5 border-b border-outline-variant/40 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-sm text-secondary">psychology</span>
                <span className="font-label-caps text-xs font-bold text-on-surface">DIAGNOSTIC_SHAP_DRAWER</span>
              </div>
              <span className="font-data-mono-lg text-[9px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                &lt;2ms TREE_EXPLAINER
              </span>
            </div>

            {/* If inspecting historical record banner */}
            {selectedHistoricalAnomaly && (
              <div className="bg-primary/10 border-b border-primary/30 px-3 py-2 flex justify-between items-center text-xs font-data-mono-lg shrink-0">
                <div className="flex items-center gap-1.5 text-primary text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
                  <span className="truncate">Historical: {selectedHistoricalAnomaly.timestamp?.replace('T', ' ').slice(0, 19)}</span>
                </div>
                <button
                  onClick={() => setSelectedHistoricalAnomaly(null)}
                  className="text-[10px] text-slate-300 hover:text-on-surface underline ml-2 shrink-0"
                >
                  Return to Live
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3.5">
              {/* Anomaly Score & Status Header Card */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-label-caps text-slate-400">CALIBRATED DECISION SCORE</span>
                  <span className={cn(
                    "text-[10px] font-label-caps font-bold px-1.5 py-0.2 rounded",
                    activeInspection?.is_anomaly ? "bg-wmo-rose/20 text-wmo-rose" : "bg-wmo-emerald/20 text-wmo-emerald"
                  )}>
                    {activeInspection?.is_anomaly ? 'ANOMALY_DETECTED' : 'IN_BOUNDS'}
                  </span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={cn(
                    "font-data-mono-lg text-2xl font-bold",
                    activeInspection?.is_anomaly ? "text-wmo-rose" : "text-wmo-emerald"
                  )}>
                    {activeInspection?.anomaly_score?.toFixed(4) || '0.0000'}
                  </span>
                  <span className="text-[10px] font-data-mono-lg text-slate-400">
                    / 1.0 (Conf: {
                      activeInspection?.confidence != null && activeInspection?.confidence !== ''
                        ? Math.round(Number(activeInspection.confidence))
                        : activeInspection?.confidence_score != null
                          ? Math.round(Number(activeInspection.confidence_score) * 100)
                          : 92
                    }%)
                  </span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      activeInspection?.is_anomaly ? "bg-wmo-rose" : "bg-wmo-emerald"
                    )}
                    style={{ width: `${Math.min(100, ((activeInspection?.anomaly_score || 0) / 0.7) * 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[8px] font-data-mono-lg text-slate-500">
                  <span>Nominal</span>
                  <span>T_mod: 0.4942</span>
                  <span>T_ext: 0.5647</span>
                </div>
              </div>

              {/* Root Cause & Self-Healing Action */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col gap-1.5">
                <div className="text-[10px] font-label-caps text-slate-400">DIAGNOSTIC ROOT-CAUSE TRIAGE</div>
                <div className={cn(
                  "font-data-mono-lg text-xs font-bold",
                  activeInspection?.is_anomaly ? "text-wmo-amber" : "text-wmo-emerald"
                )}>
                  {activeInspection?.root_cause || 'Nominal: In-Bounds'}
                </div>
                <div className="text-[10px] text-slate-400 font-data-mono-lg mt-1 pt-1 border-t border-slate-800 flex justify-between">
                  <span>QC Status:</span>
                  <span className="font-bold text-on-surface">
                    {activeInspection?.qc_flag === 0 && 'Flag 0 (Pristine)'}
                    {activeInspection?.qc_flag === 1 && 'Flag 1 (Suspect / Alert)'}
                    {activeInspection?.qc_flag === 2 && 'Flag 2 (Spatial IDW Healed)'}
                    {activeInspection?.qc_flag === 3 && 'Flag 3 (Spline Imputed)'}
                  </span>
                </div>
                {activeInspection?.healed_temp !== undefined && activeInspection?.raw_temp !== undefined && (
                  <div className="text-[10px] text-slate-400 font-data-mono-lg flex justify-between">
                    <span>Temp Correction:</span>
                    <span>
                      <strong className="text-wmo-rose">{activeInspection.raw_temp}°C</strong> → <strong className="text-wmo-emerald">{activeInspection.healed_temp}°C</strong>
                    </span>
                  </div>
                )}
              </div>

              {/* Top 3 Diagnostic Drivers Badges */}
              {activeInspection?.top_drivers && activeInspection.top_drivers.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5">
                  {activeInspection.top_drivers.slice(0, 3).map((d, i) => (
                    <div key={i} className="bg-slate-950/70 border border-slate-800 rounded p-1.5 flex flex-col">
                      <span className="text-[8px] font-label-caps text-slate-400 truncate">DRIVER #{i + 1}</span>
                      <span className={cn(
                        "font-data-mono-lg text-xs font-bold truncate mt-0.5",
                        activeInspection.is_anomaly ? "text-wmo-rose" : "text-wmo-emerald"
                      )}>
                        {d.value}
                      </span>
                      <span className="text-[8px] text-slate-400 truncate mt-0.5 font-mono">{d.label?.split(' ')[0] || d.feature}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* SHAP Feature Attribution Waterfall Bars */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 flex flex-col gap-2 flex-1">
                <div className="flex justify-between items-center border-b border-slate-800 pb-1.5">
                  <div className="text-[10px] font-label-caps text-slate-400">SHAP FEATURE ATTRIBUTION (16 FEAT)</div>
                  <span className="text-[9px] font-data-mono-lg text-slate-400">Signed Impact</span>
                </div>

                <div className="flex flex-col gap-2 overflow-y-auto max-h-[300px] pr-1">
                  {activeInspection?.top_drivers && activeInspection.top_drivers.length > 0 ? (
                    activeInspection.top_drivers.map((driver, idx) => {
                      const attr = driver.attribution || 0;
                      const isNegative = attr < 0; // Negative SHAP drives towards anomaly in scikit-learn IsolationForest
                      const barWidthPct = Math.min(100, (Math.abs(attr) / maxShapAttr) * 100);

                      return (
                        <div key={idx} className="flex flex-col gap-0.5">
                          <div className="flex justify-between text-[10px] font-data-mono-lg">
                            <span className="text-slate-300 truncate max-w-[170px]" title={driver.label}>
                              {driver.label || driver.feature}
                            </span>
                            <span className={cn(
                              "font-bold",
                              isNegative ? "text-wmo-rose" : "text-wmo-emerald"
                            )}>
                              {attr > 0 ? `+${attr.toFixed(3)}` : attr.toFixed(3)}
                            </span>
                          </div>

                          <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden flex">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-300",
                                isNegative
                                  ? "bg-gradient-to-r from-rose-500 to-wmo-rose"
                                  : "bg-gradient-to-r from-emerald-500 to-wmo-emerald"
                              )}
                              style={{ width: `${barWidthPct}%` }}
                            />
                          </div>

                          <div className="flex justify-between text-[8px] text-slate-500 font-data-mono-lg px-0.5">
                            <span>Observed: <strong className="text-slate-300">{driver.value}</strong></span>
                            <span className="opacity-75">{driver.direction} driver</span>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-slate-400 text-xs text-center py-4">No active SHAP drivers</div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}
      </main>

      {/* Fault Injection Simulation Bar (Footer) */}
      <footer className="h-16 bg-slate-900 border-t border-slate-800 flex items-center px-4 overflow-x-auto shrink-0 z-50 justify-between">
        <div className="flex items-center gap-6">
          <div className="font-label-caps text-on-surface-variant shrink-0 flex items-center gap-2 text-xs font-semibold">
            <span className="material-symbols-outlined text-sm text-primary">science</span>
            FAULT_INJECT_SIM:
          </div>
          <div className="flex gap-3 min-w-max">
            <button
              id="btn-spike"
              disabled={isTriggering}
              onClick={() => triggerFault('spike', 'temp', 15.0, '15°C SPIKE')}
              className={cn(
                "px-3 py-1.5 border rounded font-data-mono-lg text-xs transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50",
                activeFault === '15°C SPIKE'
                  ? "border-wmo-amber bg-wmo-amber/20 text-wmo-amber glow-amber-pulse font-bold"
                  : "border-slate-800 bg-slate-950 hover:bg-wmo-amber/10 text-wmo-amber/80 hover:text-wmo-amber"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-wmo-amber"></span> 15°C Spike
            </button>
            <button
              id="btn-freeze"
              disabled={isTriggering}
              onClick={() => triggerFault('freeze', 'pres', 0, 'ADC FREEZE')}
              className={cn(
                "px-3 py-1.5 border rounded font-data-mono-lg text-xs transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50",
                activeFault === 'ADC FREEZE'
                  ? "border-wmo-violet bg-wmo-violet/20 text-wmo-violet glow-violet-pulse font-bold"
                  : "border-slate-800 bg-slate-950 hover:bg-wmo-violet/10 text-wmo-violet/80 hover:text-wmo-violet"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-wmo-violet"></span> ADC Freeze
            </button>
            <button
              id="btn-drift"
              disabled={isTriggering}
              onClick={() => triggerFault('drift', 'pres', -2.0, 'BAROMETRIC DRIFT')}
              className={cn(
                "px-3 py-1.5 border rounded font-data-mono-lg text-xs transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50",
                activeFault === 'BAROMETRIC DRIFT'
                  ? "border-wmo-skyblue bg-wmo-skyblue/20 text-wmo-skyblue glow-skyblue-pulse font-bold"
                  : "border-slate-800 bg-slate-950 hover:bg-wmo-skyblue/10 text-wmo-skyblue/80 hover:text-wmo-skyblue"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-wmo-skyblue"></span> Barometric Drift
            </button>
            <button
              id="btn-thermo"
              disabled={isTriggering}
              onClick={() => triggerFault('thermo', 'temp', 0, 'WET-BULB VIOLATION')}
              className={cn(
                "px-3 py-1.5 border rounded font-data-mono-lg text-xs transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50",
                activeFault === 'WET-BULB VIOLATION'
                  ? "border-wmo-rose bg-wmo-rose/20 text-wmo-rose glow-rose-pulse font-bold"
                  : "border-slate-800 bg-slate-950 hover:bg-wmo-rose/10 text-wmo-rose/80 hover:text-wmo-rose"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-wmo-rose"></span> Wet-Bulb Violation
            </button>
            <div className="w-px h-6 bg-slate-800 mx-2"></div>
            <button
              id="btn-reset"
              disabled={isTriggering}
              onClick={resetData}
              className="px-4 py-1.5 bg-primary-container text-on-primary rounded font-data-mono-lg text-xs font-bold hover:brightness-110 transition-all active:scale-95 disabled:opacity-50 shadow-sm"
            >
              Reset to Live Data
            </button>
          </div>
        </div>

        {/* Live Simulation Indicator */}
        <div className="hidden lg:flex items-center gap-2 text-[10px] font-data-mono-lg text-slate-400">
          <span className="material-symbols-outlined text-xs text-secondary">bolt</span>
          <span>Response Latency: &lt;15ms | Self-Healing: Active</span>
        </div>
      </footer>

      {/* IMD API Credentials Configuration Modal */}
      {showImdModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full p-5 shadow-2xl flex flex-col gap-4">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-xl text-amber-400">key</span>
                <h3 className="text-sm font-bold text-slate-100 font-label-caps">CONFIGURE IMD API CREDENTIALS</h3>
              </div>
              <button
                onClick={() => setShowImdModal(false)}
                className="text-slate-400 hover:text-slate-100 text-lg leading-none"
              >
                ×
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed font-sans">
              To access official real-time meteorological observations directly from India Meteorological Department (IMD) servers, register at the official portal and input your credentials below.
            </p>

            <form onSubmit={handleConfigureImd} className="flex flex-col gap-3 font-data-mono-lg text-xs">
              <div>
                <label className="text-slate-400 block mb-1">X-API-KEY (Header: x-api-key):</label>
                <input
                  type="text"
                  value={imdApiKeyInput}
                  onChange={(e) => setImdApiKeyInput(e.target.value)}
                  placeholder="Paste your IMD x-api-key here..."
                  className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-slate-200 focus:outline-none focus:border-sky-500 font-mono text-xs"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">JWT TOKEN (Authorization: Bearer &lt;token&gt;):</label>
                <textarea
                  rows={3}
                  value={imdJwtTokenInput}
                  onChange={(e) => setImdJwtTokenInput(e.target.value)}
                  placeholder="Paste your IMD JWT token here..."
                  className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-slate-200 focus:outline-none focus:border-sky-500 font-mono text-xs"
                />
              </div>

              {imdConfigStatus && (
                <div className="text-xs font-bold text-sky-400 bg-sky-950/30 border border-sky-800 p-2 rounded">
                  {imdConfigStatus}
                </div>
              )}

              <div className="flex justify-between items-center pt-2 font-sans">
                <a
                  href="https://api.imd.gov.in/public/login.php"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-sky-400 hover:underline flex items-center gap-1"
                >
                  <span>Register / Login at IMD Portal</span>
                  <span className="material-symbols-outlined text-xs">open_in_new</span>
                </a>

                <div className="flex gap-2 font-label-caps">
                  <button
                    type="button"
                    onClick={() => setShowImdModal(false)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-bold rounded"
                  >
                    Save & Test
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

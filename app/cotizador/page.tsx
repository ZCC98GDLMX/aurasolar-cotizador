// app/cotizador/page.tsx — Solar PV Sizer & ROI for Guadalajara, MX
"use client";

import React, { useMemo, useState } from "react";

// ----------------------------
// Types & Helpers
// ----------------------------

type Tariff = "01" | "DAC" | "GDMT" | "GDMTH";
type MonthlyMap = Record<string, number>;
type Row = Record<string, string | number>;

const MONTHS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"] as const;

function fmt(n: number, digits = 2) {
  if (!isFinite(n)) return "N/D";
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: digits }).format(n);
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function annualPerKwGeneration(psh: number, pr: number, availability: number, extraLosses: number) {
  const base = psh * 365;
  const losses = pr * availability * (1 - extraLosses);
  return base * losses; // kWh/kW-year
}

function monthlyShape(amplitude = 0.10) {
  // Forma estacional tipo coseno con pico ~Junio para GDL
  const m = Array.from({ length: 12 }, (_, i) => i);
  const phaseShift = 5; // pico ~Jun (índice 5)
  let raw = m.map((i) => 1 + amplitude * Math.cos((2 * Math.PI * (i - phaseShift)) / 12));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  raw = raw.map((x) => x / mean);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => (x * 12) / sum); // suma=12
}

function sizeSystem(consumption: MonthlyMap, annualKWhPerKW: number, targetCoverage: number, panelWatts: number) {
  const annualLoad = MONTHS.reduce((acc, m) => acc + (consumption[m] || 0), 0);
  const neededKW = (annualLoad * targetCoverage) / annualKWhPerKW;
  const panels = Math.ceil((neededKW * 1000) / panelWatts);
  const systemKW = (panels * panelWatts) / 1000;
  const expectedAnnual = systemKW * annualKWhPerKW;
  return { panels, systemKW, expectedAnnual, annualLoad };
}

function monthlyGeneration(systemKW: number, annualKWhPerKW: number) {
  const shape = monthlyShape();
  const monthly = shape.map((s) => (systemKW * annualKWhPerKW) * (s / 12));
  const out: MonthlyMap = {};
  MONTHS.forEach((m, i) => (out[m] = Number(monthly[i].toFixed(2))));
  return out;
}

function estimateDemandKW(kwhMonth: number, loadFactor = 0.4, days = 30) {
  const kwAvg = kwhMonth / (days * 24);
  return kwAvg / Math.max(loadFactor, 1e-6);
}

// ----------------------------
// Tarifas (modelos simplificados)
// ----------------------------

// Tarifa 01 por bloques (Básico, Intermedio, Excedente) + cargo fijo
interface TariffParams01 {
  fixed_mxn: number;              // cargo fijo mensual
  kwh_basic_limit: number;        // kWh/mes en bloque Básico
  kwh_intermediate_limit: number; // kWh/mes acumulado hasta Intermedio (Básico + Intermedio)
  mxn_per_kwh_basic: number;         // $/kWh Básico
  mxn_per_kwh_intermediate: number;  // $/kWh Intermedio
  mxn_per_kwh_exceed: number;        // $/kWh Excedente
}

interface TariffParamsDAC { mxn_per_kwh: number; fixed_mxn: number; }

interface TariffParamsGDMT {
  mxn_per_kwh: number;
  fixed_mxn: number;
  mxn_per_kw_demand: number;
  assumed_load_factor: number;
}

interface TariffParamsGDMTH {
  mxn_per_kwh_punta: number;
  mxn_per_kwh_intermedia: number;
  mxn_per_kwh_base: number;
  fixed_mxn: number;
  mxn_per_kw_demand: number;
  split_punta: number; split_intermedia: number; split_base: number;
  assumed_load_factor: number;
}

/** Unión de parámetros válidos por tarifa */
type TariffParams = TariffParams01 | TariffParamsDAC | TariffParamsGDMT | TariffParamsGDMTH;

const DEFAULT_TARIFFS = {
  "01": {
    fixed_mxn: 100,
    kwh_basic_limit: 75,              // ajusta a tu zona (kWh/mes)
    kwh_intermediate_limit: 140,      // ajusta a tu zona (kWh/mes)
    mxn_per_kwh_basic: 1.0,
    mxn_per_kwh_intermediate: 1.8,
    mxn_per_kwh_exceed: 3.5,
  } as TariffParams01,
  DAC: { mxn_per_kwh: 6.2, fixed_mxn: 120 } as TariffParamsDAC,
  GDMT: { mxn_per_kwh: 3.3, fixed_mxn: 300, mxn_per_kw_demand: 130, assumed_load_factor: 0.4 } as TariffParamsGDMT,
  GDMTH: {
    mxn_per_kwh_punta: 6.0,
    mxn_per_kwh_intermedia: 3.5,
    mxn_per_kwh_base: 2.0,
    fixed_mxn: 400,
    mxn_per_kw_demand: 150,
    split_punta: 0.22,
    split_intermedia: 0.38,
    split_base: 0.40,
    assumed_load_factor: 0.4,
  } as TariffParamsGDMTH,
};

// ----------------------------
// Cálculo de recibos
// ----------------------------

function billCFE(tariff: Tariff, kwh: number, params: TariffParams): number {
  switch (tariff) {
    case "01": {
      const p = params as TariffParams01;
      const b1 = Math.max(Math.min(kwh, p.kwh_basic_limit), 0);
      const b2 = Math.max(Math.min(kwh, p.kwh_intermediate_limit) - p.kwh_basic_limit, 0);
      const b3 = Math.max(kwh - p.kwh_intermediate_limit, 0);
      const energy =
        b1 * p.mxn_per_kwh_basic +
        b2 * p.mxn_per_kwh_intermediate +
        b3 * p.mxn_per_kwh_exceed;
      return round2(energy + (p.fixed_mxn || 0));
    }
    case "DAC": {
      const p = params as TariffParamsDAC;
      return round2(p.mxn_per_kwh * kwh + (p.fixed_mxn || 0));
    }
    case "GDMT": {
      const p = params as TariffParamsGDMT;
      const energy = p.mxn_per_kwh * kwh;
      const demandKW = estimateDemandKW(kwh, p.assumed_load_factor);
      const demand = p.mxn_per_kw_demand * demandKW;
      return round2(energy + demand + (p.fixed_mxn || 0));
    }
    case "GDMTH": {
      const p = params as TariffParamsGDMTH;
      const kwhP = kwh * p.split_punta, kwhI = kwh * p.split_intermedia, kwhB = kwh * p.split_base;
      const energy = p.mxn_per_kwh_punta * kwhP + p.mxn_per_kwh_intermedia * kwhI + p.mxn_per_kwh_base * kwhB;
      const demandKW = estimateDemandKW(kwh, p.assumed_load_factor);
      const demand = p.mxn_per_kw_demand * demandKW;
      return round2(energy + demand + (p.fixed_mxn || 0));
    }
  }
}

function billsByMonth(consumption: MonthlyMap, tariff: Tariff, params: TariffParams): MonthlyMap {
  const out: MonthlyMap = {};
  MONTHS.forEach((m) => (out[m] = billCFE(tariff, consumption[m] || 0, params)));
  return out;
}

function applyNetMetering(consumption: MonthlyMap, generation: MonthlyMap, netMetering: boolean, carryover: boolean) {
  const net: MonthlyMap = {};
  const creditsTrace: MonthlyMap = {};
  let wallet = 0;
  MONTHS.forEach((m) => {
    const cons = consumption[m] || 0;
    const gen = generation[m] || 0;
    if (!netMetering) {
      net[m] = round2(cons);
      creditsTrace[m] = carryover ? wallet : 0;
      return;
    }
    let withinNet = cons - gen;
    if (carryover) {
      if (withinNet > 0) {
        const use = Math.min(wallet, withinNet);
        withinNet -= use;
        wallet -= use;
      } else {
        wallet += Math.abs(withinNet);
        withinNet = 0;
      }
    } else {
      withinNet = Math.max(withinNet, 0);
    }
    net[m] = round2(withinNet);
    creditsTrace[m] = round2(wallet);
  });
  return { net, creditsTrace };
}

function billsWithSolar(
  consumption: MonthlyMap,
  generation: MonthlyMap,
  tariff: Tariff,
  params: TariffParams,
  netMetering: boolean,
  carryover: boolean
): { bills: MonthlyMap; creditsTrace: MonthlyMap } {
  const { net, creditsTrace } = applyNetMetering(consumption, generation, netMetering, carryover);
  const bills: MonthlyMap = {};
  MONTHS.forEach((m) => {
    const kwh = net[m];
    if (tariff === "GDMT") {
      const p = params as TariffParamsGDMT;
      const energy = p.mxn_per_kwh * kwh;
      const demandKW = estimateDemandKW(consumption[m] || 0, p.assumed_load_factor);
      const demand = p.mxn_per_kw_demand * demandKW;
      bills[m] = round2(energy + demand + (p.fixed_mxn || 0));
    } else if (tariff === "GDMTH") {
      const p = params as TariffParamsGDMTH;
      const kwhP = kwh * p.split_punta, kwhI = kwh * p.split_intermedia, kwhB = kwh * p.split_base;
      const energy = p.mxn_per_kwh_punta * kwhP + p.mxn_per_kwh_intermedia * kwhI + p.mxn_per_kwh_base * kwhB;
      const demandKW = estimateDemandKW(consumption[m] || 0, p.assumed_load_factor);
      const demand = p.mxn_per_kw_demand * demandKW;
      bills[m] = round2(energy + demand + (p.fixed_mxn || 0));
    } else {
      // 01 / DAC: neteo sobre energía
      bills[m] = billCFE(tariff, kwh, params);
    }
  });
  return { bills, creditsTrace };
}

// ----------------------------
// ROI / Finanzas
// ----------------------------

function sumMap(map: MonthlyMap) {
  return MONTHS.reduce((acc, m) => acc + (map[m] || 0), 0);
}

// IRR (Newton + bisección)
function irr(cashflows: number[], guess = 0.1) {
  const npv = (r: number) => cashflows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + r, i), 0);
  const dnpv = (r: number) => cashflows.slice(1).reduce((acc, cf, i) => acc - (i + 1) * cf / Math.pow(1 + r, i + 2), 0);
  let r = guess;
  for (let i = 0; i < 50; i++) {
    const f = npv(r);
    const df = dnpv(r);
    if (Math.abs(f) < 1e-6) return r;
    if (df === 0 || !isFinite(df)) break;
    r = r - f / df;
    if (r <= -0.99) r = -0.99;
  }
  let low = -0.9, high = 1.0;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const fmid = npv(mid);
    if (Math.abs(fmid) < 1e-6) return mid;
    const flow = npv(low);
    if (flow * fmid < 0) high = mid; else low = mid;
  }
  return NaN;
}

function roiCashflows(
  capex: number,
  billsNow: MonthlyMap,
  billsSolarY1: MonthlyMap,
  discount: number,
  inflation: number,
  omRate: number,
  years: number,
  degradation = 0.005
) {
  const annualNow = sumMap(billsNow);
  const annualSolarY1 = sumMap(billsSolarY1);
  const rows: { year: number; cf: number; pv: number; cum: number }[] = [];
  let cum = -capex;
  let payback: number | null = null;
  for (let y = 0; y <= years; y++) {
    let cf: number;
    if (y === 0) {
      cf = -capex;
    } else {
      const degr = Math.pow(1 - degradation, y - 1);
      const priceF = Math.pow(1 + inflation, y - 1);
      const om = -omRate * capex * priceF;
      const savingsY1 = annualNow - annualSolarY1;
      const savingsY = savingsY1 * degr * priceF;
      cf = savingsY + om;
    }
    const pv = cf / Math.pow(1 + discount, y);
    cum += y === 0 ? 0 : cf;
    if (payback === null && cum >= 0 && y > 0) payback = y;
    rows.push({ year: y, cf, pv, cum });
  }
  const npv = rows.reduce((a, r) => a + r.pv, 0);
  const irrVal = irr(rows.map((r) => r.cf));
  return { rows, payback, npv, irr: irrVal };
}

// ----------------------------
// CSV export
// ----------------------------

function downloadCSV(filename: string, tables: Record<string, Row[]>) {
  const parts: string[] = [];
  for (const [name, rows] of Object.entries(tables)) {
    parts.push(`# ${name}`);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    parts.push(cols.join(","));
    for (const r of rows) {
      parts.push(cols.map((c) => String(r[c] ?? "")).join(","));
    }
    parts.push("");
  }
  const blob = new Blob([parts.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------
// Component
// ----------------------------

export default function Page() {
  // Inputs
  const [consumption, setConsumption] = useState<MonthlyMap>({
    Ene: 450, Feb: 420, Mar: 480, Abr: 520, May: 600, Jun: 650,
    Jul: 700, Ago: 680, Sep: 560, Oct: 520, Nov: 480, Dic: 460,
  });

  const [psh, setPsh] = useState(5.5);
  const [pr, setPr] = useState(0.8);
  const [availability, setAvailability] = useState(0.99);
  const [extraLoss, setExtraLoss] = useState(0.0);

  const [panelW, setPanelW] = useState(550);
  const [costPerKW, setCostPerKW] = useState(23000);
  const [omPct, setOmPct] = useState(0.01);

  const [discount, setDiscount] = useState(0.10);
  const [inflation, setInflation] = useState(0.05);
  const [years, setYears] = useState(25);
  const [degradation, setDegradation] = useState(0.005);

  const [tariff, setTariff] = useState<Tariff>("01");
  const [t01, setT01] = useState(DEFAULT_TARIFFS["01"]);
  const [tDAC, setTDAC] = useState(DEFAULT_TARIFFS.DAC);
  const [tGDMT, setTGDMT] = useState(DEFAULT_TARIFFS.GDMT);
  const [tGDMTH, setTGDMTH] = useState(DEFAULT_TARIFFS.GDMTH);

  const [targetCoverage, setTargetCoverage] = useState(0.95);
  const [netMetering, setNetMetering] = useState(true);
  const [carryover, setCarryover] = useState(false);

  const params: TariffParams =
    tariff === "01" ? t01 :
    tariff === "DAC" ? tDAC :
    tariff === "GDMT" ? tGDMT : tGDMTH;

  // Cálculos principales
  const annualKWhPerKW = useMemo(() => annualPerKwGeneration(psh, pr, availability, extraLoss), [psh, pr, availability, extraLoss]);

  const { panels, systemKW, expectedAnnual, annualLoad } = useMemo(
    () => sizeSystem(consumption, annualKWhPerKW, targetCoverage, panelW),
    [consumption, annualKWhPerKW, targetCoverage, panelW]
  );

  const genMonth = useMemo(() => monthlyGeneration(systemKW, annualKWhPerKW), [systemKW, annualKWhPerKW]);

  const billsNow = useMemo(() => billsByMonth(consumption, tariff, params), [consumption, tariff, params]);

  const { bills: billsSolar, creditsTrace } = useMemo(
    () => billsWithSolar(consumption, genMonth, tariff, params, netMetering, carryover),
    [consumption, genMonth, tariff, params, netMetering, carryover]
  );

  const savingsMXN: MonthlyMap = useMemo(() => {
    const out: MonthlyMap = {};
    MONTHS.forEach((m) => (out[m] = round2((billsNow[m] || 0) - (billsSolar[m] || 0))));
    return out;
  }, [billsNow, billsSolar]);

  const savingsPct: MonthlyMap = useMemo(() => {
    const out: MonthlyMap = {};
    MONTHS.forEach((m) => (out[m] = round2(((savingsMXN[m] || 0) / Math.max(billsNow[m] || 0, 1e-9)) * 100)));
    return out;
  }, [savingsMXN, billsNow]);

  const capex = useMemo(() => systemKW * costPerKW, [systemKW, costPerKW]);

  const roi = useMemo(
    () => roiCashflows(capex, billsNow, billsSolar, discount, inflation, omPct, years, degradation),
    [capex, billsNow, billsSolar, discount, inflation, omPct, years, degradation]
  );

  const summary = useMemo(() => ([
    { Indicador: "CAPEX (MXN)", Valor: fmt(capex, 0) },
    { Indicador: "Factura anual actual (MXN)", Valor: fmt(sumMap(billsNow), 0) },
    { Indicador: "Factura anual con PV (MXN)", Valor: fmt(sumMap(billsSolar), 0) },
    { Indicador: "Ahorro anual año 1 (MXN)", Valor: fmt(sumMap(savingsMXN), 0) },
    { Indicador: "Payback (años)", Valor: roi.payback ?? "N/D" },
    { Indicador: `NPV (MXN, ${years} años)`, Valor: fmt(roi.npv, 0) },
    { Indicador: "IRR (anual)", Valor: isFinite(roi.irr) ? `${fmt(roi.irr * 100, 1)}%` : "N/D" },
  ]), [capex, billsNow, billsSolar, savingsMXN, roi, years]);

  function updateConsumption(m: string, val: string) {
    const v = Number(val.replace(",", ".")) || 0;
    setConsumption((c) => ({ ...c, [m]: v }));
  }

  function downloadAllAsCSV() {
    const genRows = MONTHS.map((m) => ({ Mes: m, Generacion_kWh: genMonth[m] }));
    const billNowRows = MONTHS.map((m) => ({ Mes: m, Consumo_kWh: consumption[m], Factura_actual_MXN: billsNow[m] }));
    const billSolarRows = MONTHS.map((m) => ({
      Mes: m,
      Consumo_neto_kWh: (consumption[m] - genMonth[m]) < 0 && carryover ? 0 : Math.max(consumption[m] - genMonth[m], 0),
      Factura_con_PV_MXN: billsSolar[m],
      Creditos_kWh: creditsTrace[m]
    }));
    const savingsRows = MONTHS.map((m) => ({ Mes: m, Ahorro_MXN: savingsMXN[m], Ahorro_pct: savingsPct[m] }));
    const summaryRows = summary.map((r) => ({ Indicador: r.Indicador, Valor: r.Valor }));
    downloadCSV("dimensionador_gdl.csv", {
      "Generacion": genRows,
      "Factura_actual": billNowRows,
      "Factura_con_PV": billSolarRows,
      "Ahorros": savingsRows,
      "Resumen": summaryRows,
      "Flujos": roi.rows.map((r) => ({ Anio: r.year, Flujo: round2(r.cf), Flujo_descontado: round2(r.pv), Acumulado: round2(r.cum) })),
    });
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="px-6 py-5 border-b bg-white sticky top-0 z-10">
        <h1 className="text-2xl font-semibold">Cotizador FV — Guadalajara, Jalisco</h1>
        <p className="text-sm text-neutral-600">Dimensionamiento, recibos CFE y ROI (tarifas 01, DAC, GDMT, GDMTH). Edita parámetros y obtén resultados al instante.</p>
      </header>

      <main className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Columna izquierda: entradas */}
        <section className="xl:col-span-1 space-y-6">
          <Card title="Consumo mensual (kWh)">
            <div className="grid grid-cols-3 gap-3">
              {MONTHS.map((m) => (
                <div key={m} className="flex flex-col">
                  <label className="text-xs text-neutral-600 mb-1">{m}</label>
                  <input
                    className="px-3 py-2 rounded-xl border bg-white"
                    type="number"
                    min={0}
                    value={consumption[m]}
                    onChange={(e) => updateConsumption(m, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </Card>

          <Card title="Ubicación & Producción (GDL)">
            <div className="grid grid-cols-2 gap-3">
              <Num label="PSH (kWh/m²/día)" value={psh} setValue={setPsh} step={0.1} />
              <Num label="Performance Ratio" value={pr} setValue={setPr} step={0.01} />
              <Num label="Disponibilidad" value={availability} setValue={setAvailability} step={0.01} />
              <Num label="Pérdidas extra" value={extraLoss} setValue={setExtraLoss} step={0.01} />
            </div>
          </Card>

          <Card title="Módulos & Costos">
            <div className="grid grid-cols-2 gap-3">
              <Num label="Potencia por panel (W)" value={panelW} setValue={setPanelW} step={10} />
              <Num label="Costo por kW (MXN/kW)" value={costPerKW} setValue={setCostPerKW} step={500} />
              <Num label="O&M (% capex/año)" value={omPct} setValue={setOmPct} step={0.005} />
              <Num label="Degradación anual" value={degradation} setValue={setDegradation} step={0.001} />
            </div>
          </Card>

          <Card title="Finanzas">
            <div className="grid grid-cols-2 gap-3">
              <Num label="Tasa de descuento" value={discount} setValue={setDiscount} step={0.01} />
              <Num label="Inflación energética" value={inflation} setValue={setInflation} step={0.01} />
              <Num label="Años de análisis" value={years} setValue={setYears} step={1} />
            </div>
          </Card>

          <Card title="Neteo & Cobertura">
            <div className="grid grid-cols-2 gap-3">
              <Num label="Meta cobertura (0–1)" value={targetCoverage} setValue={setTargetCoverage} step={0.01} />
              <div className="flex items-center gap-3">
                <input id="nm" type="checkbox" checked={netMetering} onChange={(e) => setNetMetering(e.target.checked)} />
                <label htmlFor="nm" className="text-sm">Neteo</label>
              </div>
              <div className="flex items-center gap-3">
                <input id="cr" type="checkbox" checked={carryover} onChange={(e) => setCarryover(e.target.checked)} />
                <label htmlFor="cr" className="text-sm">Créditos acumulables</label>
              </div>
            </div>
          </Card>

          <Card title="Tarifa CFE">
            <div className="space-y-3">
              <div className="flex gap-3 flex-wrap items-center">
                {(["01","DAC","GDMT","GDMTH"] as Tariff[]).map((t) => (
                  <button key={t} onClick={() => setTariff(t)} className={`px-3 py-1 rounded-full border ${tariff === t ? "bg-black text-white" : "bg-white"}`}>
                    {t}
                  </button>
                ))}
              </div>

              {/* 01 por bloques */}
              {tariff === "01" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cargo fijo (MXN)" value={t01.fixed_mxn} setValue={(v)=>setT01({...t01, fixed_mxn:v})} step={10} />
                  <Num label="Límite Básico (kWh/mes)" value={t01.kwh_basic_limit} setValue={(v)=>setT01({...t01, kwh_basic_limit:v})} step={5} />
                  <Num label="Límite Intermedio (kWh/mes)" value={t01.kwh_intermediate_limit} setValue={(v)=>setT01({...t01, kwh_intermediate_limit:v})} step={5} />
                  <Num label="Tarifa Básico ($/kWh)" value={t01.mxn_per_kwh_basic} setValue={(v)=>setT01({...t01, mxn_per_kwh_basic:v})} step={0.05} />
                  <Num label="Tarifa Intermedio ($/kWh)" value={t01.mxn_per_kwh_intermediate} setValue={(v)=>setT01({...t01, mxn_per_kwh_intermediate:v})} step={0.05} />
                  <Num label="Tarifa Excedente ($/kWh)" value={t01.mxn_per_kwh_exceed} setValue={(v)=>setT01({...t01, mxn_per_kwh_exceed:v})} step={0.05} />
                </div>
              )}

              {/* DAC */}
              {tariff === "DAC" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh" value={tDAC.mxn_per_kwh} setValue={(v)=>setTDAC({...tDAC, mxn_per_kwh:v})} step={0.1} />
                  <Num label="Cargo fijo (MXN)" value={tDAC.fixed_mxn} setValue={(v)=>setTDAC({...tDAC, fixed_mxn:v})} step={10} />
                </div>
              )}

              {/* GDMT */}
              {tariff === "GDMT" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh" value={tGDMT.mxn_per_kwh} setValue={(v)=>setTGDMT({...tGDMT, mxn_per_kwh:v})} step={0.1} />
                  <Num label="Cargo fijo (MXN)" value={tGDMT.fixed_mxn} setValue={(v)=>setTGDMT({...tGDMT, fixed_mxn:v})} step={10} />
                  <Num label="MXN/kW demanda" value={tGDMT.mxn_per_kw_demand} setValue={(v)=>setTGDMT({...tGDMT, mxn_per_kw_demand:v})} step={5} />
                  <Num label="Load factor" value={tGDMT.assumed_load_factor} setValue={(v)=>setTGDMT({...tGDMT, assumed_load_factor:v})} step={0.05} />
                </div>
              )}

              {/* GDMTH */}
              {tariff === "GDMTH" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh punta" value={tGDMTH.mxn_per_kwh_punta} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_punta:v})} step={0.1} />
                  <Num label="MXN/kWh intermedia" value={tGDMTH.mxn_per_kwh_intermedia} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_intermedia:v})} step={0.1} />
                  <Num label="MXN/kWh base" value={tGDMTH.mxn_per_kwh_base} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_base:v})} step={0.1} />
                  <Num label="Cargo fijo (MXN)" value={tGDMTH.fixed_mxn} setValue={(v)=>setTGDMTH({...tGDMTH, fixed_mxn:v})} step={10} />
                  <Num label="MXN/kW demanda" value={tGDMTH.mxn_per_kw_demand} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kw_demand:v})} step={5} />
                  <Num label="Split punta" value={tGDMTH.split_punta} setValue={(v)=>setTGDMTH({...tGDMTH, split_punta:v})} step={0.01} />
                  <Num label="Split intermedia" value={tGDMTH.split_intermedia} setValue={(v)=>setTGDMTH({...tGDMTH, split_intermedia:v})} step={0.01} />
                  <Num label="Split base" value={tGDMTH.split_base} setValue={(v)=>setTGDMTH({...tGDMTH, split_base:v})} step={0.01} />
                  <Num label="Load factor" value={tGDMTH.assumed_load_factor} setValue={(v)=>setTGDMTH({...tGDMTH, assumed_load_factor:v})} step={0.05} />
                </div>
              )}
            </div>
          </Card>

          <div className="flex gap-3">
            <button onClick={downloadAllAsCSV} className="px-4 py-2 rounded-xl bg-black text-white">Descargar CSV</button>
          </div>
        </section>

        {/* Columnas derechas: salidas */}
        <section className="xl:col-span-2 space-y-6">
          <Card title="Dimensionamiento del sistema">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <KV k="Paneles" v={String(panels)} />
              <KV k="Tamaño (kWdc)" v={fmt(systemKW, 2)} />
              <KV k="Generación anual esperada (kWh)" v={fmt(expectedAnnual, 0)} />
              <KV k="Consumo anual (kWh)" v={fmt(annualLoad, 0)} />
              <KV k="kWh/kW-año" v={fmt(annualKWhPerKW, 0)} />
              <KV k="CAPEX (MXN)" v={fmt(capex, 0)} />
            </div>
          </Card>

          <TwoCol>
            <Card title="Generación mensual (kWh)">
              <Table rows={MONTHS.map((m) => ({ Mes: m, "Generación (kWh)": fmt(genMonth[m], 2) }))} />
            </Card>
            <Card title="Factura actual por mes (sin PV)">
              <Table rows={MONTHS.map((m) => ({ Mes: m, "Consumo (kWh)": fmt(consumption[m], 0), "Factura (MXN)": fmt(billsNow[m], 2) }))} />
            </Card>
          </TwoCol>

          <TwoCol>
            <Card title="Factura con PV (neteo simplificado)">
              <Table rows={MONTHS.map((m) => ({ Mes: m, "Consumo neto (kWh)": fmt(Math.max(consumption[m] - genMonth[m], 0), 2), "Factura con PV (MXN)": fmt(billsSolar[m], 2), "Créditos (kWh)": fmt(creditsTrace[m], 2) }))} />
            </Card>
            <Card title="Ahorro mensual vs. actual">
              <Table rows={MONTHS.map((m) => ({ Mes: m, "Ahorro (MXN)": fmt(savingsMXN[m], 2), "% Ahorro": `${fmt(savingsPct[m], 1)}%` }))} />
            </Card>
          </TwoCol>

          <Card title="Resumen financiero (ROI)">
            <Table rows={summary} />
            <div className="mt-4 overflow-auto">
              <Table rows={roi.rows.map((r) => ({ "Año": r.year, "Flujo (MXN)": fmt(r.cf, 2), "Flujo descontado (MXN)": fmt(r.pv, 2), "Acumulado (MXN)": fmt(r.cum, 2) }))} />
            </div>
            <p className="text-xs text-neutral-500 mt-3">
              Nota: Modelo simplificado. Las tarifas CFE varían por región/temporada y pueden incluir bloques, demanda medida y medición horaria. Ajusta los parámetros a tu recibo.
            </p>
          </Card>
        </section>
      </main>
    </div>
  );
}

// ----------------------------
// UI helpers
// ----------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border p-4">
      <h2 className="text-lg font-medium mb-3">{title}</h2>
      {children}
    </section>
  );
}

function TwoCol({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{children}</div>;
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-neutral-50 rounded-xl p-3 border">
      <div className="text-xs text-neutral-500">{k}</div>
      <div className="text-base font-medium">{v}</div>
    </div>
  );
}

function Table({ rows }: { rows: Row[] }) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b bg-neutral-50">
            {cols.map((c) => (
              <th key={c} className="px-2 py-2 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              {cols.map((c) => (
                <td key={c} className="px-2 py-2 whitespace-nowrap">{String(r[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Num({ label, value, setValue, step = 1 }: { label: string; value: number; setValue: (v: number) => void; step?: number }) {
  return (
    <div className="flex flex-col">
      <label className="text-xs text-neutral-600 mb-1">{label}</label>
      <input
        className="px-3 py-2 rounded-xl border bg-white"
        type="number"
        step={step}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
      />
    </div>
  );
}

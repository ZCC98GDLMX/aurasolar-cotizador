// app/cotizador/page.tsx
// Cotizador FV — Bimestral (GDL) con PDBT desglosado y % ahorro por bimestre

"use client";

import React, { useMemo, useState } from "react";
// usando ruta relativa (seguro)
import NumField from "../components/Num";

// o si ya tienes alias configurado en tsconfig
// import { Num } from "@/components/Num";




// ----------------------------
// Tipos & helpers
// ----------------------------

type Tariff = "01" | "DAC" | "GDMT" | "GDMTH" | "PDBT";

type BKey = "B1" | "B2" | "B3" | "B4" | "B5" | "B6";
type BMap = Record<BKey, number>;

type Month =
  | "Ene" | "Feb" | "Mar" | "Abr" | "May" | "Jun"
  | "Jul" | "Ago" | "Sep" | "Oct" | "Nov" | "Dic";

const MONTHS = [
  "Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic",
] as const;

const MONTH_INDEX: Record<Month, number> = {
  Ene:0, Feb:1, Mar:2, Abr:3, May:4, Jun:5,
  Jul:6, Ago:7, Sep:8, Oct:9, Nov:10, Dic:11,
};

const BIM_GROUPS: readonly (readonly [Month, Month])[] = [
  ["Ene","Feb"], ["Mar","Abr"], ["May","Jun"],
  ["Jul","Ago"], ["Sep","Oct"], ["Nov","Dic"],
] as const;

const BIM_LABELS: Record<BKey, string> = {
  B1: "Ene–Feb", B2: "Mar–Abr", B3: "May–Jun",
  B4: "Jul–Ago", B5: "Sep–Oct", B6: "Nov–Dic",
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function fmt(n: number | string, digits = 2) {
  const num = typeof n === "number" ? n : Number(n);
  if (!isFinite(num)) return "N/D";
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: digits }).format(num);
}

// PR/producción
function annualPerKwGeneration(
  psh: number, pr: number, availability: number, extraLosses: number
) {
  const base = psh * 365; // kWh/kW-año ideal
  const eff = pr * availability * (1 - extraLosses);
  return base * eff; // kWh/kW-año real
}

// estacionalidad mensual (normalizada) y agregación bimestral
function monthlyShape(amplitude = 0.10) {
  const m = Array.from({ length: 12 }, (_, i) => i);
  const phaseShift = 5; // pico ~Jun
  let raw = m.map((i) => 1 + amplitude * Math.cos((2 * Math.PI * (i - phaseShift)) / 12));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  raw = raw.map((x) => x / mean);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => (x * 12) / sum); // suma=12
}

function bimestralGeneration(systemKW: number, annualKWhPerKW: number): BMap {
  const monthly = monthlyShape().map((s) => (systemKW * annualKWhPerKW) * (s / 12));
  const out: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  BIM_GROUPS.forEach((pair, i) => {
    const a = MONTH_INDEX[pair[0]];
    const b = MONTH_INDEX[pair[1]];
    const sum = (monthly[a] || 0) + (monthly[b] || 0);
    out[`B${i+1}` as BKey] = round2(sum);
  });
  return out;
}

function sumBMap(map: BMap) {
  return (Object.keys(map) as BKey[]).reduce((acc, k) => acc + (map[k] || 0), 0);
}

// Estimar demanda (kW) desde kWh Bimestrales (≈ 60 días)
const estimateDemandKWFromBim = (
  kwhBim: number,
  loadFactor: number = 0.4,
  days: number = 60
): number => {
  const kwAvg = kwhBim / (days * 24);
  return kwAvg / Math.max(loadFactor, 1e-6);
};

// ----------------------------
// Parámetros de tarifas (BIM)
// ----------------------------

// Tarifa 01 por bloques (bimestral)
interface TariffParams01Bim {
  fixed_mxn_bim: number;
  kwh_basic_block_bim: number;        // p.ej. 150 kWh/BIM
  kwh_intermediate_block_bim: number; // p.ej. 130 kWh/BIM
  mxn_per_kwh_basic: number;
  mxn_per_kwh_intermediate: number;
  mxn_per_kwh_exceed: number;
}

interface TariffParamsDACBim {
  fixed_mxn_bim: number;
  mxn_per_kwh: number;
}

interface TariffParamsGDMTBim {
  fixed_mxn_bim: number;
  mxn_per_kwh: number;
  mxn_per_kw_demand_month: number; // se multiplica por 2 para bimestre
  assumed_load_factor: number;
}

interface TariffParamsGDMTHBim {
  fixed_mxn_bim: number;
  mxn_per_kw_demand_month: number;
  mxn_per_kwh_punta: number;
  mxn_per_kwh_intermedia: number;
  mxn_per_kwh_base: number;
  split_punta: number;
  split_intermedia: number;
  split_base: number;
  assumed_load_factor: number;
}

// PDBT desglosado (de tu recibo)
interface TariffParamsPDBTBim {
  suministro_mxn_bim: number;           // cargo fijo por bimestre
  distribucion_mxn_kwh: number;
  transmision_mxn_kwh: number;
  cenace_mxn_kwh: number;
  energia_mxn_kwh: number;
  capacidad_mxn_kwh: number;
  scnmem_mxn_kwh: number;
  iva: number;                           // 0.16
}

type TariffParams =
  | TariffParams01Bim
  | TariffParamsDACBim
  | TariffParamsGDMTBim
  | TariffParamsGDMTHBim
  | TariffParamsPDBTBim;

const DEFAULT_TARIFFS = {
  "01": {
    fixed_mxn_bim: 200,
    kwh_basic_block_bim: 150,
    kwh_intermediate_block_bim: 130,
    mxn_per_kwh_basic: 1.0,
    mxn_per_kwh_intermediate: 1.8,
    mxn_per_kwh_exceed: 3.5,
  } as TariffParams01Bim,

  DAC: {
    fixed_mxn_bim: 240,
    mxn_per_kwh: 6.2,
  } as TariffParamsDACBim,

  GDMT: {
    fixed_mxn_bim: 600,
    mxn_per_kwh: 3.3,
    mxn_per_kw_demand_month: 130,
    assumed_load_factor: 0.4,
  } as TariffParamsGDMTBim,

  GDMTH: {
    fixed_mxn_bim: 800,
    mxn_per_kw_demand_month: 150,
    mxn_per_kwh_punta: 6.0,
    mxn_per_kwh_intermedia: 3.5,
    mxn_per_kwh_base: 2.0,
    split_punta: 0.22,
    split_intermedia: 0.38,
    split_base: 0.40,
    assumed_load_factor: 0.4,
  } as TariffParamsGDMTHBim,

  // PDBT — valores iniciales tomados de tus recibos de ejemplo
  PDBT: {
    suministro_mxn_bim: 74.48 * 2 / 2, // si tu recibo muestra ~74.48 mensual, en bimestre es ~74.48 (ajústalo si difiere)
    distribucion_mxn_kwh: 0.63477,
    transmision_mxn_kwh: 0.08231,
    cenace_mxn_kwh: 0.0296,
    energia_mxn_kwh: 0.85813,
    capacidad_mxn_kwh: 0.52917,
    scnmem_mxn_kwh: 0.0282,
    iva: 0.16,
  } as TariffParamsPDBTBim,
} as const;

// ----------------------------
// Facturación (Bimestral)
// ----------------------------

function billCFEBim(
  tariff: Tariff,
  kwhBim: number,
  params: TariffParams
): number {
  switch (tariff) {
    case "01": {
      const p = params as TariffParams01Bim;
      const b1 = Math.max(Math.min(kwhBim, p.kwh_basic_block_bim), 0);
      const rem = Math.max(kwhBim - b1, 0);
      const b2 = Math.max(Math.min(rem, p.kwh_intermediate_block_bim), 0);
      const b3 = Math.max(rem - p.kwh_intermediate_block_bim, 0);
      const energy =
        b1 * p.mxn_per_kwh_basic +
        b2 * p.mxn_per_kwh_intermediate +
        b3 * p.mxn_per_kwh_exceed;
      return round2(energy + (p.fixed_mxn_bim || 0));
    }

    case "DAC": {
      const p = params as TariffParamsDACBim;
      const energy = p.mxn_per_kwh * kwhBim;
      return round2(energy + (p.fixed_mxn_bim || 0));
    }

    case "GDMT": {
      const p = params as TariffParamsGDMTBim;
      const energy = p.mxn_per_kwh * kwhBim;
      const demandKW_month = estimateDemandKWFromBim(kwhBim, p.assumed_load_factor);
      const demandBim = p.mxn_per_kw_demand_month * demandKW_month * 2;
      return round2(energy + demandBim + (p.fixed_mxn_bim || 0));
    }

    case "GDMTH": {
      const p = params as TariffParamsGDMTHBim;
      const kwhP = kwhBim * p.split_punta;
      const kwhI = kwhBim * p.split_intermedia;
      const kwhB = kwhBim * p.split_base;
      const energy = p.mxn_per_kwh_punta * kwhP +
                     p.mxn_per_kwh_intermedia * kwhI +
                     p.mxn_per_kwh_base * kwhB;
      const demandKW_month = estimateDemandKWFromBim(kwhBim, p.assumed_load_factor);
      const demandBim = p.mxn_per_kw_demand_month * demandKW_month * 2;
      return round2(energy + demandBim + (p.fixed_mxn_bim || 0));
    }

    case "PDBT": {
      const p = params as TariffParamsPDBTBim;
      // Subtotal sin IVA: suministro fijo + suma de componentes por kWh
      const unitSum =
        p.distribucion_mxn_kwh +
        p.transmision_mxn_kwh +
        p.cenace_mxn_kwh +
        p.energia_mxn_kwh +
        p.capacidad_mxn_kwh +
        p.scnmem_mxn_kwh;

      const subtotal = (p.suministro_mxn_bim || 0) + unitSum * kwhBim;
      const total = subtotal * (1 + (p.iva || 0));
      return round2(total);
    }
  }
}

function billsByBim(consumptionBim: BMap, tariff: Tariff, params: TariffParams): BMap {
  const out: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  (Object.keys(out) as BKey[]).forEach((b) => {
    out[b] = billCFEBim(tariff, consumptionBim[b] || 0, params);
  });
  return out;
}

// Neteo simplificado por bimestre con opción a créditos acumulables
function applyNetMeteringBim(
  consumptionBim: BMap,
  generationBim: BMap,
  netMetering: boolean,
  carryover: boolean
): { net: BMap; creditsTrace: BMap } {
  const net: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  const creditsTrace: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  let credit = 0;
  (Object.keys(net) as BKey[]).forEach((b) => {
    const cons = consumptionBim[b] || 0;
    const gen = generationBim[b] || 0;
    if (!netMetering) {
      net[b] = Math.max(cons - gen, 0);
      creditsTrace[b] = 0;
      return;
    }
    const available = cons - gen - (carryover ? credit : 0);
    if (available >= 0) {
      net[b] = available;
      credit = 0;
    } else {
      net[b] = 0;
      credit = Math.abs(available);
    }
    creditsTrace[b] = round2(credit);
  });
  return { net, creditsTrace };
}

function billsWithSolarBim(
  consumptionBim: BMap,
  generationBim: BMap,
  tariff: Tariff,
  params: TariffParams,
  netMetering: boolean,
  carryover: boolean
) {
  const { net, creditsTrace } = applyNetMeteringBim(consumptionBim, generationBim, netMetering, carryover);
  const bills: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  (Object.keys(bills) as BKey[]).forEach((b) => {
    bills[b] = billCFEBim(tariff, net[b], params);
  });
  return { bills, creditsTrace };
}

// ROI simple
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
  billsNowBim: BMap,
  billsSolarBim: BMap,
  discount: number,
  inflation: number,
  omRate: number,
  years: number,
  degradation = 0.005
) {
  const annualNow = sumBMap(billsNowBim);
  const annualSolarY1 = sumBMap(billsSolarBim);
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
  const npvVal = rows.reduce((a, r) => a + r.pv, 0);
  const irrVal = irr(rows.map((r) => r.cf));
  return { rows, payback, npv: npvVal, irr: irrVal };
}

// ----------------------------
// UI
// ----------------------------

type Row = Record<string, string | number>;

function downloadCSV(filename: string, tables: Record<string, Row[]>) {
  const parts: string[] = [];
  for (const [name, rows] of Object.entries(tables)) {
    parts.push(`# ${name}`);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    parts.push(cols.join(","));
    for (const r of rows) parts.push(cols.map((c) => String(r[c] ?? "")).join(","));
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

export default function Page() {
  // Consumo bimestral (kWh)
  const [cons, setCons] = useState<BMap>({
    B1: 900, B2: 980, B3: 1100, B4: 1200, B5: 1000, B6: 950,
  });

  // Producción (GDL)
  const [psh, setPsh] = useState(5.5);
  const [pr, setPr] = useState(0.8);
  const [availability, setAvailability] = useState(0.99);
  const [extraLoss, setExtraLoss] = useState(0);

  // Sistema
  const [panelW, setPanelW] = useState(550);
  const [costPerKW, setCostPerKW] = useState(23000);
  const [targetCoverage, setTargetCoverage] = useState(0.95);

  // Finanzas
  const [discount, setDiscount] = useState(0.10);
  const [inflation, setInflation] = useState(0.05);
  const [years, setYears] = useState(25);
  const [degradation, setDegradation] = useState(0.005);
  const [omPct, setOmPct] = useState(0.01);

  // Tarifas
  const [tariff, setTariff] = useState<Tariff>("PDBT");
  const [t01, setT01] = useState(DEFAULT_TARIFFS["01"]);
  const [tDAC, setTDAC] = useState(DEFAULT_TARIFFS.DAC);
  const [tGDMT, setTGDMT] = useState(DEFAULT_TARIFFS.GDMT);
  const [tGDMTH, setTGDMTH] = useState(DEFAULT_TARIFFS.GDMTH);
  const [tPDBT, setTPDBT] = useState(DEFAULT_TARIFFS.PDBT);

  const params: TariffParams =
    tariff === "01" ? t01 :
    tariff === "DAC" ? tDAC :
    tariff === "GDMT" ? tGDMT :
    tariff === "GDMTH" ? tGDMTH : tPDBT;

  // Dimensionamiento
  const annualKWhPerKW = useMemo(
    () => annualPerKwGeneration(psh, pr, availability, extraLoss),
    [psh, pr, availability, extraLoss]
  );

  const annualLoad = useMemo(() => sumBMap(cons), [cons]);

  const neededKW = useMemo(
    () => (annualLoad * targetCoverage) / annualKWhPerKW,
    [annualLoad, targetCoverage, annualKWhPerKW]
  );

  const panels = useMemo(
    () => Math.ceil((neededKW * 1000) / panelW),
    [neededKW, panelW]
  );

  const systemKW = useMemo(
    () => round2((panels * panelW) / 1000),
    [panels, panelW]
  );

  const genBim = useMemo(
    () => bimestralGeneration(systemKW, annualKWhPerKW),
    [systemKW, annualKWhPerKW]
  );

  // Recibos
  const billsNowBim = useMemo(
    () => billsByBim(cons, tariff, params),
    [cons, tariff, params]
  );

  const { bills: billsSolarBim, creditsTrace } = useMemo(
    () => billsWithSolarBim(cons, genBim, tariff, params, true, true),
    [cons, genBim, tariff, params]
  );

  // Ahorros por bimestre
  const savingsBimMXN = useMemo(() => {
    const out: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
    (Object.keys(out) as BKey[]).forEach((b) => {
      out[b] = round2(Math.max((billsNowBim[b] || 0) - (billsSolarBim[b] || 0), 0));
    });
    return out;
  }, [billsNowBim, billsSolarBim]);

  const savingsBimPct = useMemo(() => {
    const out: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
    (Object.keys(out) as BKey[]).forEach((b) => {
      const base = billsNowBim[b] || 0;
      const sav  = savingsBimMXN[b] || 0;
      out[b] = base > 0 ? round2((sav / base) * 100) : 0;
    });
    return out;
  }, [billsNowBim, savingsBimMXN]);

  const capex = useMemo(() => systemKW * costPerKW, [systemKW, costPerKW]);

  const roi = useMemo(
    () => roiCashflows(capex, billsNowBim, billsSolarBim, discount, inflation, omPct, years, degradation),
    [capex, billsNowBim, billsSolarBim, discount, inflation, omPct, years, degradation]
  );

  const summary = useMemo(() => ([
    { Indicador: "CAPEX (MXN)", Valor: fmt(capex, 0) },
    { Indicador: "Consumo anual (kWh)", Valor: fmt(annualLoad, 0) },
    { Indicador: "Generación anual esperada (kWh)", Valor: fmt(sumBMap(genBim), 0) },
    { Indicador: "Factura anual actual (MXN)", Valor: fmt(sumBMap(billsNowBim), 0) },
    { Indicador: "Factura anual con PV (MXN)", Valor: fmt(sumBMap(billsSolarBim), 0) },
    { Indicador: "Ahorro anual año 1 (MXN)", Valor: fmt(sumBMap(savingsBimMXN), 0) },
    { Indicador: "Payback (años)", Valor: roi.payback ?? "N/D" },
    { Indicador: `NPV (MXN, ${years} años)`, Valor: fmt(roi.npv, 0) },
    { Indicador: "IRR (anual)", Valor: isFinite(roi.irr) ? `${fmt(roi.irr * 100, 1)}%` : "N/D" },
  ]), [capex, annualLoad, genBim, billsNowBim, billsSolarBim, savingsBimMXN, roi, years]);

  function updateBim(b: BKey, val: string) {
    const v = Number(val.replace(",", ".")) || 0;
    setCons((c) => ({ ...c, [b]: v }));
  }

  function exportCSV() {
    const bimKeys = Object.keys(BIM_LABELS) as BKey[];
    const genRows = bimKeys.map((b) => ({ Bimestre: BIM_LABELS[b], Generacion_kWh: genBim[b] }));
    const billNowRows = bimKeys.map((b) => ({ Bimestre: BIM_LABELS[b], Consumo_kWh: cons[b], Factura_actual_MXN: billsNowBim[b] }));
    const billSolarRows = bimKeys.map((b) => ({ Bimestre: BIM_LABELS[b], Consumo_neto_kWh: Math.max(cons[b] - genBim[b], 0), Factura_con_PV_MXN: billsSolarBim[b], Creditos_kWh: creditsTrace[b] }));
    const savingsRows = bimKeys.map((b) => ({
      Bimestre: BIM_LABELS[b],
      Ahorro_MXN: savingsBimMXN[b],
      Ahorro_pct: savingsBimPct[b],
    }));
    const summaryRows = summary.map((r) => ({ Indicador: r.Indicador, Valor: r.Valor }));
    downloadCSV("cotizador_bimestral_gdl.csv", {
      "Generacion_Bim": genRows,
      "Factura_actual_Bim": billNowRows,
      "Factura_con_PV_Bim": billSolarRows,
      "Ahorros_Bim": savingsRows,
      "Resumen": summaryRows,
      "Flujos": roi.rows.map((r) => ({ Anio: r.year, Flujo: round2(r.cf), Flujo_descontado: round2(r.pv), Acumulado: round2(r.cum) })),
    });
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="px-6 py-5 border-b bg-white sticky top-0 z-10">
        <h1 className="text-2xl font-semibold">Cotizador FV — Guadalajara, Jalisco</h1>
        <p className="text-sm text-neutral-600">
          Bimestral, tarifas 01/DAC/GDMT/GDMTH/PDBT. Neteo y ROI simplificados. Ajusta parámetros a tu recibo.
        </p>
      </header>

      <main className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Inputs */}
        <section className="xl:col-span-1 space-y-6">
          <Card title="Consumo bimestral (kWh)">
            <div className="grid grid-cols-2 gap-3">
              {(Object.keys(BIM_LABELS) as BKey[]).map((b) => (
                <div key={b} className="flex flex-col">
                  <label className="text-xs text-neutral-600 mb-1">{BIM_LABELS[b]}</label>
                  <input
                    className="px-3 py-2 rounded-xl border bg-white"
                    type="number"
                    min={0}
                    value={cons[b]}
                    onChange={(e) => updateBim(b, e.target.value)}
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
              <Num label="Cobertura objetivo (0–1)" value={targetCoverage} setValue={setTargetCoverage} step={0.01} />
              <Num label="O&M (% capex/año)" value={omPct} setValue={setOmPct} step={0.005} />
            </div>
          </Card>

          <Card title="Finanzas">
  <div className="grid grid-cols-2 gap-3">
    <NumField
      label="Tasa de descuento"
      value={discount}
      setValue={setDiscount}
      step={0.01}
      help="Tasa nominal anual (WACC/costo de oportunidad) para traer los flujos a valor presente: Flujo descontado = Flujo / (1+r)^n."
    />
    <NumField
      label="Inflación energética"
      value={inflation}
      setValue={setInflation}
      step={0.01}
      help="Crecimiento anual esperado de tarifas eléctricas; hace que el ahorro en MXN aumente cada año."
    />
    <NumField
      label="Años de análisis"
      value={years}
      setValue={setYears}
      step={1}
      help="Horizonte de proyección para NPV/IRR (vida útil considerada)."
    />
    <NumField
      label="Degradación anual"
      value={degradation}
      setValue={setDegradation}
      step={0.001}
      help="Pérdida anual de capacidad del arreglo: kWhₙ = kWh₁ × (1 − d)^(n−1)."
    />
  </div>
</Card>

          <Card title="Tarifa CFE">
            <div className="space-y-3">
              <div className="flex gap-3 flex-wrap items-center">
                {(["01","DAC","GDMT","GDMTH","PDBT"] as Tariff[]).map((t) => (
                  <button key={t} onClick={() => setTariff(t)} className={`px-3 py-1 rounded-full border ${tariff === t ? "bg-black text-white" : "bg-white"}`}>
                    {t}
                  </button>
                ))}
              </div>

              {tariff === "01" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cargo fijo BIM (MXN)" value={t01.fixed_mxn_bim} setValue={(v)=>setT01({...t01, fixed_mxn_bim:v})} step={10} />
                  <Num label="Bloque Básico (kWh/BIM)" value={t01.kwh_basic_block_bim} setValue={(v)=>setT01({...t01, kwh_basic_block_bim:v})} step={10} />
                  <Num label="Bloque Intermedio (kWh/BIM)" value={t01.kwh_intermediate_block_bim} setValue={(v)=>setT01({...t01, kwh_intermediate_block_bim:v})} step={10} />
                  <Num label="Tarifa Básico ($/kWh)" value={t01.mxn_per_kwh_basic} setValue={(v)=>setT01({...t01, mxn_per_kwh_basic:v})} step={0.05} />
                  <Num label="Tarifa Intermedio ($/kWh)" value={t01.mxn_per_kwh_intermediate} setValue={(v)=>setT01({...t01, mxn_per_kwh_intermediate:v})} step={0.05} />
                  <Num label="Tarifa Excedente ($/kWh)" value={t01.mxn_per_kwh_exceed} setValue={(v)=>setT01({...t01, mxn_per_kwh_exceed:v})} step={0.05} />
                </div>
              )}

              {tariff === "DAC" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cargo fijo BIM (MXN)" value={tDAC.fixed_mxn_bim} setValue={(v)=>setTDAC({...tDAC, fixed_mxn_bim:v})} step={10} />
                  <Num label="MXN/kWh" value={tDAC.mxn_per_kwh} setValue={(v)=>setTDAC({...tDAC, mxn_per_kwh:v})} step={0.1} />
                </div>
              )}

              {tariff === "GDMT" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cargo fijo BIM (MXN)" value={tGDMT.fixed_mxn_bim} setValue={(v)=>setTGDMT({...tGDMT, fixed_mxn_bim:v})} step={10} />
                  <Num label="MXN/kWh" value={tGDMT.mxn_per_kwh} setValue={(v)=>setTGDMT({...tGDMT, mxn_per_kwh:v})} step={0.1} />
                  <Num label="MXN/kW-mes (demanda)" value={tGDMT.mxn_per_kw_demand_month} setValue={(v)=>setTGDMT({...tGDMT, mxn_per_kw_demand_month:v})} step={5} />
                  <Num label="Load factor" value={tGDMT.assumed_load_factor} setValue={(v)=>setTGDMT({...tGDMT, assumed_load_factor:v})} step={0.05} />
                </div>
              )}

              {tariff === "GDMTH" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cargo fijo BIM (MXN)" value={tGDMTH.fixed_mxn_bim} setValue={(v)=>setTGDMTH({...tGDMTH, fixed_mxn_bim:v})} step={10} />
                  <Num label="MXN/kW-mes (demanda)" value={tGDMTH.mxn_per_kw_demand_month} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kw_demand_month:v})} step={5} />
                  <Num label="MXN/kWh punta" value={tGDMTH.mxn_per_kwh_punta} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_punta:v})} step={0.1} />
                  <Num label="MXN/kWh intermedia" value={tGDMTH.mxn_per_kwh_intermedia} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_intermedia:v})} step={0.1} />
                  <Num label="MXN/kWh base" value={tGDMTH.mxn_per_kwh_base} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_base:v})} step={0.1} />
                  <Num label="Split punta" value={tGDMTH.split_punta} setValue={(v)=>setTGDMTH({...tGDMTH, split_punta:v})} step={0.01} />
                  <Num label="Split intermedia" value={tGDMTH.split_intermedia} setValue={(v)=>setTGDMTH({...tGDMTH, split_intermedia:v})} step={0.01} />
                  <Num label="Split base" value={tGDMTH.split_base} setValue={(v)=>setTGDMTH({...tGDMTH, split_base:v})} step={0.01} />
                  <Num label="Load factor" value={tGDMTH.assumed_load_factor} setValue={(v)=>setTGDMTH({...tGDMTH, assumed_load_factor:v})} step={0.05} />
                </div>
              )}

              {tariff === "PDBT" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Suministro (MXN/BIM)" value={tPDBT.suministro_mxn_bim} setValue={(v)=>setTPDBT({...tPDBT, suministro_mxn_bim:v})} step={1} />
                  <Num label="Distribución ($/kWh)" value={tPDBT.distribucion_mxn_kwh} setValue={(v)=>setTPDBT({...tPDBT, distribucion_mxn_kwh:v})} step={0.01} />
                  <Num label="Transmisión ($/kWh)" value={tPDBT.transmision_mxn_kwh} setValue={(v)=>setTPDBT({...tPDBT, transmision_mxn_kwh:v})} step={0.01} />
                  <Num label="CENACE ($/kWh)" value={tPDBT.cenace_mxn_kwh} setValue={(v)=>setTPDBT({...tPDBT, cenace_mxn_kwh:v})} step={0.01} />
                  <Num label="Energía ($/kWh)" value={tPDBT.energia_mxn_kwh} setValue={(v)=>setTPDBT({...tPDBT, energia_mxn_kwh:v})} step={0.01} />
                  <Num label="Capacidad ($/kWh)" value={tPDBT.capacidad_mxn_kwh} setValue={(v)=>setTPDBT({...tPDBT, capacidad_mxn_kwh:v})} step={0.01} />
                  <Num label="SCnMEM ($/kWh)" value={tPDBT.scnmem_mxn_kwh} setValue={(v)=>setTPDBT({...tPDBT, scnmem_mxn_kwh:v})} step={0.01} />
                  <Num label="IVA" value={tPDBT.iva} setValue={(v)=>setTPDBT({...tPDBT, iva:v})} step={0.01} />
                </div>
              )}
            </div>
          </Card>

          <div className="flex gap-3">
            <button onClick={exportCSV} className="px-4 py-2 rounded-xl bg-black text-white">
              Descargar CSV
            </button>
          </div>
        </section>

        {/* Outputs */}
        <section className="xl:col-span-2 space-y-6">
          <Card title="Dimensionamiento del sistema">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <KV k="Paneles" v={String(panels)} />
              <KV k="Tamaño (kWdc)" v={fmt(systemKW, 2)} />
              <KV k="Generación anual esperada (kWh)" v={fmt(sumBMap(genBim), 0)} />
              <KV k="Consumo anual (kWh)" v={fmt(annualLoad, 0)} />
              <KV k="kWh/kW-año" v={fmt(annualKWhPerKW, 0)} />
              <KV k="CAPEX (MXN)" v={fmt(capex, 0)} />
            </div>
          </Card>

          <TwoCol>
            <Card title="Generación por bimestre (kWh)">
              <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
                Bimestre: BIM_LABELS[b], "Generación (kWh)": fmt(genBim[b], 2),
              }))} />
            </Card>
            <Card title="Factura bimestral actual (sin PV)">
              <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
                Bimestre: BIM_LABELS[b], "Consumo (kWh)": fmt(cons[b], 0), "Factura (MXN)": fmt(billsNowBim[b], 2),
              }))} />
            </Card>
          </TwoCol>

          <TwoCol>
            <Card title="Factura bimestral con PV (neteo)">
              <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
                Bimestre: BIM_LABELS[b],
                "Consumo neto (kWh)": fmt(Math.max(cons[b] - genBim[b], 0), 2),
                "Factura con PV (MXN)": fmt(billsSolarBim[b], 2),
                "Créditos (kWh)": fmt(creditsTrace[b], 2),
              }))} />
            </Card>
            <Card title="Ahorro por bimestre">
              <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
                Bimestre: BIM_LABELS[b],
                "Ahorro (MXN)": fmt(savingsBimMXN[b], 2),
                "% Ahorro": `${fmt(savingsBimPct[b], 1)}%`,
              }))} />
            </Card>
          </TwoCol>

          <Card title="Resumen financiero (ROI)">
            <Table rows={summary} />
            <div className="mt-4 overflow-auto">
              <Table rows={roi.rows.map((r) => ({
                "Año": r.year, "Flujo (MXN)": fmt(r.cf, 2), "Flujo descontado (MXN)": fmt(r.pv, 2), "Acumulado (MXN)": fmt(r.cum, 2),
              }))} />
            </div>
            <p className="text-xs text-neutral-500 mt-3">
              Nota: Modelo simplificado. Ajusta los parámetros a tu recibo real (bloques, unitarios y cargos).
            </p>
          </Card>
        </section>
      </main>
    </div>
  );
}

// ----------------------------
// Mini componentes UI
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

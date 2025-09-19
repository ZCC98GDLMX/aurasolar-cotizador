// app/cotizador/page.tsx
// Cotizador FV — Bimestral (GDL) con PDBT desglosado y % ahorro por bimestre

"use client";

import React, { useMemo, useState } from "react";

// usando ruta relativa (seguro)
import NumField from "../components/Num";
import { Help } from "../components/Help";

// === Persistencia local (localStorage) ===
function useLocalStorageState<T>(key: string, initial: T) {
  const [state, setState] = React.useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  React.useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch { /* noop */ }
  }, [key, state]);

  return [state, setState] as const;
}

// Si algún día cambias estructura, sube esta versión para invalidar lo viejo:
const LS_VERSION = "v2";
const lsKey = (name: string) => `AURA_SOLAR_${LS_VERSION}:${name}`;


// ========================
//  PDBT CALIBRADO (GDL)
// ========================
// ⚠️ Este bloque DEBE estar FUERA de objetos/funciones (nivel de archivo)
const PDBT_FIXED_BIMX_MXN = 90.04738842214351;   // cargo fijo bimestral (incluye IVA)
const PDBT_RATE_MXN_PER_KWH = 5.367731548519526; // $/kWh (incluye IVA)

function costPDBTCalibratedMXN(kWhBim: number) {
  return PDBT_FIXED_BIMX_MXN + PDBT_RATE_MXN_PER_KWH * kWhBim;
}

// ----------------------------
// Tipos & helpers
// ----------------------------

type Tariff = "01" | "DAC" | "GDMT" | "GDMTH" | "PDBT";

type BKey = "B1" | "B2" | "B3" | "B4" | "B5" | "B6";
type BMap = Record<BKey, number>;

type Month =
  | "Ene" | "Feb" | "Mar" | "Abr" | "May" | "Jun"
  | "Jul" | "Ago" | "Sep" | "Oct" | "Nov" | "Dic";


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
// ==== Helpers BOM (ANTAI) ====

// Optimizador: para una longitud requerida (mm), encuentra combo de rieles 4700/2400
// que cumpla >= L con MENOS piezas y MENOR excedente.
function pickRailsForLength(lengthMM: number) {
  const L = Math.max(0, Math.round(lengthMM));
  const R1 = 4700, R2 = 2400;
  let best = { n4700: 0, n2400: 0, waste: Infinity, pieces: Infinity, total: 0 };

  const max47 = Math.ceil(L / R1) + 2;
  const max24 = Math.ceil(L / R2) + 3;

  for (let a = 0; a <= max47; a++) {
    for (let b = 0; b <= max24; b++) {
      const total = a * R1 + b * R2;
      if (total < L) continue;
      const pieces = a + b;
      const waste = total - L;
      if (pieces < best.pieces || (pieces === best.pieces && waste < best.waste)) {
        best = { n4700: a, n2400: b, waste, pieces, total };
      }
    }
  }
  return best;
}

// Reglas ANTAI aproximadas y escalables a cualquier N
function bomAntaiForPanels(totalPanels: number, panelsPerRow: number) {
  const N = Math.max(0, Math.floor(totalPanels));
  const nPerRow = Math.max(1, Math.floor(panelsPerRow));
  const rows = Math.ceil(N / nPerRow);

  const midPerRow = (m: number) => Math.max(0, 2 * m - 2);
  const legsPerRow = (m: number) => (m <= 4 ? m : Math.max(0, m) + 1); // front = rear

  const endClamp = 4; // como en hoja ANTAI (estructura completa)
  let midClamp = 0;
  let frontLeg = 0;
  let rearLeg = 0;

  for (let r = 0; r < rows; r++) {
    const m = r === rows - 1 ? N - r * nPerRow : nPerRow;
    if (m <= 0) continue;
    midClamp += midPerRow(m);
    frontLeg += legsPerRow(m);
    rearLeg += legsPerRow(m);
  }

  const groundingLug = N <= 4 ? 1 : 2;
  const earthingClip = midClamp;
  const cableClip = N >= 6 ? N : 0;

  return { endClamp, midClamp, frontLeg, rearLeg, groundingLug, earthingClip, cableClip, rows };
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

// PDBT — parámetros desglosados (unitarios base)
interface TariffParamsPDBTBim {
  suministro_mxn_bim: number;           // cargo fijo por bimestre
  distribucion_mxn_kwh: number;
  transmision_mxn_kwh: number;
  cenace_mxn_kwh: number;
  energia_mxn_kwh: number;
  capacidad_mxn_kwh: number;
  scnmem_mxn_kwh: number;
  iva: number;                          // normalmente 0.16
}

// Valores iniciales tomados de tus recibos de ejemplo
const defaultPDBT: TariffParamsPDBTBim = {
  suministro_mxn_bim: 74.48,
  distribucion_mxn_kwh: 0.63477,
  transmision_mxn_kwh: 0.08231,
  cenace_mxn_kwh: 0.0296,
  energia_mxn_kwh: 0.85813,
  capacidad_mxn_kwh: 0.52917,
  scnmem_mxn_kwh: 0.0282,
  iva: 0.16,
};

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

  // ✅ PDBT desglosado por defecto (para edición en UI)
  PDBT: defaultPDBT as TariffParamsPDBTBim,
} as const;

// ----------------------------
// Facturación (Bimestral)
// ----------------------------

function billCFEBim(
  tariff: Tariff,
  kwhBim: number,
  params: TariffParams,
  usePdbtCal?: boolean
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
      if (usePdbtCal) {
        // MODO CALIBRADO: total con IVA (no volver a aplicar IVA en otro lado)
        return round2(costPDBTCalibratedMXN(kwhBim));
      }

      // MODO DESGLOSADO (unitarios base)
      const p = params as TariffParamsPDBTBim;
      const subtotal =
        p.suministro_mxn_bim +
        (
          p.distribucion_mxn_kwh +
          p.transmision_mxn_kwh +
          p.cenace_mxn_kwh +
          p.energia_mxn_kwh +
          p.capacidad_mxn_kwh +
          p.scnmem_mxn_kwh
        ) * kwhBim;

      return round2(subtotal * (1 + p.iva));
    }
  }
}

// Agrupar por bimestre
function billsByBim(consumptionBim: BMap, tariff: Tariff, params: TariffParams, usePdbtCal?: boolean): BMap {
  const out: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  (Object.keys(out) as BKey[]).forEach((b) => {
    out[b] = billCFEBim(tariff, consumptionBim[b] || 0, params, usePdbtCal);
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
  carryover: boolean,
  usePdbtCal?: boolean
) {
  const { net, creditsTrace } = applyNetMeteringBim(consumptionBim, generationBim, netMetering, carryover);
  const bills: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  (Object.keys(bills) as BKey[]).forEach((b) => {
    bills[b] = billCFEBim(tariff, net[b], params, usePdbtCal);
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
const [cons, setCons] = useLocalStorageState<BMap>(
  lsKey("cons"),
  { B1: 900, B2: 980, B3: 1100, B4: 1200, B5: 1000, B6: 950 }
);

// Producción (GDL)
const [psh, setPsh] = useLocalStorageState(lsKey("psh"), 5.5);
const [pr, setPr] = useLocalStorageState(lsKey("pr"), 0.8);
const [availability, setAvailability] = useLocalStorageState(lsKey("availability"), 0.99);
const [extraLoss, setExtraLoss] = useLocalStorageState(lsKey("extraLoss"), 0);

// Sistema
const [panelW, setPanelW] = useLocalStorageState(lsKey("panelW"), 550);
const [costPerKW, setCostPerKW] = useLocalStorageState(lsKey("costPerKW"), 23000);
const [targetCoverage, setTargetCoverage] = useLocalStorageState(lsKey("targetCoverage"), 0.95);

// Finanzas
const [discount, setDiscount] = useLocalStorageState(lsKey("discount"), 0.10);
const [inflation, setInflation] = useLocalStorageState(lsKey("inflation"), 0.05);
const [years, setYears] = useLocalStorageState(lsKey("years"), 25);
const [degradation, setDegradation] = useLocalStorageState(lsKey("degradation"), 0.005);
const [omPct, setOmPct] = useLocalStorageState(lsKey("omPct"), 0.01);

// Tarifas seleccionada y parámetros
const [tariff, setTariff] = useLocalStorageState<Tariff>(lsKey("tariff"), "PDBT");
const [t01, setT01] = useLocalStorageState(lsKey("t01"), DEFAULT_TARIFFS["01"]);
const [tDAC, setTDAC] = useLocalStorageState(lsKey("tDAC"), DEFAULT_TARIFFS.DAC);
const [tGDMT, setTGDMT] = useLocalStorageState(lsKey("tGDMT"), DEFAULT_TARIFFS.GDMT);
const [tGDMTH, setTGDMTH] = useLocalStorageState(lsKey("tGDMTH"), DEFAULT_TARIFFS.GDMTH);
const [tPDBT, setTPDBT] = useLocalStorageState(lsKey("tPDBT"), DEFAULT_TARIFFS.PDBT);

// Toggle calibrado PDBT
const [usePdbtCal, setUsePdbtCal] = useLocalStorageState(lsKey("usePdbtCal"), true);

// ===== BOM Estructura (ANTAI) — Entradas manuales =====
const [bomPanels, setBomPanels] = useState<number>(8);         // # paneles
const [bomWidthMM, setBomWidthMM] = useState<number>(1134);    // ancho panel (portrait)
const [bomHeightMM, setBomHeightMM] = useState<number>(1722);  // alto panel
const [bomOrientation, setBomOrientation] = useState<"portrait"|"landscape">("portrait");
const [bomGapMM, setBomGapMM] = useState<number>(20);          // separación entre paneles
const [bomPanelsPerRow, setBomPanelsPerRow] = useState<number>(8); // paneles por fila

function resetDefaults() {
  setCons({ B1: 900, B2: 980, B3: 1100, B4: 1200, B5: 1000, B6: 950 });
  setPsh(5.5);
  setPr(0.8);
  setAvailability(0.99);
  setExtraLoss(0);
  setPanelW(550);
  setCostPerKW(23000);
  setTargetCoverage(0.95);
  setDiscount(0.10);
  setInflation(0.05);
  setYears(25);
  setDegradation(0.005);
  setOmPct(0.01);
  setTariff("PDBT");
  setT01(DEFAULT_TARIFFS["01"]);
  setTDAC(DEFAULT_TARIFFS.DAC);
  setTGDMT(DEFAULT_TARIFFS.GDMT);
  setTGDMTH(DEFAULT_TARIFFS.GDMTH);
  setTPDBT(defaultPDBT);
  setUsePdbtCal(true);
  localStorage.clear(); // limpia el almacenamiento local también
}


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
  const params: TariffParams =
  tariff === "01"   ? t01  :
  tariff === "DAC"  ? tDAC :
  tariff === "GDMT" ? tGDMT :
  tariff === "GDMTH"? tGDMTH : tPDBT;


  // Recibos
  const billsNowBim = useMemo(
    () => billsByBim(cons, tariff, params, usePdbtCal),
    [cons, tariff, params, usePdbtCal]
  );

  const { bills: billsSolarBim, creditsTrace } = useMemo(
    () => billsWithSolarBim(cons, genBim, tariff, params, true, true, usePdbtCal),
    [cons, genBim, tariff, params, usePdbtCal]
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

// ===== Cálculos BOM =====
const bom = useMemo(() => {
  const dimAlong = bomOrientation === "portrait" ? bomWidthMM : bomHeightMM; // largo que suma en la fila
  const panelsPerRow = Math.max(1, Math.floor(bomPanelsPerRow));
  const totalPanels = Math.max(0, Math.floor(bomPanels));
  const rows = Math.ceil(totalPanels / panelsPerRow);

  // Rieles por fila: L = m*dimAlong + (m-1)*gap
  const railsInfo = {
    perRowPieces: [] as { n4700: number; n2400: number; splices: number }[],
    total4700: 0,
    total2400: 0,
    totalSplices: 0,
  };

  for (let r = 0; r < rows; r++) {
    const m = r === rows - 1 ? totalPanels - r * panelsPerRow : panelsPerRow;
    if (m <= 0) continue;
    const rowLen = m * dimAlong + Math.max(0, m - 1) * bomGapMM;

    // 2 rieles por fila
    for (let rail = 0; rail < 2; rail++) {
      const combo = pickRailsForLength(rowLen);
      railsInfo.total4700 += combo.n4700;
      railsInfo.total2400 += combo.n2400;
      railsInfo.totalSplices += Math.max(0, combo.n4700 + combo.n2400 - 1);
      railsInfo.perRowPieces.push({
        n4700: combo.n4700,
        n2400: combo.n2400,
        splices: Math.max(0, combo.n4700 + combo.n2400 - 1),
      });
    }
  }

  const parts = bomAntaiForPanels(totalPanels, panelsPerRow);

  return { ...railsInfo, ...parts };
}, [bomPanels, bomWidthMM, bomHeightMM, bomOrientation, bomGapMM, bomPanelsPerRow]);


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

          {/* Toggle + tooltip para PDBT */}
          {tariff === "PDBT" && (
  <div className="rounded-2xl border p-4 mt-3">
    <h4 className="mb-2 text-sm font-semibold">Opciones PDBT</h4>

    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={usePdbtCal}
        onChange={(e) => setUsePdbtCal(e.target.checked)}
      />
      <span className="font-medium">Usar modo calibrado PDBT</span>
      <span className="text-xs text-gray-500">(fijo + $/kWh ajustado a tus recibos)</span>
      <Help text={`Al activar este modo, se ignoran los unitarios de arriba y el costo PDBT se calcula como:
costo_bimestre = fijo + ($/kWh × kWh). Los valores están calibrados con tus recibos e incluyen IVA.

📌 Nota: Si NO activas este modo, cada concepto (Distribución, Transmisión, Energía, etc.) debe ingresarse como $/kWh.
Para obtenerlo desde tu recibo, divide el costo total de cada concepto entre los kWh facturados del bimestre.`} />
    </label>

    {usePdbtCal && (
      <p className="text-xs text-gray-500 mt-2">
        *Calibrado con recibos CFE (IVA incluido): fijo ≈ ${PDBT_FIXED_BIMX_MXN.toFixed(0)} + {PDBT_RATE_MXN_PER_KWH.toFixed(4)} $/kWh.
      </p>
    )}
  </div>
)}

<div className="flex gap-3 mt-3">
  <button onClick={exportCSV} className="px-4 py-2 rounded-xl bg-black text-white">
    Descargar CSV
  </button>
  <button
    onClick={resetDefaults}
    className="px-4 py-2 rounded-xl bg-gray-200 text-black"
  >
    Restablecer valores
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

{/* =========================
      BOM Estructura (ANTAI)
     ========================= */}
  <Card title="BOM Estructura (ANTAI Solar)">
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Num label="# Paneles" value={bomPanels} setValue={setBomPanels} step={1} />
      <Num label="Ancho panel (mm)" value={bomWidthMM} setValue={setBomWidthMM} step={10} />
      <Num label="Alto panel (mm)" value={bomHeightMM} setValue={setBomHeightMM} step={10} />
      <div className="flex flex-col">
        <label className="text-xs text-neutral-600 mb-1">Orientación</label>
        <select
          className="px-3 py-2 rounded-xl border bg-white"
          value={bomOrientation}
          onChange={(e)=>setBomOrientation(e.target.value as "portrait"|"landscape")}
        >
          <option value="portrait">Portrait (vertical)</option>
          <option value="landscape">Landscape (horizontal)</option>
        </select>
      </div>
      <Num label="Gap entre paneles (mm)" value={bomGapMM} setValue={setBomGapMM} step={5} />
      <Num label="Paneles por fila" value={bomPanelsPerRow} setValue={setBomPanelsPerRow} step={1} />
    </div>

    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <h4 className="font-medium mb-2">Resumen de rieles</h4>
        <Table rows={[
          { Componente: "Rail 4700mm", Cantidad: bom.total4700 },
          { Componente: "Rail 2400mm", Cantidad: bom.total2400 },
          { Componente: "Rail Splice (unión)", Cantidad: bom.totalSplices },
        ]} />
        <p className="text-xs text-neutral-500 mt-2">
          *Optimizado por fila (2 rieles/fila). Se elige la combinación 4700/2400 con menos piezas y menor excedente.
        </p>
      </div>

      <div>
        <h4 className="font-medium mb-2">Abrazaderas, patas y puesta a tierra</h4>
        <Table rows={[
          { Componente: "End Clamp", Cantidad: bom.endClamp },
          { Componente: "Mid Clamp", Cantidad: bom.midClamp },
          { Componente: "Adjustable front leg", Cantidad: bom.frontLeg },
          { Componente: "Adjustable rear leg", Cantidad: bom.rearLeg },
          { Componente: "Grounding Lug", Cantidad: bom.groundingLug },
          { Componente: "Earthing Clip", Cantidad: bom.earthingClip },
          { Componente: "Cable Clip", Cantidad: bom.cableClip },
        ]} />
        <p className="text-xs text-neutral-500 mt-2">
          Reglas ANTAI aproximadas: EndClamp=4; MidClamp=2·N−2; Front/RearLeg=N (≤4) o N+1 (≥6);
          GroundingLug=1 (N≤4) o 2; EarthingClip=MidClamp; CableClip=N (si N≥6).
        </p>
      </div>
    </div>

    <p className="text-xs text-neutral-500 mt-4">
      Nota: Este BOM es independiente del cotizador. Usa tus dimensiones y distribución por filas;
      puede diferir de la tabla ANTAI 4–12 si la geometría varía.
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
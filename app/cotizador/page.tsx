// app/cotizador/page.tsx — Cotizador FV (bimestral) Guadalajara, MX + PDBT
"use client";

import React, { useMemo, useState } from "react";

// ----------------------------
// Tipos & helpers
// ----------------------------

type Tariff = "01" | "DAC" | "GDMT" | "GDMTH" | "PDBT";
type BKey = `B${1|2|3|4|5|6}`;
type BMap = Record<BKey, number>;
type Row = Record<string, string | number>;

const BIM_LABELS: Record<BKey, string> = {
  B1: "B1 (Ene–Feb)",
  B2: "B2 (Mar–Abr)",
  B3: "B3 (May–Jun)",
  B4: "B4 (Jul–Ago)",
  B5: "B5 (Sep–Oct)",
  B6: "B6 (Nov–Dic)",
};

const MONTHS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"] as const;
type Month = typeof MONTHS[number];

const MONTH_INDEX: Record<Month, number> = {
  Ene: 0, Feb: 1, Mar: 2, Abr: 3, May: 4, Jun: 5,
  Jul: 6, Ago: 7, Sep: 8, Oct: 9, Nov: 10, Dic: 11,
};


const BIM_GROUPS: readonly (readonly [Month, Month])[] = [
  ["Ene","Feb"], ["Mar","Abr"], ["May","Jun"],
  ["Jul","Ago"], ["Sep","Oct"], ["Nov","Dic"],
] as const;


function fmt(n: number, digits = 2) {
  if (!isFinite(n)) return "N/D";
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: digits }).format(n);
}
function round2(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Potencial anual por kW (kWh/kW-año)
function annualPerKwGeneration(psh: number, pr: number, availability: number, extraLosses: number) {
  const base = psh * 365;
  const losses = pr * availability * (1 - extraLosses);
  return base * losses;
}

// Forma mensual para repartir producción en el año (después la sumamos a bimestres)
function monthlyShape(amplitude = 0.10) {
  // Pico ~Junio (GDL), suma=12
  const m = Array.from({ length: 12 }, (_, i) => i);
  const phaseShift = 5;
  let raw = m.map((i) => 1 + amplitude * Math.cos((2 * Math.PI * (i - phaseShift)) / 12));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  raw = raw.map((x) => x / mean);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => (x * 12) / sum);
}

// ----------------------------
// Tarifas (parámetros por BIMESTRE)
// ----------------------------

// 01 con bloques bimestrales + cargo fijo bimestral
interface TariffParams01Bim {
  fixed_mxn_bim: number;              // cargo fijo por bimestre
  kwh_basic_limit_bim: number;        // kWh/bimestre bloque Básico
  kwh_intermediate_limit_bim: number; // kWh/bimestre acumulado Básico+Intermedio
  mxn_per_kwh_basic: number;
  mxn_per_kwh_intermediate: number;
  mxn_per_kwh_exceed: number;
}

// DAC simple bimestral
interface TariffParamsDACBim { mxn_per_kwh: number; fixed_mxn_bim: number; }

// GDMT (energía bimestral + demanda mensual *2 + cargo fijo bimestral)
interface TariffParamsGDMTBim {
  mxn_per_kwh: number;
  fixed_mxn_bim: number;
  mxn_per_kw_demand_month: number;  // $/kW al MES (se multiplica por 2)
  assumed_load_factor: number;      // para estimar kW con kWh_bim y 60 días
}

// GDMTH (punta/intermedia/base bimestral) + demanda mensual *2 + cargo fijo bimestral
interface TariffParamsGDMTHBim {
  mxn_per_kwh_punta: number;
  mxn_per_kwh_intermedia: number;
  mxn_per_kwh_base: number;
  fixed_mxn_bim: number;
  mxn_per_kw_demand_month: number;
  split_punta: number; split_intermedia: number; split_base: number; // suma=1
  assumed_load_factor: number;
}

// PDBT (energía bimestral + demanda mensual *2 + cargo fijo bimestral)
interface TariffParamsPDBTBim {
  mxn_per_kwh: number;
  fixed_mxn_bim: number;
  mxn_per_kw_demand_month: number;
  assumed_load_factor: number;
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
    kwh_basic_limit_bim: 150,         // ~75 kWh/mes *2
    kwh_intermediate_limit_bim: 280,  // ~140 kWh/mes *2
    mxn_per_kwh_basic: 1.0,
    mxn_per_kwh_intermediate: 1.8,
    mxn_per_kwh_exceed: 3.5,
  } as TariffParams01Bim,

  DAC: {
    mxn_per_kwh: 6.2,
    fixed_mxn_bim: 240,
  } as TariffParamsDACBim,

  GDMT: {
    mxn_per_kwh: 3.3,
    fixed_mxn_bim: 600,
    mxn_per_kw_demand_month: 130,
    assumed_load_factor: 0.4,
  } as TariffParamsGDMTBim,

  GDMTH: {
    mxn_per_kwh_punta: 6.0,
    mxn_per_kwh_intermedia: 3.5,
    mxn_per_kwh_base: 2.0,
    fixed_mxn_bim: 800,
    mxn_per_kw_demand_month: 150,
    split_punta: 0.22,
    split_intermedia: 0.38,
    split_base: 0.40,
    assumed_load_factor: 0.4,
  } as TariffParamsGDMTHBim,

  PDBT: {
    mxn_per_kwh: 3.8,
    fixed_mxn_bim: 640,
    mxn_per_kw_demand_month: 140,
    assumed_load_factor: 0.45,
  } as TariffParamsPDBTBim,
};

// ----------------------------
// Cálculos base bimestrales
// ----------------------------

// Estimar demanda (kW) desde kWh bimestrales, usando 60 días por bimestre
function estimateDemandKWFromBim(kwhBim: number, loadFactor = 0.4, days = 60) {
  const kwAvg = kwhBim / (days * 24);
  return kwAvg / Math.max(loadFactor, 1e-6);
}

// Generación por bimestre a partir de forma mensual
function bimestralGeneration(systemKW: number, annualKWhPerKW: number): BMap {
  const monthly = monthlyShape().map((s) => (systemKW * annualKWhPerKW) * (s / 12));
  const bims: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };

  BIM_GROUPS.forEach((pair, i) => {
    const idxA = MONTH_INDEX[pair[0]];
    const idxB = MONTH_INDEX[pair[1]];
    const sum = (monthly[idxA] || 0) + (monthly[idxB] || 0);
    bims[`B${i+1}` as BKey] = round2(sum);
  });

  return bims;
}



// Recibo bimestral por tarifa (sin PV)
function billCFEBim(tariff: Tariff, kwhBim: number, params: TariffParams): number {
  switch (tariff) {
    case "01": {
      const p = params as TariffParams01Bim;
      const b1 = Math.max(Math.min(kwhBim, p.kwh_basic_limit_bim), 0);
      const b2 = Math.max(Math.min(kwhBim, p.kwh_intermediate_limit_bim) - p.kwh_basic_limit_bim, 0);
      const b3 = Math.max(kwhBim - p.kwh_intermediate_limit_bim, 0);
      const energy = b1*p.mxn_per_kwh_basic + b2*p.mxn_per_kwh_intermediate + b3*p.mxn_per_kwh_exceed;
      return round2(energy + (p.fixed_mxn_bim || 0));
    }
    case "DAC": {
      const p = params as TariffParamsDACBim;
      return round2(p.mxn_per_kwh * kwhBim + (p.fixed_mxn_bim || 0));
    }
    case "GDMT": {
      const p = params as TariffParamsGDMTBim;
      const energy = p.mxn_per_kwh * kwhBim;
      const demandKW_month = estimateDemandKWFromBim(kwhBim, p.assumed_load_factor); // kW (estimación mensual)
      const demandChargeBim = p.mxn_per_kw_demand_month * demandKW_month * 2;       // 2 meses
      return round2(energy + demandChargeBim + (p.fixed_mxn_bim || 0));
    }
    case "GDMTH": {
      const p = params as TariffParamsGDMTHBim;
      const kwhP = kwhBim * p.split_punta, kwhI = kwhBim * p.split_intermedia, kwhB = kwhBim * p.split_base;
      const energy = p.mxn_per_kwh_punta*kwhP + p.mxn_per_kwh_intermedia*kwhI + p.mxn_per_kwh_base*kwhB;
      const demandKW_month = estimateDemandKWFromBim(kwhBim, p.assumed_load_factor);
      const demandChargeBim = p.mxn_per_kw_demand_month * demandKW_month * 2;
      return round2(energy + demandChargeBim + (p.fixed_mxn_bim || 0));
    }
    case "PDBT": {
      const p = params as TariffParamsPDBTBim;
      const energy = p.mxn_per_kwh * kwhBim;
      const demandKW_month = estimateDemandKWFromBim(kwhBim, p.assumed_load_factor);
      const demandChargeBim = p.mxn_per_kw_demand_month * demandKW_month * 2;
      return round2(energy + demandChargeBim + (p.fixed_mxn_bim || 0));
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

// Neteo por bimestre (con créditos que se arrastran de un bimestre a otro)
function applyNetMeteringBim(consumptionBim: BMap, generationBim: BMap, netMetering: boolean, carryover: boolean) {
  const net: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  const creditsTrace: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
  let wallet = 0; // kWh
  (Object.keys(net) as BKey[]).forEach((b) => {
    const cons = consumptionBim[b] || 0;
    const gen = generationBim[b] || 0;
    if (!netMetering) {
      net[b] = round2(cons);
      creditsTrace[b] = carryover ? wallet : 0;
      return;
    }
    let withinNet = cons - gen;
    if (carryover) {
      if (withinNet > 0) {
        const use = Math.min(wallet, withinNet);
        withinNet -= use; wallet -= use;
      } else {
        wallet += Math.abs(withinNet);
        withinNet = 0;
      }
    } else {
      withinNet = Math.max(withinNet, 0);
    }
    net[b] = round2(withinNet);
    creditsTrace[b] = round2(wallet);
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
    const kwh = net[b];
    // GDMT/GDMTH/PDBT: demanda se calcula con kWh del bimestre
    bills[b] = billCFEBim(tariff, kwh, params);
  });
  return { bills, creditsTrace };
}

function sumBMap(map: BMap) {
  return (Object.keys(map) as BKey[]).reduce((acc, b) => acc + (map[b] || 0), 0);
}

// ----------------------------
// ROI / Finanzas (usa totales anuales a partir de bimestres)
// ----------------------------

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
  billsSolarY1Bim: BMap,
  discount: number,
  inflation: number,
  omRate: number,
  years: number,
  degradation = 0.005
) {
  const annualNow = sumBMap(billsNowBim);
  const annualSolarY1 = sumBMap(billsSolarY1Bim);
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
// Componente principal (BIMESTRAL)
// ----------------------------

export default function Page() {
  // Entradas bimestrales (kWh por bimestre)
  const [consBim, setConsBim] = useState<BMap>({
    B1: 870, B2: 1000, B3: 1250, B4: 1380, B5: 1080, B6: 940,
  });

  // Producción (parámetros de sitio)
  const [psh, setPsh] = useState(5.5);
  const [pr, setPr] = useState(0.8);
  const [availability, setAvailability] = useState(0.99);
  const [extraLoss, setExtraLoss] = useState(0.0);

  // Equipo & costos
  const [panelW, setPanelW] = useState(550);
  const [costPerKW, setCostPerKW] = useState(23000);
  const [omPct, setOmPct] = useState(0.01);

  // Finanzas
  const [discount, setDiscount] = useState(0.10);
  const [inflation, setInflation] = useState(0.05);
  const [years, setYears] = useState(25);
  const [degradation, setDegradation] = useState(0.005);

  // Tarifas (bimestrales)
  const [tariff, setTariff] = useState<Tariff>("01");
  const [t01, setT01] = useState(DEFAULT_TARIFFS["01"]);
  const [tDAC, setTDAC] = useState(DEFAULT_TARIFFS.DAC);
  const [tGDMT, setTGDMT] = useState(DEFAULT_TARIFFS.GDMT);
  const [tGDMTH, setTGDMTH] = useState(DEFAULT_TARIFFS.GDMTH);
  const [tPDBT, setTPDBT] = useState(DEFAULT_TARIFFS.PDBT);

  // Neteo
  const [targetCoverage, setTargetCoverage] = useState(0.95);
  const [netMetering, setNetMetering] = useState(true);
  const [carryover, setCarryover] = useState(true);

  // Selección de parámetros según tarifa
  const params: TariffParams =
    tariff === "01" ? t01 :
    tariff === "DAC" ? tDAC :
    tariff === "GDMT" ? tGDMT :
    tariff === "GDMTH" ? tGDMTH : tPDBT;

  // Cálculos principales
  const annualKWhPerKW = useMemo(
    () => annualPerKwGeneration(psh, pr, availability, extraLoss),
    [psh, pr, availability, extraLoss]
  );

  // Dimensionamiento (usa carga anual desde bimestres)
  const annualLoad = useMemo(() => sumBMap(consBim), [consBim]);
  const { panels, systemKW, expectedAnnual } = useMemo(() => {
    const neededKW = (annualLoad * targetCoverage) / annualKWhPerKW;
    const panels = Math.ceil((neededKW * 1000) / panelW);
    const systemKW = (panels * panelW) / 1000;
    const expectedAnnual = systemKW * annualKWhPerKW;
    return { panels, systemKW, expectedAnnual };
  }, [annualLoad, targetCoverage, annualKWhPerKW, panelW]);

  // Generación por bimestre
  const genBim = useMemo(
    () => bimestralGeneration(systemKW, annualKWhPerKW),
    [systemKW, annualKWhPerKW]
  );

  // Recibos actuales (sin PV) — bimestrales
  const billsNowBim = useMemo(
    () => billsByBim(consBim, tariff, params),
    [consBim, tariff, params]
  );

  // Recibos con PV (neteo bimestral)
  const { bills: billsSolarBim, creditsTrace: creditsBim } = useMemo(
    () => billsWithSolarBim(consBim, genBim, tariff, params, netMetering, carryover),
    [consBim, genBim, tariff, params, netMetering, carryover]
  );

  // Ahorros bimestrales
  const savingsBimMXN = useMemo(() => {
    const out: BMap = { B1:0,B2:0,B3:0,B4:0,B5:0,B6:0 };
    (Object.keys(out) as BKey[]).forEach((b) => {
      out[b] = round2((billsNowBim[b] || 0) - (billsSolarBim[b] || 0));
    });
    return out;
  }, [billsNowBim, billsSolarBim]);

  const capex = useMemo(() => systemKW * costPerKW, [systemKW, costPerKW]);

  // ROI anual (año 1 usa sumas bimestrales)
  const roi = useMemo(
    () => roiCashflows(capex, billsNowBim, billsSolarBim, discount, inflation, omPct, years, degradation),
    [capex, billsNowBim, billsSolarBim, discount, inflation, omPct, years, degradation]
  );

  const summary = useMemo(() => ([
    { Indicador: "CAPEX (MXN)", Valor: fmt(capex, 0) },
    { Indicador: "Consumo anual (kWh)", Valor: fmt(annualLoad, 0) },
    { Indicador: "Generación anual esperada (kWh)", Valor: fmt(expectedAnnual, 0) },
    { Indicador: "Factura anual actual (MXN)", Valor: fmt(sumBMap(billsNowBim), 0) },
    { Indicador: "Factura anual con PV (MXN)", Valor: fmt(sumBMap(billsSolarBim), 0) },
    { Indicador: "Ahorro anual año 1 (MXN)", Valor: fmt(sumBMap(savingsBimMXN), 0) },
    { Indicador: "Payback (años)", Valor: roi.payback ?? "N/D" },
    { Indicador: `NPV (MXN, ${years} años)`, Valor: fmt(roi.npv, 0) },
    { Indicador: "IRR (anual)", Valor: isFinite(roi.irr) ? `${fmt(roi.irr * 100, 1)}%` : "N/D" },
  ]), [capex, annualLoad, expectedAnnual, billsNowBim, billsSolarBim, savingsBimMXN, roi, years]);

  function updateBim(b: BKey, val: string) {
    const v = Number(val.replace(",", ".")) || 0;
    setConsBim((c) => ({ ...c, [b]: v }));
  }

  function exportCSV() {
    const bimKeys = Object.keys(BIM_LABELS) as BKey[];
    const genRows = bimKeys.map((b) => ({ Bimestre: BIM_LABELS[b], Generacion_kWh: genBim[b] }));
    const billNowRows = bimKeys.map((b) => ({ Bimestre: BIM_LABELS[b], Consumo_kWh: consBim[b], Factura_actual_MXN: billsNowBim[b] }));
    const billSolarRows = bimKeys.map((b) => ({
      Bimestre: BIM_LABELS[b],
      Consumo_neto_kWh: Math.max((consBim[b] || 0) - (genBim[b] || 0), 0),
      Factura_con_PV_MXN: billsSolarBim[b],
      Creditos_kWh: creditsBim[b],
    }));
    const savingsRows = bimKeys.map((b) => ({ Bimestre: BIM_LABELS[b], Ahorro_MXN: savingsBimMXN[b] }));
    const summaryRows = summary.map((r) => ({ Indicador: r.Indicador, Valor: r.Valor }));
    downloadCSV("dimensionador_gdl_bimestral.csv", {
      "Generacion_bimestral": genRows,
      "Factura_actual_bimestral": billNowRows,
      "Factura_con_PV_bimestral": billSolarRows,
      "Ahorros_bimestral": savingsRows,
      "Resumen": summaryRows,
      "Flujos": roi.rows.map((r) => ({ Anio: r.year, Flujo: round2(r.cf), Flujo_descontado: round2(r.pv), Acumulado: round2(r.cum) })),
    });
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="px-6 py-5 border-b bg-white sticky top-0 z-10">
        <h1 className="text-2xl font-semibold">Cotizador FV — Guadalajara (Bimestral)</h1>
        <p className="text-sm text-neutral-600">
          Todo bimestral: consumo, neteo, recibos y ROI. Tarifas: 01, DAC, GDMT, GDMTH, PDBT.
        </p>
      </header>

      <main className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Entradas */}
        <section className="xl:col-span-1 space-y-6">
          <Card title="Consumo por bimestre (kWh)">
            <div className="grid grid-cols-2 gap-3">
              {(Object.keys(BIM_LABELS) as BKey[]).map((b) => (
                <div key={b} className="flex flex-col">
                  <label className="text-xs text-neutral-600 mb-1">{BIM_LABELS[b]}</label>
                  <input
                    className="px-3 py-2 rounded-xl border bg-white"
                    type="number"
                    min={0}
                    value={consBim[b]}
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
                <label htmlFor="nm" className="text-sm">Neteo (net billing simplificado)</label>
              </div>
              <div className="flex items-center gap-3">
                <input id="cr" type="checkbox" checked={carryover} onChange={(e) => setCarryover(e.target.checked)} />
                <label htmlFor="cr" className="text-sm">Créditos acumulables entre bimestres</label>
              </div>
            </div>
          </Card>

          <Card title="Tarifa CFE (bimestral)">
            <div className="space-y-3">
              <div className="flex gap-3 flex-wrap items-center">
                {(["01","DAC","GDMT","GDMTH","PDBT"] as Tariff[]).map((t) => (
                  <button key={t} onClick={() => setTariff(t)} className={`px-3 py-1 rounded-full border ${tariff === t ? "bg-black text-white" : "bg-white"}`}>
                    {t}
                  </button>
                ))}
              </div>

              {/* 01 bimestral */}
              {tariff === "01" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cargo fijo BIM (MXN)" value={t01.fixed_mxn_bim} setValue={(v)=>setT01({...t01, fixed_mxn_bim:v})} step={10} />
                  <Num label="Límite Básico (kWh/BIM)" value={t01.kwh_basic_limit_bim} setValue={(v)=>setT01({...t01, kwh_basic_limit_bim:v})} step={10} />
                  <Num label="Límite Intermedio (kWh/BIM)" value={t01.kwh_intermediate_limit_bim} setValue={(v)=>setT01({...t01, kwh_intermediate_limit_bim:v})} step={10} />
                  <Num label="Tarifa Básico ($/kWh)" value={t01.mxn_per_kwh_basic} setValue={(v)=>setT01({...t01, mxn_per_kwh_basic:v})} step={0.05} />
                  <Num label="Tarifa Intermedio ($/kWh)" value={t01.mxn_per_kwh_intermediate} setValue={(v)=>setT01({...t01, mxn_per_kwh_intermediate:v})} step={0.05} />
                  <Num label="Tarifa Excedente ($/kWh)" value={t01.mxn_per_kwh_exceed} setValue={(v)=>setT01({...t01, mxn_per_kwh_exceed:v})} step={0.05} />
                </div>
              )}

              {/* DAC bimestral */}
              {tariff === "DAC" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh (BIM)" value={tDAC.mxn_per_kwh} setValue={(v)=>setTDAC({...tDAC, mxn_per_kwh:v})} step={0.1} />
                  <Num label="Cargo fijo BIM (MXN)" value={tDAC.fixed_mxn_bim} setValue={(v)=>setTDAC({...tDAC, fixed_mxn_bim:v})} step={10} />
                </div>
              )}

              {/* GDMT bimestral */}
              {tariff === "GDMT" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh (BIM)" value={tGDMT.mxn_per_kwh} setValue={(v)=>setTGDMT({...tGDMT, mxn_per_kwh:v})} step={0.1} />
                  <Num label="Cargo fijo BIM (MXN)" value={tGDMT.fixed_mxn_bim} setValue={(v)=>setTGDMT({...tGDMT, fixed_mxn_bim:v})} step={10} />
                  <Num label="MXN/kW DEM al MES" value={tGDMT.mxn_per_kw_demand_month} setValue={(v)=>setTGDMT({...tGDMT, mxn_per_kw_demand_month:v})} step={5} />
                  <Num label="Load factor" value={tGDMT.assumed_load_factor} setValue={(v)=>setTGDMT({...tGDMT, assumed_load_factor:v})} step={0.05} />
                </div>
              )}

              {/* GDMTH bimestral */}
              {tariff === "GDMTH" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh punta (BIM)" value={tGDMTH.mxn_per_kwh_punta} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_punta:v})} step={0.1} />
                  <Num label="MXN/kWh intermedia (BIM)" value={tGDMTH.mxn_per_kwh_intermedia} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_intermedia:v})} step={0.1} />
                  <Num label="MXN/kWh base (BIM)" value={tGDMTH.mxn_per_kwh_base} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kwh_base:v})} step={0.1} />
                  <Num label="Cargo fijo BIM (MXN)" value={tGDMTH.fixed_mxn_bim} setValue={(v)=>setTGDMTH({...tGDMTH, fixed_mxn_bim:v})} step={10} />
                  <Num label="MXN/kW DEM al MES" value={tGDMTH.mxn_per_kw_demand_month} setValue={(v)=>setTGDMTH({...tGDMTH, mxn_per_kw_demand_month:v})} step={5} />
                  <Num label="Split punta" value={tGDMTH.split_punta} setValue={(v)=>setTGDMTH({...tGDMTH, split_punta:v})} step={0.01} />
                  <Num label="Split intermedia" value={tGDMTH.split_intermedia} setValue={(v)=>setTGDMTH({...tGDMTH, split_intermedia:v})} step={0.01} />
                  <Num label="Split base" value={tGDMTH.split_base} setValue={(v)=>setTGDMTH({...tGDMTH, split_base:v})} step={0.01} />
                  <Num label="Load factor" value={tGDMTH.assumed_load_factor} setValue={(v)=>setTGDMTH({...tGDMTH, assumed_load_factor:v})} step={0.05} />
                </div>
              )}

              {/* PDBT bimestral */}
              {tariff === "PDBT" && (
                <div className="grid grid-cols-2 gap-3">
                  <Num label="MXN/kWh (BIM)" value={tPDBT.mxn_per_kwh} setValue={(v)=>setTPDBT({...tPDBT, mxn_per_kwh:v})} step={0.1} />
                  <Num label="Cargo fijo BIM (MXN)" value={tPDBT.fixed_mxn_bim} setValue={(v)=>setTPDBT({...tPDBT, fixed_mxn_bim:v})} step={10} />
                  <Num label="MXN/kW DEM al MES" value={tPDBT.mxn_per_kw_demand_month} setValue={(v)=>setTPDBT({...tPDBT, mxn_per_kw_demand_month:v})} step={5} />
                  <Num label="Load factor" value={tPDBT.assumed_load_factor} setValue={(v)=>setTPDBT({...tPDBT, assumed_load_factor:v})} step={0.05} />
                </div>
              )}
            </div>
          </Card>

          <div className="flex gap-3">
            <button onClick={exportCSV} className="px-4 py-2 rounded-xl bg-black text-white">Descargar CSV</button>
          </div>
        </section>

        {/* Salidas */}
        <section className="xl:col-span-2 space-y-6">
          <Card title="Dimensionamiento del sistema">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <KV k="Paneles" v={String(panels)} />
              <KV k="Tamaño (kWdc)" v={fmt(systemKW, 2)} />
              <KV k="Generación anual (kWh)" v={fmt(expectedAnnual, 0)} />
              <KV k="Consumo anual (kWh)" v={fmt(annualLoad, 0)} />
              <KV k="kWh/kW-año" v={fmt(annualKWhPerKW, 0)} />
              <KV k="CAPEX (MXN)" v={fmt(capex, 0)} />
            </div>
          </Card>

          <Card title="Generación por bimestre (kWh)">
            <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
              Bimestre: BIM_LABELS[b], "Generación (kWh)": fmt(genBim[b], 2)
            }))} />
          </Card>

          <Card title="Factura bimestral actual (sin PV)">
            <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
              Bimestre: BIM_LABELS[b],
              "Consumo (kWh)": fmt(consBim[b], 0),
              "Factura (MXN)": fmt(billsNowBim[b], 2),
            }))} />
          </Card>

          <Card title="Factura con PV (neteo bimestral)">
            <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
              Bimestre: BIM_LABELS[b],
              "Consumo neto (kWh)": fmt(Math.max((consBim[b] || 0) - (genBim[b] || 0), 0), 2),
              "Factura con PV (MXN)": fmt(billsSolarBim[b], 2),
              "Créditos (kWh)": fmt(creditsBim[b], 2),
            }))} />
          </Card>

          <Card title="Ahorro por bimestre">
            <Table rows={(Object.keys(BIM_LABELS) as BKey[]).map((b) => ({
              Bimestre: BIM_LABELS[b],
              "Ahorro (MXN)": fmt(savingsBimMXN[b], 2),
            }))} />
          </Card>

          <Card title="Resumen financiero (ROI)">
            <Table rows={summary} />
            <div className="mt-4 overflow-auto">
              <Table rows={roi.rows.map((r) => ({
                "Año": r.year,
                "Flujo (MXN)": fmt(r.cf, 2),
                "Flujo descontado (MXN)": fmt(r.pv, 2),
                "Acumulado (MXN)": fmt(r.cum, 2),
              }))} />
            </div>
            <p className="text-xs text-neutral-500 mt-3">
              Nota: Modelo bimestral simplificado. En tarifas con demanda (GDMT/GDMTH/PDBT) se
              aproxima la demanda mensual desde kWh del bimestre y se cobra por 2 meses.
              Ajusta los parámetros a tu recibo real.
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

// lib/cabling.ts
// Cálculos prácticos alineados a NOM-001-SEDE-2012/NEC:
// - 690-8: corrientes continuas 125%
// - 690-7: verificación Voc en frío
// - 310-15: factores de corrección por temperatura/agrupamiento
// - Selección de AWG cobre (THWN-2 90°C base) con límite de terminal 75/90°C
// - Caída de tensión DC / AC 1Φ / AC 3Φ y validación 3%/5%

// ================= Tipos de datos =================
export type DerateInput = {
  fTemp: number;           // factor por temperatura (310-15)
  fBundling: number;       // factor por >3 conductores portadores (310-15)
  terminalTempC?: 75 | 90; // límite por terminal (default 75)
};

export type DcPvInput = {
  stringsParalelo: number; // Np
  iscModuloA: number;      // Isc STC módulo [A]
};

export type InverterAcInput = {
  iOutInvA: number;        // Corriente nominal de salida del inversor [A]
};

export type MicroBranchInput = {
  nMicros: number;
  iOutMicroA: number;      // Corriente nominal por micro [A]
};

// Tamaños comerciales típicos de OCPD (A)
export const OCPD_STEPS = [
  15, 20, 25, 30, 35, 40, 45, 50,
  60, 70, 80, 90, 100, 110, 125,
  150, 175, 200, 225, 250, 300, 350, 400
] as const;

/** Redondea hacia el tamaño comercial inmediato superior (p. ej., 23.2 A → 25 A). */
export function roundUpToStandardOCPD(amps: number) {
  const need = Math.max(0, amps);
  for (const a of OCPD_STEPS) if (a >= need - 1e-9) return a;
  // Fallback si excede la tabla: siguiente múltiplo de 50 A
  return Math.ceil(need / 50) * 50;
}

/** OCPD recomendado (DC) con redondeo comercial y límite opcional por fusible máx del módulo.
 *  - iMaxA debe ser tu corriente continua de cálculo (ya con 125% de 690.8(A)).
 *  - Si pasas moduleMaxFuseA (de la hoja del módulo), se respeta como límite superior.
 */
export function ocpdRecommendedRoundedA(iMaxA: number, moduleMaxFuseA?: number) {
  const rounded = roundUpToStandardOCPD(iMaxA);
  return moduleMaxFuseA && moduleMaxFuseA > 0 ? Math.min(rounded, moduleMaxFuseA) : rounded;
}

// ================= Corrientes/Ampacidades =================
export function pvDcMaxCurrentA({ stringsParalelo, iscModuloA }: DcPvInput) {
  const iSum = Math.max(0, stringsParalelo) * Math.max(0, iscModuloA);
  const iMax = 1.25 * iSum; // 690-8(a) 125%
  return { iSum, iMax };
}


/** Ampacidad mínima requerida (690-8(b)):
 *  max(1.25*Imax, Imax/(fTemp*fBundling))
 *  → mientras fTemp*fBundling ≥ 0.80, manda 1.25*Imax (umbral típico).
 */
export function requiredConductorAmpacityA(iMaxA: number, derate: DerateInput) {
  const f = Math.max(0.01, (derate.fTemp || 1) * (derate.fBundling || 1));
  const req1 = 1.25 * iMaxA;
  const req2 = iMaxA / f;
  return Math.max(req1, req2);
}

/** OCPD recomendado (690.8): ≥ 125% de la corriente continua,
 *  redondeado al tamaño comercial inmediato superior.
 *  Opcional: limitar por fusible máximo del módulo (si se desea).
 */
export function ocpdRecommendedA(
  iMaxA: number,
  opts?: { maxModuleFuseA?: number }
) {
  const need = 1.25 * iMaxA;
  let size = roundUpToStandardOCPD(need);
  if (opts?.maxModuleFuseA) size = Math.min(size, opts.maxModuleFuseA);
  return size;
}

/** AC – inversor central */
export function inverterAcSizing({ iOutInvA }: InverterAcInput, derate: DerateInput) {
  const iMax = iOutInvA;
  const minAmpacity = requiredConductorAmpacityA(iMax, derate);
  const ocpd = ocpdRecommendedA(iMax);
  return { iMax, minAmpacity, ocpd };
}

/** AC microinversores – ramal/troncal */
export function microBranchSizing({ nMicros, iOutMicroA }: MicroBranchInput, derate: DerateInput) {
  const iMax = Math.max(0, nMicros) * Math.max(0, iOutMicroA);
  const minAmpacity = requiredConductorAmpacityA(iMax, derate);
  const ocpd = ocpdRecommendedA(iMax);
  return { iMax, minAmpacity, ocpd };
}

// ================ Voc frío / Vmp caliente =================
export function vocColdFactor(tempC: number) {
  if (tempC <= -35) return 1.25;
  if (tempC <= -30) return 1.23;
  if (tempC <= -25) return 1.21;
  if (tempC <= -20) return 1.20;
  if (tempC <= -15) return 1.18;
  if (tempC <= -10) return 1.14;
  if (tempC <= -5)  return 1.12;
  if (tempC <= 0)   return 1.10;
  if (tempC <= 5)   return 1.08;
  if (tempC <= 10)  return 1.06;
  if (tempC <= 15)  return 1.04;
  if (tempC <= 25)  return 1.02;
  return 1.00;
}

export function checkStringVocCold(vocModuloV: number, modPorString: number, tMinC: number) {
  const factor = vocColdFactor(tMinC);
  const vocStringFrioV = vocModuloV * modPorString * factor;
  return { vocStringFrioV, factor };
}

/** Vmp_hot = Vmp_stc * (1 + βvmp[%/°C] * (Tcell-25)/100) */
export function vmpHot(moduleVmpStcV: number, betaVmpPctPerC: number, tCellHotC: number) {
  const dv = (betaVmpPctPerC / 100) * (tCellHotC - 25);
  return moduleVmpStcV * (1 + dv);
}

/** Rango sugerido de módulos por string */
export function suggestStringRange(params: {
  inverterVdcMaxV: number;
  inverterVmpptMinV: number;
  moduleVocStcV: number;
  moduleVmpStcV: number;
  betaVmpPctPerC: number;
  tCellHotC: number;
  tAmbientColdC: number;
}) {
  const vmpHotV = vmpHot(params.moduleVmpStcV, params.betaVmpPctPerC, params.tCellHotC);
  const vocFrioFactor = vocColdFactor(params.tAmbientColdC);
  const nsMin = Math.max(1, Math.ceil(params.inverterVmpptMinV / Math.max(1e-6, vmpHotV)));
  const nsMax = Math.max(1, Math.floor(params.inverterVdcMaxV / (params.moduleVocStcV * vocFrioFactor)));
  return { nsMin, nsMax, vmpHotV, vocFactorFrio: vocFrioFactor };
}

// ================ Tablas AWG cobre (30 °C) =================
// THWN-2 90°C (base 30°C)
const AMPACITY_90C_A: Record<string, number> = {
  "14": 25, "12": 30, "10": 40, "8": 55, "6": 75, "4": 95,
  "3": 110, "2": 130, "1": 145, "1/0": 170, "2/0": 195, "3/0": 225, "4/0": 260
};
// Límite terminal 75°C (30°C ambiente)
const AMPACITY_75C_A: Record<string, number> = {
  "14": 20, "12": 25, "10": 35, "8": 50, "6": 65, "4": 85,
  "3": 100, "2": 115, "1": 130, "1/0": 150, "2/0": 175, "3/0": 200, "4/0": 230
};
// Resistencia DC aprox (ohm/m @20°C)
const RESIST_OHM_PER_M: Record<string, number> = {
  "14": 0.008286, "12": 0.005211, "10": 0.003277, "8": 0.002061,
  "6": 0.001296, "4": 0.000815, "3": 0.000646, "2": 0.000513,
  "1": 0.000406, "1/0": 0.000323, "2/0": 0.000257, "3/0": 0.000204, "4/0": 0.000161
};

export type CopperAwg =
  | "14" | "12" | "10" | "8" | "6" | "4" | "3" | "2" | "1" | "1/0" | "2/0" | "3/0" | "4/0";

/** Selección de AWG cobre con derates; respeta 75/90°C en terminal */
export function selectCopperAwg(requiredAmpA: number, derate: DerateInput) {
  const f = Math.max(0.01, (derate.fTemp || 1) * (derate.fBundling || 1));
  const terminalC = derate.terminalTempC ?? 75;
  const awgs: CopperAwg[] = ["14","12","10","8","6","4","3","2","1","1/0","2/0","3/0","4/0"];

  for (const awg of awgs) {
    const base90 = AMPACITY_90C_A[awg];
    const adj90 = base90 * f;
    const termLimit = terminalC === 90 ? AMPACITY_90C_A[awg] : AMPACITY_75C_A[awg];
    const allowable = Math.min(adj90, termLimit);
    if (allowable >= requiredAmpA) {
      return { awg, allowableA: allowable, base90A: base90, termLimitA: termLimit, fDerate: f };
    }
  }
  // Si nada alcanza, devolver el mayor y avisar con allowable calculada
  const awg: CopperAwg = "4/0";
  const base90 = AMPACITY_90C_A[awg];
  const termLimit = (derate.terminalTempC === 90 ? AMPACITY_90C_A[awg] : AMPACITY_75C_A[awg]);
  return { awg, allowableA: Math.min(base90 * f, termLimit), base90A: base90, termLimitA: termLimit, fDerate: f };
}

// =================== Caída de tensión ===================
export function voltageDropDCDC(params: {
  awg: CopperAwg;
  currentA: number;
  lengthOneWayM: number; // unidireccional
  voltageV: number;      // V de referencia (Vmp string o nominal)
}) {
  const R = RESIST_OHM_PER_M[params.awg];
  const Vdrop = 2 * params.currentA * R * params.lengthOneWayM; // ida+vuelta
  const pct = (Vdrop / Math.max(1e-9, params.voltageV)) * 100;
  return { Vdrop, pct };
}

export function voltageDropAC1P(params: {
  awg: CopperAwg;
  currentA: number;
  lengthOneWayM: number;
  voltageV: number;  // 120/240/etc
  pf?: number;       // ~1
}) {
  const R = RESIST_OHM_PER_M[params.awg];
  const pf = params.pf ?? 1;
  const Vdrop = 2 * params.currentA * R * params.lengthOneWayM * pf;
  const pct = (Vdrop / Math.max(1e-9, params.voltageV)) * 100;
  return { Vdrop, pct };
}

export function voltageDropAC3P(params: {
  awg: CopperAwg;
  currentA: number;
  lengthOneWayM: number;
  voltageLineV: number; // 208/480/etc
  pf?: number;
}) {
  const R = RESIST_OHM_PER_M[params.awg];
  const pf = params.pf ?? 1;
  const Vdrop = Math.sqrt(3) * params.currentA * R * params.lengthOneWayM * pf;
  const pct = (Vdrop / Math.max(1e-9, params.voltageLineV)) * 100;
  return { Vdrop, pct };
}

export function vdExceeds(pct: number, kind: "ramal" | "alimentador") {
  const limit = kind === "ramal" ? 3 : 5;
  return { exceeds: pct > limit, limitPct: limit };
}

// lib/cabling.ts
// Cálculos para NOM-001-SEDE-2012 (enfoque práctico):
// - 125% corrientes continuas (690-8), verificación Voc en frío (690-7)
// - Derates por temperatura/agrupamiento (310-15)
// - Selección de AWG cobre (THWN-2 90°C base) con opción a limitar por 75°C en terminal
// - Caída de tensión DC / AC 1Φ / AC 3Φ y validación 3%/5%

export type DerateInput = {
  fTemp: number;        // factor por temperatura (310-15)
  fBundling: number;    // factor por >3 conductores portadores (310-15)
  terminalTempC?: 75 | 90; // límite de terminal (si se desea). Default 75.
};

export type DcPvInput = {
  stringsParalelo: number;  // Np
  iscModuloA: number;       // Isc STC módulo [A]
};

export type InverterAcInput = {
  iOutInvA: number; // Corriente continua nominal de salida del inversor [A]
};

export type MicroBranchInput = {
  nMicros: number;
  iOutMicroA: number; // corriente continua nominal por micro [A]
};

// ===== Utilidades OCPD =====

const STANDARD_OCPD_A = [
  15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125,
  150, 175, 200, 225, 250, 300, 350, 400,
];

export function roundUpToStandardOCPD(amps: number) {
  for (const a of STANDARD_OCPD_A) {
    if (a >= amps - 1e-9) return a;
  }
  return Math.ceil(amps / 50) * 50; // fallback si te vas muy alto
}

/** OCPD recomendado genérico: >= 125% de la corriente continua */
export function ocpdRecommendedA(iMaxA: number) {
  return 1.25 * iMaxA;
}

/** OCPD DC recomendado con redondeo a valor comercial y límite opcional por fusible máx del módulo */
export function ocpdRecommendedRoundedA(iMaxA: number, fuseMaxPerModuleA?: number) {
  const raw = 1.25 * iMaxA; // 690-8(b): 125% de la corriente continua (iMax ya incluye 125% de ΣIsc)
  let rounded = roundUpToStandardOCPD(raw);
  if (typeof fuseMaxPerModuleA === "number" && fuseMaxPerModuleA > 0) {
    rounded = Math.min(rounded, roundUpToStandardOCPD(fuseMaxPerModuleA));
  }
  return rounded;
}

// ================= Corrientes/Ampacidades =================

/** 690-8(a): Imax = 1.25 × ΣIsc (strings en paralelo) */
export function pvDcMaxCurrentA({ stringsParalelo, iscModuloA }: DcPvInput) {
  const iSum = Math.max(0, stringsParalelo) * Math.max(0, iscModuloA);
  const iMax = 1.25 * iSum;
  return { iSum, iMax };
}

/** Ampacidad mínima requerida (690-8(b)): max(1.25*Imax, Imax/(fTemp*fBundling)) */
export function requiredConductorAmpacityA(iMaxA: number, derate: DerateInput) {
  // Si fTemp o fBundling no se indicaron, usamos 1
  const f = Math.max(0.01, (derate.fTemp || 1) * (derate.fBundling || 1));
  // Requisito por “carga continua” (sin derates):
  const req1 = 1.25 * iMaxA;
  // Requisito por condiciones de uso (derates):
  const req2 = iMaxA / f;
  return Math.max(req1, req2);
}

// ===== AC sizing (simplificado) =====

/** AC – inversor central: usa corriente continua de salida */
export function inverterAcSizing({ iOutInvA }: InverterAcInput, derate: DerateInput) {
  const iMax = iOutInvA;
  const minAmpacity = requiredConductorAmpacityA(iMax, derate);
  // Recomendamos OCPD con redondeo comercial
  const ocpd = roundUpToStandardOCPD(ocpdRecommendedA(iMax));
  return { iMax, minAmpacity, ocpd };
}

/** AC microinversores – ramal/troncal (suma continua) */
export function microBranchSizing({ nMicros, iOutMicroA }: MicroBranchInput, derate: DerateInput) {
  const iMax = Math.max(0, nMicros) * Math.max(0, iOutMicroA);
  const minAmpacity = requiredConductorAmpacityA(iMax, derate);
  const ocpd = roundUpToStandardOCPD(ocpdRecommendedA(iMax));
  return { iMax, minAmpacity, ocpd };
}

// ===== Voc en frío y Vmp en caliente =====

/** Tabla simplificada de factor Voc por baja T° (aprox. NOM 690-7) */
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

/** Verificación rápida de Voc string en frío */
export function checkStringVocCold(vocModuloV: number, modPorString: number, tMinC: number) {
  const factor = vocColdFactor(tMinC);
  const vocStringFrioV = vocModuloV * modPorString * factor;
  return { vocStringFrioV, factor };
}

/** Factor de Vmp caliente con coeficiente βvmp (%/°C, negativo): Vmp_hot = Vmp_stc * (1 + β*(Tcell-25)/100) */
export function vmpHot(moduleVmpStcV: number, betaVmpPctPerC: number, tCellHotC: number) {
  const dv = (betaVmpPctPerC / 100) * (tCellHotC - 25);
  return moduleVmpStcV * (1 + dv);
}

/** Sugerencia de rango de módulos por string según inversor */
export function suggestStringRange(params: {
  inverterVdcMaxV: number;
  inverterVmpptMinV: number;
  moduleVocStcV: number;
  moduleVmpStcV: number;
  betaVmpPctPerC: number;   // típico -0.30 a -0.45
  tCellHotC: number;        // p. ej. 65°C
  tAmbientColdC: number;    // p. ej. 5°C o menor
}) {
  const vmpHotV = vmpHot(params.moduleVmpStcV, params.betaVmpPctPerC, params.tCellHotC);
  const vocFrioFactor = vocColdFactor(params.tAmbientColdC);
  const nsMin = Math.max(1, Math.ceil(params.inverterVmpptMinV / Math.max(1e-6, vmpHotV)));
  const nsMax = Math.max(1, Math.floor(params.inverterVdcMaxV / (params.moduleVocStcV * vocFrioFactor)));
  return {
    nsMin,
    nsMax,
    vmpHotV,
    vocFactorFrio: vocFrioFactor
  };
}

// ===== Tablas: ampacidad (base, 30°C) y resistencia DC (aprox @20°C) para cobre =====

// THWN-2 90°C (columna 90°C). Valores típicos base (A) a 30°C.
const AMPACITY_90C_A: Record<string, number> = {
  "14": 25, "12": 30, "10": 40, "8": 55, "6": 75, "4": 95,
  "3": 110, "2": 130, "1": 145, "1/0": 170, "2/0": 195, "3/0": 225, "4/0": 260
};
// Límite de terminal 75°C (A) a 30°C. Si terminales son 75°C.
const AMPACITY_75C_A: Record<string, number> = {
  "14": 20, "12": 25, "10": 35, "8": 50, "6": 65, "4": 85,
  "3": 100, "2": 115, "1": 130, "1/0": 150, "2/0": 175, "3/0": 200, "4/0": 230
};
// Resistencia DC (ohm/m, cobre aprox. a 20°C).
const RESIST_OHM_PER_M: Record<string, number> = {
  "14": 0.008286, "12": 0.005211, "10": 0.003277, "8": 0.002061,
  "6": 0.001296, "4": 0.000815, "3": 0.000646, "2": 0.000513,
  "1": 0.000406, "1/0": 0.000323, "2/0": 0.000257, "3/0": 0.000204, "4/0": 0.000161
};

export type CopperAwg =
  | "14" | "12" | "10" | "8" | "6" | "4" | "3" | "2" | "1" | "1/0" | "2/0" | "3/0" | "4/0";

/** Selección de AWG (cobre) con derates */
export function selectCopperAwg(
  requiredAmpA: number,
  derate: DerateInput
): {
  awg: CopperAwg;
  allowableA: number;
  base90A: number;
  termLimitA: number;
  fDerate: number;
} {
  const f = Math.max(0.01, (derate.fTemp || 1) * (derate.fBundling || 1));
  const terminalC = derate.terminalTempC ?? 75;
  const awgs: CopperAwg[] = ["14","12","10","8","6","4","3","2","1","1/0","2/0","3/0","4/0"];

  for (const awg of awgs) {
    const base90 = AMPACITY_90C_A[awg];
    const adj90 = base90 * f; // reducción por condiciones de uso
    const termLimit = terminalC === 90 ? AMPACITY_90C_A[awg] : AMPACITY_75C_A[awg];
    const allowable = Math.min(adj90, termLimit);
    if (allowable >= requiredAmpA) {
      return {
        awg,
        allowableA: allowable,
        base90A: base90,
        termLimitA: termLimit,
        fDerate: f
      };
    }
  }

  // Si nada alcanza, devolver el mayor
  const awg: CopperAwg = "4/0";
  return {
    awg,
    allowableA: Math.min(
      AMPACITY_90C_A[awg] * f,
      terminalC === 90 ? AMPACITY_90C_A[awg] : AMPACITY_75C_A[awg]
    ),
    base90A: AMPACITY_90C_A[awg],
    termLimitA: terminalC === 90 ? AMPACITY_90C_A[awg] : AMPACITY_75C_A[awg],
    fDerate: f
  };
}
// ===== Caída de tensión =====

export function voltageDropDCDC(params: {
  awg: CopperAwg;
  currentA: number;
  lengthOneWayM: number; // longitud unidireccional
  voltageV: number;      // tensión de referencia (Vmp string o nominal)
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
  pf?: number;       // opcional, ~1
}) {
  const R = RESIST_OHM_PER_M[params.awg];
  const pf = params.pf ?? 1;
  // Aproximación resistiva: Vd ≈ 2*I*R*L
  const Vdrop = 2 * params.currentA * R * params.lengthOneWayM * pf;
  const pct = (Vdrop / Math.max(1e-9, params.voltageV)) * 100;
  return { Vdrop, pct };
}

export function voltageDropAC3P(params: {
  awg: CopperAwg;
  currentA: number;
  lengthOneWayM: number;
  voltageLineV: number; // 208/480/etc (línea-línea)
  pf?: number;          // ~1
}) {
  const R = RESIST_OHM_PER_M[params.awg];
  const pf = params.pf ?? 1;
  // Vd ≈ √3 * I * R * L
  const Vdrop = Math.sqrt(3) * params.currentA * R * params.lengthOneWayM * pf;
  const pct = (Vdrop / Math.max(1e-9, params.voltageLineV)) * 100;
  return { Vdrop, pct };
}

/** Helper para validar límites de caída de tensión */
export function vdExceeds(pct: number, kind: "ramal" | "alimentador") {
  const limit = kind === "ramal" ? 3 : 5; // % recomendado
  return { exceeds: pct > limit, limitPct: limit };
}
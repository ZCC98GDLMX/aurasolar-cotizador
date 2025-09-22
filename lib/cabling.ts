// app/cotizador/lib/cabling.ts
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

// ===== Corrientes y ampacidades =====

export function pvDcMaxCurrentA({ stringsParalelo, iscModuloA }: DcPvInput) {
  const iSum = Math.max(0, stringsParalelo) * Math.max(0, iscModuloA); // suma de Isc en paralelo
  const iMax = 1.25 * iSum; // 690-8(a) (125%)
  return { iSum, iMax };
}

/** Ampacidad mínima requerida (690-8(b)): max(1.25*Imax, Imax/(fTemp*fBundling)) */
export function requiredConductorAmpacityA(iMaxA: number, derate: DerateInput) {
  const f = Math.max(0.01, (derate.fTemp || 1) * (derate.fBundling || 1));
  const req1 = 1.25 * iMaxA;  // 125% sin derates
  const req2 = iMaxA / f;     // condiciones de uso
  return Math.max(req1, req2);
}

/** OCPD recomendado: >= 125% de la corriente continua */
export function ocpdRecommendedA(iMaxA: number) {
  return 1.25 * iMaxA;
}

/** AC – inversor central: usa corriente continua de salida */
export function inverterAcSizing({ iOutInvA }: InverterAcInput, derate: DerateInput) {
  const iMax = iOutInvA;
  const minAmpacity = requiredConductorAmpacityA(iMax, derate);
  const ocpd = ocpdRecommendedA(iMax);
  return { iMax, minAmpacity, ocpd };
}

/** AC microinversores – ramal/troncal (suma continua) */
export function microBranchSizing({ nMicros, iOutMicroA }: MicroBranchInput, derate: DerateInput) {
  const iMax = Math.max(0, nMicros) * Math.max(0, iOutMicroA);
  const minAmpacity = requiredConductorAmpacityA(iMax, derate);
  const ocpd = ocpdRecommendedA(iMax);
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

/** Sugerencia de rango de módulos por string según inversor:
 *  - mínimo por MPPT: ceil(VmpptMin / Vmp_hot)
 *  - máximo por Vdc:  floor(VdcMax / (Voc * factor_frio))
 */
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

// 1) Define primero el tipo CopperAwg (arriba de las tablas)
export type CopperAwg =
  | "14" | "12" | "10" | "8" | "6" | "4" | "3" | "2" | "1"
  | "1/0" | "2/0" | "3/0" | "4/0";

// 2) Tablas estrictamente tipadas por CopperAwg
const AMPACITY_90C_A: Record<CopperAwg, number> = {
  "14": 25, "12": 30, "10": 40, "8": 55, "6": 75, "4": 95,
  "3": 110, "2": 130, "1": 145, "1/0": 170, "2/0": 195, "3/0": 225, "4/0": 260
};

const AMPACITY_75C_A: Record<CopperAwg, number> = {
  "14": 20, "12": 25, "10": 35, "8": 50, "6": 65, "4": 85,
  "3": 100, "2": 115, "1": 130, "1/0": 150, "2/0": 175, "3/0": 200, "4/0": 230
};

const RESIST_OHM_PER_M: Record<CopperAwg, number> = {
  "14": 0.008286, "12": 0.005211, "10": 0.003277, "8": 0.002061,
  "6": 0.001296, "4": 0.000815, "3": 0.000646, "2": 0.000513,
  "1": 0.000406, "1/0": 0.000323, "2/0": 0.000257, "3/0": 0.000204, "4/0": 0.000161
};

/** Selección de AWG (cobre):
 * - Base 90°C con derates (fTemp*fBundling)
 * - Opcional: limitar por terminal 75°C (o 90°C si el equipo lo permite)
 */
export function selectCopperAwg(requiredAmpA: number, derate: DerateInput) {
  const f = Math.max(0.01, (derate.fTemp || 1) * (derate.fBundling || 1));
  const terminalC = derate.terminalTempC ?? 75;
  const awgs: CopperAwg[] = ["14","12","10","8","6","4","3","2","1","1/0","2/0","3/0","4/0"];
  for (const awg of awgs) {
    const base90 = AMPACITY_90C_A[awg];
    const adj90 = base90 * f; // reducción por condiciones de uso
    const termLimit = terminalC === 90 ? AMPACITY_90C_A[awg] : AMPACITY_75C_A[awg];
    const allowable = Math.min(adj90, termLimit);
    if (allowable >= requiredAmpA) {
      return { awg, allowableA: allowable, base90A: base90, termLimitA: termLimit, fDerate: f };
    }
  }
  // Si nada alcanza, devolver el mayor con sus datos para avisar
  const awg = "4/0";
  return { awg, allowableA: Math.min(AMPACITY_90C_A[awg]*f, (derate.terminalTempC===90?AMPACITY_90C_A[awg]:AMPACITY_75C_A[awg])), base90A: AMPACITY_90C_A[awg], termLimitA: (derate.terminalTempC===90?AMPACITY_90C_A[awg]:AMPACITY_75C_A[awg]), fDerate: f };
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
  // Aproximación resistiva (X≈0, cosφ≈pf): Vd ≈ 2*I*R*L
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

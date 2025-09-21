// lib/k2.ts

export type K2RowMode = "tiltup_1row" | "multirow_2rows";

export type K2Out = {
  // Geometría base
  modulePitchEOMM: number;
  rowLenMM: number;
  supportsPerRow: number;
  supportPitchEOMM: number;
  supportPitchActualMM: number;
  supportPositionsEOMM: number[];
  nsRailSpacingC2CMM: number;
  // Inclinación
  riseMM: number;
  frontLegMM: number;
  rearLegMM: number;
  // Rieles
  totalEORailsMM: number;
  totalNSRailsMM: number;
  totalAuxLegRailsMM: number;
  // Barras comerciales y empalmes
  bars48m: number;
  splices: number;
  // Piezas típicas
  endClamp: number;
  midClamp: number;
  lFeet: number;
  tiltConnectors: number;
  climbers: number;
  groundingLug: number;
  earthingClip: number;
  cableClip: number;
  // Meta
  rows: number;
};

/**
 * Cálculo simplificado K2 CrossRail (Tilt-Up 1 Row / Multi-Row 2 Rows).
 * NOTA: modelo genérico; valida contra tablas K2 para ingeniería final.
 */
export function k2Compute(opts: {
  N: number;
  panelWMM: number;
  panelHMM: number;
  orientation: "portrait" | "landscape";
  gapMM: number;
  tiltDeg: number;
  mode: K2RowMode;
  autoSpanEw?: boolean;      // si true: paso E-O = módulo + gap
  spanEwMM?: number;         // manual si autoSpanEw = false
  nsRailSpacingPresetMM?: number; // separación N-S c-a-c (override)
}): K2Out {
  const {
    N,
    panelWMM,
    panelHMM,
    orientation,
    gapMM,
    tiltDeg,
    mode,
    autoSpanEw = true,
    spanEwMM = 1200,
    nsRailSpacingPresetMM,
  } = opts;

  const n = Math.max(0, Math.floor(N));
  const rows = mode === "multirow_2rows" ? 2 : 1;

  if (n === 0) {
    return {
      modulePitchEOMM: 0,
      rowLenMM: 0,
      supportsPerRow: 0,
      supportPitchEOMM: 0,
      supportPitchActualMM: 0,
      supportPositionsEOMM: [],
      nsRailSpacingC2CMM: 0,
      riseMM: 0,
      frontLegMM: 0,
      rearLegMM: 0,
      totalEORailsMM: 0,
      totalNSRailsMM: 0,
      totalAuxLegRailsMM: 0,
      bars48m: 0,
      splices: 0,
      endClamp: 0,
      midClamp: 0,
      lFeet: 0,
      tiltConnectors: 0,
      climbers: 0,
      groundingLug: 0,
      earthingClip: 0,
      cableClip: 0,
      rows,
    };
  }

  // Dimensiones efectivas
  const modEO = orientation === "portrait" ? panelWMM : panelHMM; // anchura en E-O
  const modNS = orientation === "portrait" ? panelHMM : panelWMM; // “largo” N-S

  // Longitud de fila y paso de módulos
  const modulePitchEOMM = modEO + Math.max(0, gapMM);
  const rowLenMM = n * modEO + Math.max(0, n - 1) * Math.max(0, gapMM);

  // Apoyos/patas a lo largo de E-O
  const supportPitchEOMM = autoSpanEw ? modulePitchEOMM : Math.max(300, spanEwMM);
  const supportsPerRow = Math.max(2, Math.ceil(rowLenMM / supportPitchEOMM));
  const supportPitchActualMM = rowLenMM / supportsPerRow;
  const supportPositionsEOMM = Array.from({ length: supportsPerRow }, (_, i) =>
    Math.round((i + 0.5) * supportPitchActualMM)
  );

  // Separación N-S c-a-c: presets aproximados de catálogos
  //   TiltUp 1 Row: ~1.57 m ; Multi-Row 2 Rows: ~3.76 m
  const nsRailSpacingC2CMM = nsRailSpacingPresetMM ?? (mode === "multirow_2rows" ? 3760 : 1570);

  // Inclinación: delta de alturas entre pata trasera y delantera
  const tilt = (Math.PI / 180) * tiltDeg;
  const riseMM = modNS * Math.tan(tilt);
  const frontLegMM = 0; // referencia (pata delantera)
  const rearLegMM = Math.max(0, Math.round(riseMM));

  // Rieles: E-O (CrossRail) 2 por fila, a lo largo de rowLenMM
  const eoRailsPerRow = 2;
  const totalEORailsMM = rows * eoRailsPerRow * rowLenMM;

  // Rieles N-S: 2 por fila (delantero/trasero), por cada tramo de apoyo E-O
  const nsRailsPerRow = 2;
  const totalNSRailsMM = rows * nsRailsPerRow * supportsPerRow * nsRailSpacingC2CMM;

  // Riel auxiliar para patas: ~0.25 m por pata (aproximado)
  const legsPerRow = supportsPerRow * 2; // delantera + trasera
  const totalLegs = rows * legsPerRow;
  const totalAuxLegRailsMM = totalLegs * 250;

  // Barras comerciales 4.8 m
  const stockMM = 4800;
  const totalRailsMM = totalEORailsMM + totalNSRailsMM + totalAuxLegRailsMM;
  const bars48m = Math.ceil(totalRailsMM / stockMM);
  const splices = Math.max(0, bars48m - 1);

  // Piezas típicas (aprox.)
  const endClamp = 4 * rows;
  const midClamp = n >= 2 ? rows * 2 * (n - 1) : 0;
  const lFeet = rows * supportsPerRow * 2;          // 2 patas por apoyo (frontal+trasera)
  const tiltConnectors = rows * supportsPerRow * 2; // 2 por apoyo
  const climbers = eoRailsPerRow * rows * supportsPerRow; // un climber por cruce riel/apoyo
  const groundingLug = n <= 4 ? rows * 1 : rows * 2;
  const earthingClip = midClamp;
  const cableClip = n >= 6 ? n * rows : 0;

  return {
    modulePitchEOMM,
    rowLenMM,
    supportsPerRow,
    supportPitchEOMM,
    supportPitchActualMM,
    supportPositionsEOMM,
    nsRailSpacingC2CMM,
    riseMM,
    frontLegMM,
    rearLegMM,
    totalEORailsMM,
    totalNSRailsMM,
    totalAuxLegRailsMM,
    bars48m,
    splices,
    endClamp,
    midClamp,
    lFeet,
    tiltConnectors,
    climbers,
    groundingLug,
    earthingClip,
    cableClip,
    rows,
  };
}

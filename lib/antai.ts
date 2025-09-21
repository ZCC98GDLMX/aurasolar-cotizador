// lib/antai.ts

export type AntaiBom = {
  total4700: number;
  total2400: number;
  totalSplices: number;
  endClamp: number;
  midClamp: number;
  frontLeg: number;
  rearLeg: number;
  groundingLug: number;
  earthingClip: number;
  cableClip: number;
};

/**
 * Dada una longitud objetivo (mm), devuelve el combo de rieles 4700/2400
 * que cumpla la longitud con el MENOR número de piezas y MENOR excedente.
 */
export function pickRailsForLength(lengthMM: number, minPiecesPerRail = 2) {
  let best: { n4700: number; n2400: number; pieces: number; waste: number } | null = null;

  for (let n4700 = 0; n4700 <= 20; n4700++) {
    for (let n2400 = 0; n2400 <= 20; n2400++) {
      const pieces = n4700 + n2400;
      if (pieces < minPiecesPerRail) continue;

      const total = 4700 * n4700 + 2400 * n2400;
      if (total < lengthMM) continue;

      const waste = total - lengthMM;
      if (!best || pieces < best.pieces || (pieces === best.pieces && waste < best.waste)) {
        best = { n4700, n2400, pieces, waste };
      }
    }
  }

  if (!best) {
    const n4700 = Math.ceil(lengthMM / 4700);
    return { n4700, n2400: 0 };
  }
  return { n4700: best.n4700, n2400: best.n2400 };
}

/**
 * BOM ANTAI para 1 fila con N paneles.
 * unitAlongRowMM = dimensión del módulo a lo largo de la fila (portrait: ancho; landscape: alto).
 * gapMM = separación entre módulos en la fila.
 */
export function bomAntaiForPanelsSingleRow(
  N: number,
  unitAlongRowMM: number,
  gapMM: number
): AntaiBom {
  const totalPanels = Math.max(0, Math.floor(N));
  if (totalPanels === 0) {
    return {
      total4700: 0,
      total2400: 0,
      totalSplices: 0,
      endClamp: 0,
      midClamp: 0,
      frontLeg: 0,
      rearLeg: 0,
      groundingLug: 0,
      earthingClip: 0,
      cableClip: 0,
    };
  }

  const rowLen =
    totalPanels * unitAlongRowMM +
    Math.max(0, totalPanels - 1) * Math.max(0, gapMM);

  const combo = pickRailsForLength(rowLen, 2);
  const piecesPerRail = combo.n4700 + combo.n2400;

  const total4700 = combo.n4700 * 2; // 2 rieles por fila
  const total2400 = combo.n2400 * 2;
  const totalSplices = Math.max(0, piecesPerRail - 1) * 2; // (piezas−1) × 2 rieles

  // Reglas aproximadas ANTAI
  const endClamp = 4;
  const midClamp = totalPanels >= 2 ? 2 * (totalPanels - 1) : 0;
  const legs = totalPanels <= 4 ? totalPanels : totalPanels + 1;
  const frontLeg = legs;
  const rearLeg = legs;
  const groundingLug = totalPanels <= 4 ? 1 : 2;
  const earthingClip = midClamp;
  const cableClip = totalPanels >= 6 ? totalPanels : 0;

  return {
    total4700,
    total2400,
    totalSplices,
    endClamp,
    midClamp,
    frontLeg,
    rearLeg,
    groundingLug,
    earthingClip,
    cableClip,
  };
}

/**
 * Espaciado entre filas LE–LE (leading-edge a leading-edge) para evitar sombra.
 * orientation: portrait -> L = alto; landscape -> L = ancho.
 * Retorna mm.
 */
export function rowSpacingLEtoLEmm(
  orientation: "portrait" | "landscape",
  panelW: number,
  panelH: number,
  tiltDeg: number,
  sunAltDeg: number,
  extra: number // margen (0–1)
) {
  const Lmm = orientation === "portrait" ? panelH : panelW;
  const tilt = (Math.PI / 180) * tiltDeg;
  const beta = (Math.PI / 180) * sunAltDeg;
  const rise = Lmm * Math.sin(tilt);
  const shadow = rise / Math.tan(beta);
  return Math.max(0, shadow * (1 + extra));
}

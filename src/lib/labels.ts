/**
 * Display labels for the three pool assets and the external numeraire.
 * Pure UI naming layer — does not affect any math.
 */
export interface AssetLabels {
  x: string;
  y: string;
  z: string;
  num: string; // external numeraire name (e.g. "USD")
}

export const defaultLabels: AssetLabels = {
  x: "X",
  y: "Y",
  z: "Z",
  num: "USD",
};

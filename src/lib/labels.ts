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

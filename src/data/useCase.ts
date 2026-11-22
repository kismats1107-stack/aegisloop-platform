import { useEffect, useState } from "react";
import { type CaseData, loadAntakya } from "./antakya";

export function useAntakya() {
  const [data, setData] = useState<CaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadAntakya().then((d) => live && setData(d)).catch((e) => live && setError(String(e.message ?? e)));
    return () => { live = false; };
  }, []);
  return { data, error };
}

export const fmt = (n: number) => n.toLocaleString("en-US");

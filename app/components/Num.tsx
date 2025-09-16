// app/components/Num.tsx
import React from "react";
import { Help } from "./Help";

export type NumProps = {
  label: string;
  value: number;
  setValue: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  help?: string;
};

export function Num({
  label,
  value,
  setValue,
  step = 0.01,
  min,
  max,
  help,
}: NumProps) {
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Si el input queda vacío, mandamos 0 para evitar NaN
    const next = raw === "" ? 0 : Number(raw);
    setValue(next);
  };

  return (
    <div>
      <label className="mb-1 flex items-center text-sm font-medium text-gray-700">
        {label}
        {help && <Help text={help} />}
      </label>
      <input
        type="number"
        className="w-full rounded-md border px-3 py-2"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={onChange}
        title={help}
      />
    </div>
  );
}

export default Num;
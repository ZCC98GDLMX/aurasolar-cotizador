// app/components/Help.tsx
import React from "react";

type HelpProps = { text: string; className?: string };

export const Help: React.FC<HelpProps> = ({ text, className }) => (
  <span className={`relative inline-flex items-center group ${className ?? ""}`}>
    {/* Icono */}
    <span
      aria-label="Ayuda"
      className="ml-2 h-5 w-5 rounded-full border border-gray-300 text-gray-600 flex items-center justify-center text-[10px] cursor-help select-none"
    >
      i
    </span>

    {/* Tooltip */}
    <span
      role="tooltip"
      className="pointer-events-none absolute z-50 hidden group-hover:block -top-3 left-6 w-72 rounded-lg bg-black/80 px-3 py-2 text-xs leading-snug text-white shadow-lg"
    >
      {text}
      <span className="absolute -left-1 top-2 h-2 w-2 rotate-45 bg-black/80" />
    </span>
  </span>
);


"use client";

import { useState } from "react";

interface Props {
  title: string;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}

export default function SectionCard({ title, defaultOpen = true, badge, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-t border-zinc-800 pt-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between group"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 group-hover:text-zinc-400 transition-colors">
            {title}
          </h2>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">
              {badge}
            </span>
          )}
        </div>
        <span className="text-zinc-600 text-xs transition-transform" style={{ transform: open ? "rotate(0)" : "rotate(-90deg)" }}>
          ▼
        </span>
      </button>
      {open && <div className="mt-4">{children}</div>}
    </section>
  );
}

"use client";

export function ShareCardExportHost({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden"
      style={{ zIndex: -2147483648 }}
    >
      {children}
    </div>
  );
}

import { useEffect, useState } from "react";

const shortcuts = [
  { key: "?", description: "Toggle this help" },
  { key: "/", description: "Focus search" },
  { key: "d", description: "Dashboard" },
  { key: "b", description: "Browse recordings" },
  { key: "m", description: "Map" },
  { key: "s", description: "HF Spots" },
  { key: "a", description: "APRS" },
  { key: "w", description: "Waterfall" },
  { divider: true, label: "Player page" },
  { key: "Space", description: "Play / pause" },
  { key: "\u2190 / \u2192", description: "Previous / next recording" },
];

export default function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onToggle() {
      setOpen((v) => !v);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("toggle-shortcuts-help", onToggle);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("toggle-shortcuts-help", onToggle);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Modal */}
      <div
        className="relative bg-gray-800 border border-gray-600 rounded-lg shadow-xl max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="text-gray-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-2">
          {shortcuts.map((item, i) => {
            if ("divider" in item && item.divider) {
              return (
                <div
                  key={i}
                  className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-500 border-t border-gray-700 mt-2"
                >
                  {item.label}
                </div>
              );
            }
            return (
              <div key={i} className="flex items-center justify-between">
                <span className="text-gray-300 text-sm">
                  {item.description}
                </span>
                <kbd className="ml-4 px-2 py-0.5 bg-gray-700 border border-gray-600 rounded text-xs font-mono text-gray-200 shrink-0">
                  {item.key}
                </kbd>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-gray-500 text-center">
          Press <kbd className="px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-xs font-mono">Esc</kbd> or click outside to close
        </p>
      </div>
    </div>
  );
}

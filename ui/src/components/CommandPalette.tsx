import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";

interface PaletteItem {
  label: string;
  sublabel?: string;
  path: string;
  icon?: string;
}

const PAGES: PaletteItem[] = [
  { label: "Dashboard", path: "/", icon: "📊" },
  { label: "Browse Recordings", path: "/browse", icon: "📁" },
  { label: "Map", path: "/map", icon: "🗺" },
  { label: "FT8/WSPR Spots", path: "/spots", icon: "📡" },
  { label: "APRS Stations", path: "/aprs", icon: "📍" },
  { label: "Frequencies", path: "/frequencies", icon: "📻" },
  { label: "Repeaters", path: "/repeaters", icon: "🔁" },
  { label: "Waterfall", path: "/waterfall", icon: "🌊" },
  { label: "Alerts", path: "/alerts", icon: "🔔" },
  { label: "Tags", path: "/tags", icon: "🏷" },
  { label: "Contact Log", path: "/logbook", icon: "📒" },
  { label: "Settings", path: "/settings", icon: "⚙" },
];

function score(query: string, item: PaletteItem): number {
  const q = query.toLowerCase();
  const l = item.label.toLowerCase();
  const s = item.sublabel?.toLowerCase() ?? "";
  if (l === q || s === q) return 100;
  if (l.startsWith(q) || s.startsWith(q)) return 80;
  if (l.includes(q) || s.includes(q)) return 60;
  // fuzzy: all chars in order
  let qi = 0;
  for (const c of l) {
    if (qi < q.length && c === q[qi]) qi++;
  }
  if (qi === q.length) return 40;
  return 0;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const toggle = useCallback(() => {
    setOpen((o) => {
      if (!o) {
        setQuery("");
        setSelectedIdx(0);
      }
      return !o;
    });
  }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, toggle]);

  useEffect(() => {
    // Listen for custom event from keyboard shortcuts
    const handler = () => toggle();
    document.addEventListener("open-command-palette", handler);
    return () => document.removeEventListener("open-command-palette", handler);
  }, [toggle]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Build results
  const results: PaletteItem[] = [];

  if (!query) {
    results.push(...PAGES);
  } else {
    // Check if query looks like a callsign (letters + numbers)
    const callsignPattern = /^[A-Za-z0-9]{3,10}$/;
    const freqPattern = /^[\d.]+$/;
    const q = query.trim();

    // Add matching pages
    const pageMatches = PAGES.map((p) => ({ item: p, s: score(q, p) }))
      .filter((m) => m.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((m) => m.item);
    results.push(...pageMatches);

    // Add callsign jump
    if (callsignPattern.test(q) && q.length >= 3) {
      results.push({
        label: q.toUpperCase(),
        sublabel: "Go to callsign page",
        path: `/callsign/${q.toUpperCase()}`,
        icon: "🔎",
      });
    }

    // Add frequency jump
    if (freqPattern.test(q)) {
      const num = parseFloat(q);
      if (num > 0) {
        const hz = num < 30000 ? Math.round(num * 1_000_000) : Math.round(num);
        const mhz = hz / 1_000_000;
        results.push({
          label: `${mhz.toFixed(6)} MHz`,
          sublabel: "Go to frequency page",
          path: `/frequency/${hz}`,
          icon: "📻",
        });
      }
    }
  }

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  function go(item: PaletteItem) {
    navigate(item.path);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIdx]) {
      go(results[selectedIdx]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div className="fixed inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-700">
          <svg className="w-5 h-5 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, callsigns, frequencies..."
            className="flex-1 bg-transparent text-gray-100 text-sm placeholder-gray-500 outline-none"
          />
          <kbd className="hidden sm:inline text-[10px] text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">
              No results found
            </div>
          )}
          {results.map((item, i) => (
            <button
              key={item.path + item.label}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                i === selectedIdx
                  ? "bg-green-900/40 text-green-300"
                  : "text-gray-300 hover:bg-gray-800"
              }`}
              onClick={() => go(item)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              {item.icon && <span className="text-base w-6 text-center">{item.icon}</span>}
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{item.label}</div>
                {item.sublabel && (
                  <div className="text-xs text-gray-500 truncate">{item.sublabel}</div>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-gray-700 flex items-center gap-4 text-[10px] text-gray-600">
          <span><kbd className="border border-gray-700 rounded px-1">↑↓</kbd> navigate</span>
          <span><kbd className="border border-gray-700 rounded px-1">↵</kbd> open</span>
          <span><kbd className="border border-gray-700 rounded px-1">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

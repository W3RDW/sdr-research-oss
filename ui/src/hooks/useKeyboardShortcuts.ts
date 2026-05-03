import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export function useGlobalShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Don't fire when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;

      switch (e.key) {
        case "?":
          document.dispatchEvent(new CustomEvent("toggle-shortcuts-help"));
          break;
        case "/":
          e.preventDefault();
          document.dispatchEvent(new CustomEvent("open-command-palette"));
          break;
        case "d":
          navigate("/");
          break;
        case "b":
          navigate("/browse");
          break;
        case "m":
          navigate("/map");
          break;
        case "s":
          navigate("/spots");
          break;
        case "a":
          navigate("/aprs");
          break;
        case "w":
          navigate("/waterfall");
          break;
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);
}

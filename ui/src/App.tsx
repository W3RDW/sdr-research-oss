import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import BrowsePage from "./pages/BrowsePage";
import PlayerPage from "./pages/PlayerPage";

// Lazy-loaded pages (heavy deps: Leaflet, Recharts, SVG rendering)
const MapPage = lazy(() => import("./pages/MapPage"));
const SpotsPage = lazy(() => import("./pages/SpotsPage"));
const WaterfallPage = lazy(() => import("./pages/WaterfallPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const FrequencyBrowserPage = lazy(() => import("./pages/FrequencyBrowserPage"));
// RepeaterPage is now embedded as a tab in FrequencyBrowserPage
const AdminPage = lazy(() => import("./pages/AdminPage"));
const APRSPage = lazy(() => import("./pages/APRSPage"));
const CallsignPage = lazy(() => import("./pages/CallsignPage"));
const AlertsPage = lazy(() => import("./pages/AlertsPage"));
const LookupPage = lazy(() => import("./pages/LookupPage"));
// BookmarksPage is now embedded as a tab in FrequencyBrowserPage
const FrequencyPage = lazy(() => import("./pages/FrequencyPage"));
const HFPage = lazy(() => import("./pages/HFPage"));
const SStvPage = lazy(() => import("./pages/SStvPage"));
const LogbookPage = lazy(() => import("./pages/LogbookPage"));
const SatellitePage = lazy(() => import("./pages/SatellitePage"));
const TagsPage = lazy(() => import("./pages/TagsPage"));
const ComparePage = lazy(() => import("./pages/ComparePage"));
const SpectrumPage = lazy(() => import("./pages/SpectrumPage"));
const WeatherPage = lazy(() => import("./pages/WeatherPage"));

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-400" />
    </div>
  );
}

function LazyPage({ Component }: { Component: React.LazyExoticComponent<() => JSX.Element> }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <Component />
      </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<LazyPage Component={DashboardPage} />} />
            <Route path="browse" element={<ErrorBoundary><BrowsePage /></ErrorBoundary>} />
            <Route path="player/:id" element={<ErrorBoundary><PlayerPage /></ErrorBoundary>} />
            <Route path="search" element={<Navigate to="/browse?view=search" replace />} />
            <Route path="repeaters" element={<Navigate to="/frequencies?tab=repeaters" replace />} />
            <Route path="map" element={<LazyPage Component={MapPage} />} />
            <Route path="aprs" element={<LazyPage Component={APRSPage} />} />
            <Route path="hf" element={<LazyPage Component={HFPage} />} />
            <Route path="spots" element={<LazyPage Component={SpotsPage} />} />
            <Route path="sstv" element={<LazyPage Component={SStvPage} />} />
            <Route path="admin" element={<LazyPage Component={AdminPage} />} />
            <Route path="callsign/:callsign" element={<LazyPage Component={CallsignPage} />} />
            <Route path="alerts" element={<LazyPage Component={AlertsPage} />} />
            <Route path="lookup" element={<LazyPage Component={LookupPage} />} />
            <Route path="bookmarks" element={<Navigate to="/frequencies?tab=bookmarks" replace />} />
            <Route path="frequencies" element={<LazyPage Component={FrequencyBrowserPage} />} />
            <Route path="frequency/:hz" element={<LazyPage Component={FrequencyPage} />} />
            <Route path="waterfall" element={<LazyPage Component={WaterfallPage} />} />
            <Route path="logbook" element={<LazyPage Component={LogbookPage} />} />
            <Route path="satellites" element={<LazyPage Component={SatellitePage} />} />
            <Route path="tags" element={<LazyPage Component={TagsPage} />} />
            <Route path="compare" element={<LazyPage Component={ComparePage} />} />
            <Route path="spectrum" element={<LazyPage Component={SpectrumPage} />} />
            <Route path="weather" element={<LazyPage Component={WeatherPage} />} />
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;

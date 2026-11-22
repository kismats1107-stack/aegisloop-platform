import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles/base.css";
import "./styles/site.css";
import { SiteLayout } from "./components/Shell";
import Landing from "./landing/Landing";

const Platform = lazy(() => import("./pages/Platform"));
const CaseAntakya = lazy(() => import("./pages/CaseAntakya"));
const Fleet = lazy(() => import("./pages/Fleet"));
const Responsible = lazy(() => import("./pages/Responsible"));
const Console = lazy(() => import("./console/Console"));
const NotFound = lazy(() => import("./pages/NotFound"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
        <Routes>
          <Route element={<SiteLayout />}>
            <Route index element={<Landing />} />
            <Route path="platform" element={<Platform />} />
            <Route path="cases/antakya-2023" element={<CaseAntakya />} />
            <Route path="fleet" element={<Fleet />} />
            <Route path="responsible-use" element={<Responsible />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="console" element={<Console />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);

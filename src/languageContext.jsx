import React from "react";
import translations from "./translations.js";

export const LanguageCtx = React.createContext({ t: k => k });

export function LanguageProvider({ language, children }) {
  const t = React.useCallback(
    k => (translations[language]?.[k] ?? translations.en[k] ?? k),
    [language]
  );
  return <LanguageCtx.Provider value={{ t }}>{children}</LanguageCtx.Provider>;
}

export const useT = () => React.useContext(LanguageCtx).t;

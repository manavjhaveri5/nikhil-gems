import React from "react";
import translations from "./translations.js";

export const LanguageCtx = React.createContext({ t: k => k, tFmt: (k, vars) => k });

export function LanguageProvider({ language, children }) {
  const t = React.useCallback(
    k => (translations[language]?.[k] ?? translations.en[k] ?? k),
    [language]
  );

  // tFmt("key", { count: 3 }) → replaces {count} in the translated string
  // Supports optional plural: translations key ending in "_one" / "_other"
  const tFmt = React.useCallback((k, vars = {}) => {
    const count = vars.count;
    let key = k;
    if (count !== undefined) {
      const pluralKey = count === 1 ? `${k}_one` : `${k}_other`;
      if (translations[language]?.[pluralKey] || translations.en[pluralKey]) key = pluralKey;
    }
    const str = translations[language]?.[key] ?? translations.en[key] ?? key;
    return str.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
  }, [language]);

  return <LanguageCtx.Provider value={{ t, tFmt }}>{children}</LanguageCtx.Provider>;
}

export const useT = () => React.useContext(LanguageCtx).t;
export const useTFmt = () => React.useContext(LanguageCtx).tFmt;

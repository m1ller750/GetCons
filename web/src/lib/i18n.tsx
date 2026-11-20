import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type Dictionary } from '../i18n/en';
import { ru } from '../i18n/ru';

export type Lang = 'en' | 'ru';
const STORAGE_KEY = 'getcons.lang';
const dictionaries: Record<Lang, Dictionary> = { en, ru };

interface I18nState {
  lang: Lang;
  t: Dictionary;
  setLang: (lang: Lang) => void;
  locale: string;
}

const I18nContext = createContext<I18nState | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'en'; // English by default; one click switches to Russian
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18nState>(
    () => ({
      lang,
      t: dictionaries[lang],
      locale: lang === 'ru' ? 'ru-RU' : 'en-US',
      setLang: (next) => {
        setLangState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* ignore */
        }
      },
    }),
    [lang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

/** Replaces {placeholders} in a translated string. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

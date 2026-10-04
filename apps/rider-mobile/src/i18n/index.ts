import { getLocales } from 'expo-localization';
import { en } from './en';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

/**
 * Launch languages are an open decision (D-L10N). Only English exists.
 * Other locales fall back to English until approved translations are added
 * (machine-written translations are not used).
 */
const catalogs: Record<string, Partial<Messages>> = { en };

let current = 'en';

export function setLocale(tag: string) {
  const language = tag.split('-')[0]!.toLowerCase();
  current = catalogs[language] ? language : 'en';
}

export function detectLocale() {
  try {
    setLocale(getLocales()[0]?.languageTag ?? 'en');
  } catch {
    setLocale('en');
  }
}

export function locale() {
  return current;
}

/** Translate with {name} placeholders. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = catalogs[current]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

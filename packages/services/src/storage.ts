/** Accessing localStorage itself can throw in restricted browser contexts. */
export const storage = {
  getItem(key: string): string | null { return localStorage.getItem(key); },
  setItem(key: string, value: string): void { localStorage.setItem(key, value); },
  removeItem(key: string): void { localStorage.removeItem(key); },
};

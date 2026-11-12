/** Browser storage is deliberately guarded for server rendering and private browsing. */
export const storage = {
  getItem(key: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  },
  removeItem(key: string): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  },
};

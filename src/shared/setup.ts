export interface RevitInventory {
  checkedAt: number;
  years: {
    year: 2025 | 2026;
    executable: 'found' | 'notFound' | 'unavailable';
    addins: {
      scope: 'user' | 'machine';
      status: 'ok' | 'missing' | 'unavailable';
      names: string[];
      truncated: boolean;
    }[];
  }[];
}

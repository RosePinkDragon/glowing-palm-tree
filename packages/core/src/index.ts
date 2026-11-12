export type AppAudience = 'customer' | 'admin';
export type BusinessSlug = 'ammu-sammu' | 'konkan-fine-dine';

export const businesses: Record<BusinessSlug, { name: string; locale: string; currency: string }> = {
  'ammu-sammu': { name: 'Ammu Sammu', locale: 'en-IN', currency: 'INR' },
  'konkan-fine-dine': { name: 'Konkan Fine Dine', locale: 'en-IN', currency: 'INR' },
};

import { defaultsFor } from '../src/core/catalog';
import { nearestColorName, hexToLab } from '../src/core/color';
import type { Category, Item } from '../src/core/types';

let seq = 0;

export function makeItem(category: Category, subtype: string, hex: string, extra: Partial<Item> = {}): Item {
  const d = defaultsFor(category, subtype);
  if (!d) throw new Error(`未知子类 ${category}/${subtype}`);
  seq++;
  const id = extra.id ?? `${category}-${seq}`;
  return {
    id,
    name: extra.name ?? `${nearestColorName(hexToLab(hex)).name}${subtype}`,
    category,
    subtype,
    color: { hex, name: nearestColorName(hexToLab(hex)).name },
    pattern: 'solid',
    seasons: d.seasons,
    warmth: d.warmth,
    occasions: d.occasions,
    styles: d.styles,
    fit: d.fit,
    length: d.length,
    rise: d.rise,
    tags: [],
    favorite: false,
    status: 'active',
    images: { cutout: `${id}-c`, thumb: `${id}-t` },
    imageAspect: 1,
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 1),
    ...extra,
  };
}

import { assertSupabaseConfigured, supabase, supabaseUrl } from '../lib/supabase';
import { Category, Product, ProductVariant } from '../types/database';

export interface CatalogData {
  categories: Category[];
  products: Product[];
}

/**
 * Resolves a product image path strictly from Supabase.
 * Never falls back to Unsplash or hardcoded demo images.
 */
export function resolveProductImagePath(imagePath?: string | null): string | null {
  if (!imagePath || typeof imagePath !== 'string') {
    return null;
  }
  const trimmed = imagePath.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const storageMarker = '/storage/v1/object/public/';
    const markerIdx = trimmed.indexOf(storageMarker);
    if (markerIdx !== -1 && trimmed.includes('.supabase.co')) {
      return `${supabaseUrl}${trimmed.slice(markerIdx)}`;
    }
    return trimmed;
  }
  const { data } = supabase.storage.from('product-images').getPublicUrl(trimmed);
  return data?.publicUrl ?? null;
}

/**
 * Loads categories, products, and product_variants exclusively from Supabase.
 * Throws a real error if Supabase is unconfigured or any table query fails.
 * Never returns demo products or localStorage fallbacks.
 */
export async function fetchCatalogFromSupabase(): Promise<CatalogData> {
  assertSupabaseConfigured();

  const [categoriesRes, productsRes, variantsRes] = await Promise.all([
    supabase.from('categories').select('*').order('sort_order', { ascending: true }),
    supabase.from('products').select('*').order('name', { ascending: true }),
    supabase.from('product_variants').select('*').order('price', { ascending: true }),
  ]);

  if (categoriesRes.error) {
    throw new Error(`Failed to fetch categories from Supabase: ${categoriesRes.error.message}`);
  }
  if (productsRes.error) {
    throw new Error(`Failed to fetch products from Supabase: ${productsRes.error.message}`);
  }
  if (variantsRes.error) {
    throw new Error(
      `Failed to fetch product_variants from Supabase: ${variantsRes.error.message}`
    );
  }

  const rawCategories = (categoriesRes.data ?? []) as Array<Record<string, unknown>>;
  const rawProducts = (productsRes.data ?? []) as Array<Record<string, unknown>>;
  const rawVariants = (variantsRes.data ?? []) as Array<Record<string, unknown>>;

  const categories: Category[] = rawCategories
    .filter((c) => c.is_active !== false && c.active !== false)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      slug: c.slug != null ? String(c.slug) : null,
      description: c.description != null ? String(c.description) : null,
      is_active:
        c.is_active != null
          ? Boolean(c.is_active)
          : c.active != null
            ? Boolean(c.active)
            : true,
      sort_order: typeof c.sort_order === 'number' ? c.sort_order : null,
      created_at: c.created_at != null ? String(c.created_at) : null,
    }));

  const categoryById = new Map<string, Category>();
  for (const cat of categories) {
    categoryById.set(cat.id, cat);
  }

  // First index parent product stock/availability so variants inherit product stock
  // when product_variants does not define separate stock columns.
  const productStockById = new Map<string, { stock: number; inStock: boolean }>();
  for (const p of rawProducts) {
    const pid = String(p.id ?? '');
    const prodStockNum =
      typeof p.stock_quantity === 'number'
        ? p.stock_quantity
        : typeof p.stock === 'number'
          ? p.stock
          : 100;
    const prodInStock =
      typeof p.in_stock === 'boolean' ? p.in_stock : prodStockNum > 0;
    productStockById.set(pid, {
      stock: prodInStock ? Math.max(prodStockNum, 1) : 0,
      inStock: prodInStock,
    });
  }

  const variantsByProductId = new Map<string, ProductVariant[]>();
  for (const v of rawVariants) {
    if (v.is_active === false || v.active === false) {
      continue;
    }
    const productId = String(v.product_id ?? '');
    if (!productId) {
      continue;
    }
    const parentStock = productStockById.get(productId) ?? {
      stock: 100,
      inStock: true,
    };

    const hasOwnStock =
      typeof v.stock === 'number' || typeof v.stock_quantity === 'number';
    const stockNum =
      typeof v.stock === 'number'
        ? v.stock
        : typeof v.stock_quantity === 'number'
          ? v.stock_quantity
          : parentStock.stock;

    const inStockFlag =
      typeof v.in_stock === 'boolean'
        ? v.in_stock
        : hasOwnStock
          ? stockNum > 0
          : parentStock.inStock;

    const basePrice = Number(v.price ?? 0);
    const salePrice =
      v.sale_price != null && Number(v.sale_price) > 0
        ? Number(v.sale_price)
        : null;

    const variant: ProductVariant = {
      id: String(v.id),
      product_id: productId,
      weight: String(v.weight ?? v.label ?? v.size ?? ''),
      label: v.label != null ? String(v.label) : null,
      sku: v.sku != null ? String(v.sku) : null,
      price: salePrice ?? basePrice,
      mrp: salePrice != null ? basePrice : v.mrp != null ? Number(v.mrp) : null,
      stock: Number.isNaN(stockNum) ? 0 : stockNum,
      in_stock: inStockFlag,
      is_active: v.is_active != null ? Boolean(v.is_active) : true,
      sort_order: typeof v.sort_order === 'number' ? v.sort_order : null,
    };

    const existing = variantsByProductId.get(productId) ?? [];
    existing.push(variant);
    variantsByProductId.set(productId, existing);
  }

  const products: Product[] = rawProducts
    .filter((p) => p.is_active !== false && p.active !== false)
    .map((p) => {
      const id = String(p.id);
      const categoryId = p.category_id != null ? String(p.category_id) : null;
      const productVariants = (variantsByProductId.get(id) ?? []).sort(
        (a, b) => a.price - b.price
      );
      const parentStock = productStockById.get(id) ?? { stock: 0, inStock: false };
      const hasVariantInStock = productVariants.some((v) => v.in_stock && v.stock > 0);
      const productInStock =
        parentStock.inStock && (productVariants.length === 0 || hasVariantInStock);

      return {
        id,
        category_id: categoryId,
        name: String(p.name ?? ''),
        slug: p.slug != null ? String(p.slug) : null,
        description:
          p.description != null
            ? String(p.description)
            : p.short_description != null
              ? String(p.short_description)
              : null,
        image_path: resolveProductImagePath(
          p.image_path != null ? String(p.image_path) : null
        ),
        is_active: p.is_active != null ? Boolean(p.is_active) : true,
        is_featured: p.is_featured != null ? Boolean(p.is_featured) : false,
        in_stock: productInStock,
        created_at: p.created_at != null ? String(p.created_at) : null,
        category: categoryId ? categoryById.get(categoryId) ?? null : null,
        variants: productVariants,
      };
    });

  return {
    categories,
    products,
  };
}

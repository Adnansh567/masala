import { assertSupabaseConfigured, supabase } from '../lib/supabase';
import { CartItemView, GuestCartStorageItem, Product } from '../types/database';
import { getVerifiedSupabaseUser } from './authService';
import { resolveProductImagePath } from './catalogService';

export const GUEST_CART_STORAGE_KEY = 'kbr_guest_cart';

export function readGuestCartFromStorage(): GuestCartStorageItem[] {
  try {
    const raw = window.localStorage.getItem(GUEST_CART_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.productId === 'string' &&
          typeof item.variantId === 'string' &&
          typeof item.quantity === 'number' &&
          item.quantity > 0
      )
      .map((item) => ({
        productId: String(item.productId),
        variantId: String(item.variantId),
        quantity: Math.floor(Number(item.quantity)),
      }));
  } catch {
    return [];
  }
}

export function writeGuestCartToStorage(items: GuestCartStorageItem[]): void {
  if (items.length === 0) {
    window.localStorage.removeItem(GUEST_CART_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify(items));
}

export function clearGuestCartStorage(): void {
  window.localStorage.removeItem(GUEST_CART_STORAGE_KEY);
}

/**
 * Resolves or creates the active cart in Supabase `carts` for the verified user.
 */
async function getOrCreateActiveCartId(userId: string): Promise<string> {
  assertSupabaseConfigured();

  const { data: existingCarts, error: selectError } = await supabase
    .from('carts')
    .select('id, user_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (selectError) {
    throw new Error(`Failed to fetch user cart from Supabase: ${selectError.message}`);
  }

  if (existingCarts && existingCarts.length > 0 && existingCarts[0].id) {
    return String(existingCarts[0].id);
  }

  const { data: insertedCart, error: insertError } = await supabase
    .from('carts')
    .insert({ user_id: userId })
    .select('id')
    .single();

  if (insertError || !insertedCart) {
    throw new Error(
      `Failed to create user cart in Supabase: ${insertError?.message ?? 'Unknown error'}`
    );
  }

  return String(insertedCart.id);
}

/**
 * Hydrates raw `{ id, productId, variantId, quantity }` rows with live product/variant data from Supabase.
 */
async function hydrateCartItemsFromSupabase(
  rawItems: Array<{ id: string; productId: string; variantId: string; quantity: number }>,
  catalogProducts?: Product[]
): Promise<CartItemView[]> {
  if (rawItems.length === 0) {
    return [];
  }

  // If catalogProducts are already loaded from Supabase, use them; otherwise query Supabase directly.
  const productMap = new Map<string, Product>();
  if (catalogProducts && catalogProducts.length > 0) {
    for (const p of catalogProducts) {
      productMap.set(p.id, p);
    }
  }

  const missingProductIds = Array.from(
    new Set(rawItems.map((i) => i.productId).filter((pid) => !productMap.has(pid)))
  );

  if (missingProductIds.length > 0) {
    assertSupabaseConfigured();
    const [prodRes, varRes] = await Promise.all([
      supabase.from('products').select('*').in('id', missingProductIds),
      supabase.from('product_variants').select('*').in('product_id', missingProductIds),
    ]);

    if (prodRes.error) {
      throw new Error(`Failed to load cart product details: ${prodRes.error.message}`);
    }
    if (varRes.error) {
      throw new Error(`Failed to load cart variant details: ${varRes.error.message}`);
    }

    const variantsByProd = new Map<string, Product['variants']>();
    for (const v of (varRes.data ?? []) as Array<Record<string, unknown>>) {
      const pid = String(v.product_id ?? '');
      const stockNum =
        typeof v.stock === 'number'
          ? v.stock
          : typeof v.stock_quantity === 'number'
            ? v.stock_quantity
            : Number(v.stock ?? 0);
      const list = variantsByProd.get(pid) ?? [];
      list.push({
        id: String(v.id),
        product_id: pid,
        weight: String(v.weight ?? v.label ?? ''),
        label: v.label != null ? String(v.label) : null,
        sku: v.sku != null ? String(v.sku) : null,
        price: Number(v.price ?? 0),
        mrp: v.mrp != null ? Number(v.mrp) : null,
        stock: Number.isNaN(stockNum) ? 0 : stockNum,
        in_stock: typeof v.in_stock === 'boolean' ? v.in_stock : stockNum > 0,
      });
      variantsByProd.set(pid, list);
    }

    for (const p of (prodRes.data ?? []) as Array<Record<string, unknown>>) {
      const pid = String(p.id);
      const vars = variantsByProd.get(pid) ?? [];
      productMap.set(pid, {
        id: pid,
        category_id: p.category_id != null ? String(p.category_id) : null,
        name: String(p.name ?? ''),
        image_path: resolveProductImagePath(p.image_path != null ? String(p.image_path) : null),
        in_stock: typeof p.in_stock === 'boolean' ? p.in_stock : vars.some((v) => v.in_stock),
        variants: vars,
      });
    }
  }

  const hydrated: CartItemView[] = [];
  for (const row of rawItems) {
    const product = productMap.get(row.productId);
    if (!product) continue;
    const variant =
      product.variants.find((v) => v.id === row.variantId) ?? product.variants[0];
    if (!variant) continue;

    hydrated.push({
      id: row.id,
      cartItemId: `${row.productId}:${variant.id}`,
      productId: product.id,
      variantId: variant.id,
      name: product.name,
      weight: variant.weight,
      price: variant.price,
      stock: variant.stock,
      inStock: product.in_stock && variant.in_stock,
      imagePath: product.image_path ?? null,
      qty: row.quantity,
    });
  }

  return hydrated;
}

/**
 * Loads the cart.
 * Always calls `supabase.auth.getUser()` first to determine whether the caller is authenticated or a guest.
 * Authenticated users use ONLY Supabase `carts` and `cart_items`.
 */
export async function loadActiveCart(catalogProducts?: Product[]): Promise<CartItemView[]> {
  assertSupabaseConfigured();
  const user = await getVerifiedSupabaseUser();

  if (!user) {
    const guestItems = readGuestCartFromStorage();
    return hydrateCartItemsFromSupabase(
      guestItems.map((g) => ({
        id: `guest:${g.productId}:${g.variantId}`,
        productId: g.productId,
        variantId: g.variantId,
        quantity: g.quantity,
      })),
      catalogProducts
    );
  }

  const cartId = await getOrCreateActiveCartId(user.id);
  const { data: itemRows, error } = await supabase
    .from('cart_items')
    .select('id, cart_id, product_id, variant_id, quantity')
    .eq('cart_id', cartId)
    .order('id', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch cart items from Supabase: ${error.message}`);
  }

  const normalized = ((itemRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    variantId: String(row.variant_id),
    quantity: Number(row.quantity ?? 1),
  }));

  return hydrateCartItemsFromSupabase(normalized, catalogProducts);
}

/**
 * Adds an item to the cart.
 * Verifies the session with `supabase.auth.getUser()` first.
 * Never writes authenticated cart items to localStorage.
 */
export async function addCartItem(
  productId: string,
  variantId: string,
  quantityToAdd = 1,
  catalogProducts?: Product[]
): Promise<CartItemView[]> {
  assertSupabaseConfigured();
  const user = await getVerifiedSupabaseUser();

  if (!user) {
    const guestItems = readGuestCartFromStorage();
    const existing = guestItems.find(
      (i) => i.productId === productId && i.variantId === variantId
    );
    if (existing) {
      existing.quantity += quantityToAdd;
    } else {
      guestItems.push({ productId, variantId, quantity: quantityToAdd });
    }
    writeGuestCartToStorage(guestItems);
    return loadActiveCart(catalogProducts);
  }

  const cartId = await getOrCreateActiveCartId(user.id);

  const { data: existingRow, error: findError } = await supabase
    .from('cart_items')
    .select('id, quantity')
    .eq('cart_id', cartId)
    .eq('product_id', productId)
    .eq('variant_id', variantId)
    .maybeSingle();

  if (findError && findError.code !== 'PGRST116') {
    throw new Error(`Failed to check existing cart item in Supabase: ${findError.message}`);
  }

  if (existingRow && existingRow.id) {
    const nextQty = Number(existingRow.quantity ?? 0) + quantityToAdd;
    const { error: updateError } = await supabase
      .from('cart_items')
      .update({ quantity: nextQty })
      .eq('id', existingRow.id)
      .eq('cart_id', cartId);

    if (updateError) {
      throw new Error(`Failed to update cart item in Supabase: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await supabase.from('cart_items').insert({
      cart_id: cartId,
      product_id: productId,
      variant_id: variantId,
      quantity: quantityToAdd,
    });

    if (insertError) {
      throw new Error(`Failed to add item to Supabase cart: ${insertError.message}`);
    }
  }

  return loadActiveCart(catalogProducts);
}

/**
 * Updates quantity of an item in the cart (or removes it if nextQuantity <= 0).
 * Verifies the session with `supabase.auth.getUser()` first.
 */
export async function updateCartItemQuantity(
  item: CartItemView,
  delta: number,
  catalogProducts?: Product[]
): Promise<CartItemView[]> {
  assertSupabaseConfigured();
  const user = await getVerifiedSupabaseUser();
  const nextQty = item.qty + delta;

  if (!user) {
    const guestItems = readGuestCartFromStorage();
    const updated = guestItems
      .map((g) =>
        g.productId === item.productId && g.variantId === item.variantId
          ? { ...g, quantity: nextQty }
          : g
      )
      .filter((g) => g.quantity > 0);
    writeGuestCartToStorage(updated);
    return loadActiveCart(catalogProducts);
  }

  const cartId = await getOrCreateActiveCartId(user.id);

  if (nextQty <= 0) {
    const { error: deleteError } = await supabase
      .from('cart_items')
      .delete()
      .eq('id', item.id)
      .eq('cart_id', cartId);

    if (deleteError) {
      throw new Error(`Failed to remove item from Supabase cart: ${deleteError.message}`);
    }
  } else {
    const { error: updateError } = await supabase
      .from('cart_items')
      .update({ quantity: nextQty })
      .eq('id', item.id)
      .eq('cart_id', cartId);

    if (updateError) {
      throw new Error(`Failed to update item quantity in Supabase cart: ${updateError.message}`);
    }
  }

  return loadActiveCart(catalogProducts);
}

/**
 * Removes an item from the cart.
 * Verifies the session with `supabase.auth.getUser()` first.
 */
export async function removeCartItem(
  item: CartItemView,
  catalogProducts?: Product[]
): Promise<CartItemView[]> {
  assertSupabaseConfigured();
  const user = await getVerifiedSupabaseUser();

  if (!user) {
    const guestItems = readGuestCartFromStorage().filter(
      (g) => !(g.productId === item.productId && g.variantId === item.variantId)
    );
    writeGuestCartToStorage(guestItems);
    return loadActiveCart(catalogProducts);
  }

  const cartId = await getOrCreateActiveCartId(user.id);
  const { error } = await supabase
    .from('cart_items')
    .delete()
    .eq('id', item.id)
    .eq('cart_id', cartId);

  if (error) {
    throw new Error(`Failed to remove item from Supabase cart: ${error.message}`);
  }

  return loadActiveCart(catalogProducts);
}

/**
 * Clears all items from the cart.
 * Verifies the session with `supabase.auth.getUser()` first.
 */
export async function clearActiveCart(): Promise<void> {
  assertSupabaseConfigured();
  const user = await getVerifiedSupabaseUser();

  if (!user) {
    clearGuestCartStorage();
    return;
  }

  const cartId = await getOrCreateActiveCartId(user.id);
  const { error } = await supabase.from('cart_items').delete().eq('cart_id', cartId);

  if (error) {
    throw new Error(`Failed to clear Supabase cart: ${error.message}`);
  }
}

/**
 * Merges temporary guest localStorage cart items into the authenticated user's Supabase cart on login,
 * and clears the guest localStorage cart after a successful merge.
 */
export async function mergeGuestCartIntoSupabaseOnLogin(): Promise<void> {
  assertSupabaseConfigured();
  const user = await getVerifiedSupabaseUser();
  if (!user) {
    return;
  }

  const guestItems = readGuestCartFromStorage();
  if (guestItems.length === 0) {
    return;
  }

  const cartId = await getOrCreateActiveCartId(user.id);

  const { data: existingRows, error: fetchError } = await supabase
    .from('cart_items')
    .select('id, product_id, variant_id, quantity')
    .eq('cart_id', cartId);

  if (fetchError) {
    throw new Error(`Failed to fetch existing Supabase cart for merge: ${fetchError.message}`);
  }

  const existingMap = new Map<string, { id: string; quantity: number }>();
  for (const row of (existingRows ?? []) as Array<Record<string, unknown>>) {
    const key = `${String(row.product_id)}:${String(row.variant_id)}`;
    existingMap.set(key, {
      id: String(row.id),
      quantity: Number(row.quantity ?? 0),
    });
  }

  for (const guestItem of guestItems) {
    const key = `${guestItem.productId}:${guestItem.variantId}`;
    const match = existingMap.get(key);
    if (match) {
      const { error: updateErr } = await supabase
        .from('cart_items')
        .update({ quantity: match.quantity + guestItem.quantity })
        .eq('id', match.id)
        .eq('cart_id', cartId);
      if (updateErr) {
        throw new Error(`Failed to merge guest cart item into Supabase: ${updateErr.message}`);
      }
    } else {
      const { error: insertErr } = await supabase.from('cart_items').insert({
        cart_id: cartId,
        product_id: guestItem.productId,
        variant_id: guestItem.variantId,
        quantity: guestItem.quantity,
      });
      if (insertErr) {
        throw new Error(`Failed to insert guest cart item into Supabase: ${insertErr.message}`);
      }
    }
  }

  // Clear guest localStorage cart ONLY after all items have been merged into Supabase
  clearGuestCartStorage();
}

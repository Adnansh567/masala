export interface Category {
  id: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  active?: boolean | null;
  is_active?: boolean | null;
  sort_order?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  weight: string;
  label?: string | null;
  sku?: string | null;
  price: number;
  sale_price?: number | null;
  mrp?: number | null;
  stock: number;
  in_stock: boolean;
  is_active?: boolean | null;
  sort_order?: number | null;
  created_at?: string | null;
}

export interface Product {
  id: string;
  category_id?: string | null;
  sku?: string | null;
  name: string;
  slug?: string | null;
  description?: string | null;
  short_description?: string | null;
  image_path?: string | null;
  stock_quantity?: number | null;
  is_active?: boolean | null;
  is_featured?: boolean | null;
  in_stock: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  category?: Category | null;
  variants: ProductVariant[];
}

export interface UserProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  role: string | null;
  created_at?: string | null;
}

export interface UserRoleRow {
  id?: string;
  user_id: string;
  role: string;
}

export interface CartRow {
  id: string;
  user_id: string;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CartItemRow {
  id: string;
  cart_id: string;
  product_id: string;
  variant_id: string;
  quantity: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface GuestCartStorageItem {
  productId: string;
  variantId: string;
  quantity: number;
}

export interface CartItemView {
  id: string;
  cartItemId: string;
  productId: string;
  variantId: string;
  name: string;
  weight: string;
  price: number;
  stock: number;
  inStock: boolean;
  imagePath: string | null;
  qty: number;
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase, supabaseConfigError } from './lib/supabase';
import {
  fetchUserProfileAndRoles,
  getSupabaseSession,
  getVerifiedSupabaseUser,
  signInWithSupabase,
  signOutFromSupabase,
  signUpWithSupabase,
} from './services/authService';
import {
  fetchCatalogFromSupabase,
  updateProductStockInSupabase,
} from './services/catalogService';
import {
  addCartItem,
  clearActiveCart,
  loadActiveCart,
  mergeGuestCartIntoSupabaseOnLogin,
  removeCartItem,
  updateCartItemQuantity,
} from './services/cartService';
import { CartItemView, Category, Product, UserProfile } from './types/database';

type PageId =
  | 'home'
  | 'products'
  | 'cart'
  | 'checkout'
  | 'orders'
  | 'wishlist'
  | 'services'
  | 'reviews'
  | 'about'
  | 'privacy'
  | 'return'
  | 'admin';

type AdminTab = 'orders' | 'users' | 'products' | 'queries' | 'reviews';

export default function App() {
  // Navigation State
  const [activePage, setActivePage] = useState<PageId>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeAdminTab, setActiveAdminTab] = useState<AdminTab>('products');

  // Phase 1 & Global Error / Notice State
  const [backendError, setBackendError] = useState<string | null>(supabaseConfigError);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Phase 2 — Supabase Auth State (Single source of truth: supabase.auth + profiles/user_roles)
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);

  // Auth Modals (Customer Auth Modal & Admin Portal Modal)
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authFullName, setAuthFullName] = useState('');
  const [authPhone, setAuthPhone] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authModalError, setAuthModalError] = useState<string | null>(null);
  const [pendingProtectedPage, setPendingProtectedPage] = useState<PageId | null>(null);

  const [adminModalOpen, setAdminModalOpen] = useState<boolean>(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminModalError, setAdminModalError] = useState<string | null>(null);
  const [adminSubmitting, setAdminSubmitting] = useState(false);

  // Phase 3 — Catalog State (Single source of truth: Supabase categories, products, product_variants)
  const [catalogLoading, setCatalogLoading] = useState<boolean>(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [selectedVariantByProduct, setSelectedVariantByProduct] = useState<Record<string, string>>(
    {}
  );

  // Phase 4 — Cart State (Authenticated: Supabase carts/cart_items only; Guest: localStorage merged on login)
  const [cartItems, setCartItems] = useState<CartItemView[]>([]);
  const [cartLoading, setCartLoading] = useState<boolean>(false);
  const [cartError, setCartError] = useState<string | null>(null);

  // Guest Wishlist persisted in localStorage
  const [wishlistIds, setWishlistIds] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('kbr_guest_wishlist');
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
    } catch {
      return [];
    }
  });

  // Checkout UI state
  const [paymentMethod, setPaymentMethod] = useState<'COD' | 'ONLINE'>('COD');

  const showNotice = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3500);
  }, []);

  // Load Catalog from Supabase (Phase 3)
  const loadCatalog = useCallback(async (): Promise<Product[]> => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const data = await fetchCatalogFromSupabase();
      setCategories(data.categories);
      setProducts(data.products);
      setBackendError(null);

      setSelectedVariantByProduct((prev) => {
        const next = { ...prev };
        for (const p of data.products) {
          if (!next[p.id] && p.variants.length > 0) {
            const preferred =
              p.variants.find((v) => v.weight === '100g') ?? p.variants[0];
            if (preferred) {
              next[p.id] = preferred.id;
            }
          }
        }
        return next;
      });

      return data.products;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load catalog from Supabase.';
      setCatalogError(message);
      setBackendError(message);
      setCategories([]);
      setProducts([]);
      return [];
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  // Load Cart (Phase 4)
  const refreshCart = useCallback(
    async (loadedProducts?: Product[]) => {
      setCartLoading(true);
      setCartError(null);
      try {
        const items = await loadActiveCart(loadedProducts ?? products);
        setCartItems(items);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load cart from Supabase.';
        setCartError(message);
      } finally {
        setCartLoading(false);
      }
    },
    [products]
  );

  // Synchronize Auth Session + Profile/Roles + Guest Cart Merge (Phases 2 & 4)
  const syncAuthAndData = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setAuthLoading(false);
      setCatalogLoading(false);
      setBackendError(supabaseConfigError);
      return;
    }

    setAuthLoading(true);
    try {
      const [session, verifiedUser, loadedProducts] = await Promise.all([
        getSupabaseSession(),
        getVerifiedSupabaseUser(),
        loadCatalog(),
      ]);

      const activeUser = verifiedUser ?? session?.user ?? null;

      if (activeUser) {
        setCurrentUser(activeUser);
        const { profile, isAdmin: adminVerified } = await fetchUserProfileAndRoles(
          activeUser
        );
        setUserProfile(profile);
        setIsAdmin(adminVerified);

        // Merge any guest cart in localStorage into Supabase cart and clear guest localStorage
        await mergeGuestCartIntoSupabaseOnLogin();
      } else {
        setCurrentUser(null);
        setUserProfile(null);
        setIsAdmin(false);
      }

      await refreshCart(loadedProducts);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to verify Supabase session.';
      setBackendError(message);
    } finally {
      setAuthLoading(false);
    }
  }, [loadCatalog, refreshCart]);

  useEffect(() => {
    void syncAuthAndData();

    if (!isSupabaseConfigured) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        event === 'INITIAL_SESSION' ||
        event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT' ||
        event === 'TOKEN_REFRESHED' ||
        event === 'USER_UPDATED'
      ) {
        void (async () => {
          try {
            const verifiedUser = session?.user
              ? (await getVerifiedSupabaseUser()) ?? session.user
              : null;
            if (verifiedUser) {
              setCurrentUser(verifiedUser);
              const { profile, isAdmin: adminVerified } =
                await fetchUserProfileAndRoles(verifiedUser);
              setUserProfile(profile);
              setIsAdmin(adminVerified);
              if (event === 'SIGNED_IN') {
                await mergeGuestCartIntoSupabaseOnLogin();
              }
            } else {
              setCurrentUser(null);
              setUserProfile(null);
              setIsAdmin(false);
              setActivePage((prev) =>
                prev === 'admin' || prev === 'orders' || prev === 'checkout'
                  ? 'home'
                  : prev
              );
            }
            await refreshCart();
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Supabase Auth sync error.';
            setBackendError(message);
          }
        })();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [syncAuthAndData, refreshCart]);

  const showPage = (pageId: PageId) => {
    if (pageId === 'admin' && !isAdmin) {
      setAdminModalError(null);
      setAdminModalOpen(true);
      return;
    }
    if ((pageId === 'orders' || pageId === 'checkout') && !currentUser) {
      setPendingProtectedPage(pageId);
      setAuthModalError(null);
      setAuthMode('signin');
      setAuthModalOpen(true);
      setMobileMenuOpen(false);
      return;
    }
    setActivePage(pageId);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Customer Login / Sign Up Handler (Phase 2)
  const handleCustomerAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthModalError(null);
    setAuthSubmitting(true);

    try {
      if (authMode === 'signin') {
        const result = await signInWithSupabase(authEmail, authPassword);
        setCurrentUser(result.user);
        setUserProfile(result.profile);
        setIsAdmin(result.isAdmin);
        await mergeGuestCartIntoSupabaseOnLogin();
        await refreshCart();
        setAuthModalOpen(false);
        setAuthPassword('');
        if (pendingProtectedPage) {
          setActivePage(pendingProtectedPage);
          setPendingProtectedPage(null);
        }
        showNotice('Signed in successfully.');
      } else {
        const result = await signUpWithSupabase({
          email: authEmail,
          password: authPassword,
          fullName: authFullName,
          phone: authPhone,
        });
        if (result.sessionCreated && result.user) {
          const { profile, isAdmin: adminFlag } = await fetchUserProfileAndRoles(
            result.user
          );
          setCurrentUser(result.user);
          setUserProfile(profile);
          setIsAdmin(adminFlag);
          await mergeGuestCartIntoSupabaseOnLogin();
          await refreshCart();
          setAuthModalOpen(false);
          setAuthPassword('');
          if (pendingProtectedPage) {
            setActivePage(pendingProtectedPage);
            setPendingProtectedPage(null);
          }
          showNotice('Account created and signed in.');
        } else {
          setAuthMode('signin');
          showNotice(
            'Account created! Please check your email to confirm your account before signing in.'
          );
        }
      }
    } catch (err) {
      setAuthModalError(
        err instanceof Error ? err.message : 'Authentication failed.'
      );
    } finally {
      setAuthSubmitting(false);
    }
  };

  // Admin Portal Access Handler (Phase 2 — Verified strictly via Supabase Auth + profiles/user_roles RLS)
  const openAdminPortal = async () => {
    setAdminModalError(null);
    try {
      const verifiedUser = await getVerifiedSupabaseUser();
      if (verifiedUser) {
        const { profile, isAdmin: verifiedAdmin } = await fetchUserProfileAndRoles(
          verifiedUser
        );
        setCurrentUser(verifiedUser);
        setUserProfile(profile);
        setIsAdmin(verifiedAdmin);

        if (verifiedAdmin) {
          setActivePage('admin');
          return;
        }
        setAdminModalError(
          'Access Denied: Your authenticated Supabase account does not have the admin role in user_roles/profiles.'
        );
      }
      setAdminModalOpen(true);
    } catch (err) {
      setAdminModalError(
        err instanceof Error ? err.message : 'Failed to verify admin access with Supabase.'
      );
      setAdminModalOpen(true);
    }
  };

  const handleAdminLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminModalError(null);
    setAdminSubmitting(true);

    try {
      const result = await signInWithSupabase(adminEmail, adminPassword);
      setCurrentUser(result.user);
      setUserProfile(result.profile);
      setIsAdmin(result.isAdmin);

      await mergeGuestCartIntoSupabaseOnLogin();
      await refreshCart();

      if (!result.isAdmin) {
        throw new Error(
          'Access Denied: Authenticated user is not assigned an admin role in Supabase (user_roles / profiles).'
        );
      }

      setAdminPassword('');
      setAdminModalOpen(false);
      setActivePage('admin');
    } catch (err) {
      setAdminModalError(
        err instanceof Error ? err.message : 'Admin authentication failed.'
      );
    } finally {
      setAdminSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOutFromSupabase();
      setCurrentUser(null);
      setUserProfile(null);
      setIsAdmin(false);
      if (
        activePage === 'admin' ||
        activePage === 'orders' ||
        activePage === 'checkout'
      ) {
        setActivePage('home');
      }
      await refreshCart();
      showNotice('Signed out.');
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : 'Sign out failed.');
    }
  };

  // Phase 4 Cart Operations (Always verified via supabase.auth.getUser() inside cartService)
  const handleAddToCart = async (product: Product) => {
    const selectedVariantId =
      selectedVariantByProduct[product.id] ?? product.variants[0]?.id;
    const variant =
      product.variants.find((v) => v.id === selectedVariantId) ?? product.variants[0];

    if (!variant) {
      showNotice('No variant available for this product.');
      return;
    }

    if (!product.in_stock || !variant.in_stock || variant.stock <= 0) {
      showNotice('Sorry, this variant is currently out of stock.');
      return;
    }

    try {
      setCartError(null);
      const updated = await addCartItem(product.id, variant.id, 1, products);
      setCartItems(updated);
      showNotice(`${product.name} (${variant.weight}) added to cart!`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to add item to cart.';
      setCartError(message);
      setBackendError(message);
    }
  };

  const handleUpdateCartQty = async (item: CartItemView, delta: number) => {
    try {
      setCartError(null);
      const updated = await updateCartItemQuantity(item, delta, products);
      setCartItems(updated);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update cart quantity.';
      setCartError(message);
      setBackendError(message);
    }
  };

  const handleRemoveFromCart = async (item: CartItemView) => {
    try {
      setCartError(null);
      const updated = await removeCartItem(item, products);
      setCartItems(updated);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to remove item from cart.';
      setCartError(message);
      setBackendError(message);
    }
  };

  const handleClearCart = async () => {
    try {
      setCartError(null);
      await clearActiveCart();
      setCartItems([]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to clear cart.';
      setCartError(message);
      setBackendError(message);
    }
  };

  const toggleWishlist = (productId: string) => {
    setWishlistIds((prev) => {
      const next = prev.includes(productId)
        ? prev.filter((id) => id !== productId)
        : [...prev, productId];
      try {
        if (next.length === 0) {
          window.localStorage.removeItem('kbr_guest_wishlist');
        } else {
          window.localStorage.setItem('kbr_guest_wishlist', JSON.stringify(next));
        }
      } catch {
        // Ignore storage errors
      }
      showNotice(
        prev.includes(productId) ? 'Removed from Wishlist.' : 'Added to Wishlist.'
      );
      return next;
    });
  };

  const handleToggleProductStock = async (product: Product) => {
    try {
      await updateProductStockInSupabase(product.id, !product.in_stock);
      await loadCatalog();
      showNotice(
        `${product.name} marked as ${!product.in_stock ? 'In Stock' : 'Out of Stock'} in Supabase.`
      );
    } catch (err) {
      setBackendError(
        err instanceof Error ? err.message : 'Failed to update product stock in Supabase.'
      );
    }
  };

  const filteredProducts = useMemo(() => {
    if (selectedCategoryId === 'all') {
      return products;
    }
    return products.filter((p) => p.category_id === selectedCategoryId);
  }, [products, selectedCategoryId]);

  const featuredProducts = useMemo(() => {
    const explicitlyFeatured = products.filter((p) => p.is_featured);
    return explicitlyFeatured.length > 0 ? explicitlyFeatured : products;
  }, [products]);

  const wishlistProducts = useMemo(
    () => products.filter((p) => wishlistIds.includes(p.id)),
    [products, wishlistIds]
  );

  const totalCartCount = useMemo(
    () => cartItems.reduce((acc, item) => acc + item.qty, 0),
    [cartItems]
  );

  const cartSubtotal = useMemo(
    () => cartItems.reduce((acc, item) => acc + item.price * item.qty, 0),
    [cartItems]
  );

  const cartShipping = cartSubtotal >= 500 || cartSubtotal === 0 ? 0 : 40;

  const userDisplayLabel = useMemo(() => {
    if (!currentUser) return null;
    if (userProfile?.full_name) return userProfile.full_name;
    if (currentUser.email) return currentUser.email.split('@')[0];
    return 'Account';
  }, [currentUser, userProfile]);

  const renderProductGrid = (items: Product[]) => {
    if (catalogLoading) {
      return (
        <div className="col-span-full py-16 text-center text-gray-600 font-medium">
          <i className="fa-solid fa-spinner fa-spin text-amber-700 text-2xl mb-3"></i>
          <p className="text-sm">Loading catalog from Supabase...</p>
        </div>
      );
    }

    if (catalogError) {
      return (
        <div className="col-span-full bg-red-50 border border-red-300 rounded-2xl p-6 text-center">
          <p className="text-red-800 font-bold text-sm mb-1">
            Unable to load catalog from Supabase
          </p>
          <p className="text-xs text-red-700 mb-4">{catalogError}</p>
          <button
            type="button"
            onClick={() => void loadCatalog()}
            className="bg-red-800 hover:bg-red-900 text-white font-bold text-xs px-4 py-2 rounded-xl transition"
          >
            Retry Loading Catalog
          </button>
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="col-span-full bg-white border border-amber-200 rounded-2xl p-12 text-center text-gray-500">
          <i className="fa-solid fa-mortar-pestle text-3xl text-amber-700/60 mb-3"></i>
          <p className="font-bold text-royal-950 text-base">No products found in the catalog</p>
          <p className="text-xs text-gray-500 mt-1">
            Products will appear here once added to the Supabase catalog tables.
          </p>
        </div>
      );
    }

    return items.map((product) => {
      const selectedVariantId =
        selectedVariantByProduct[product.id] ?? product.variants[0]?.id ?? '';
      const activeVariant =
        product.variants.find((v) => v.id === selectedVariantId) ??
        product.variants[0] ??
        null;
      const isAvailable =
        product.in_stock &&
        Boolean(activeVariant && activeVariant.in_stock && activeVariant.stock > 0);

      return (
        <div
          key={product.id}
          className="bg-white rounded-2xl shadow-md border border-amber-200/80 overflow-hidden flex flex-col justify-between hover:shadow-xl transition"
        >
          <div className="relative h-48 w-full bg-amber-50 flex items-center justify-center overflow-hidden">
            {product.image_path ? (
              <img
                src={product.image_path}
                alt={product.name}
                className="h-48 w-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center justify-center text-amber-800/50 p-4 text-center">
                <i className="fa-solid fa-mortar-pestle text-4xl mb-2"></i>
                <span className="text-[11px] font-semibold">No product image</span>
              </div>
            )}
            <span
              className={`absolute top-3 left-3 ${
                isAvailable ? 'bg-amber-500 text-royal-950' : 'bg-red-600 text-white'
              } font-extrabold text-[10px] px-2.5 py-1 rounded-full uppercase`}
            >
              {isAvailable ? 'In Stock' : 'Out of Stock'}
            </span>
            {product.category?.name && (
              <span className="absolute top-3 right-3 bg-royal-950/85 text-amber-300 font-bold text-[10px] px-2.5 py-1 rounded-full">
                {product.category.name}
              </span>
            )}
          </div>

          <div className="p-5 flex-grow flex flex-col justify-between">
            <div>
              <h4 className="font-bold text-royal-950 text-base">{product.name}</h4>
              {product.description && (
                <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                  {product.description}
                </p>
              )}

              {product.variants.length > 0 ? (
                <div className="mt-3">
                  <label className="block text-[11px] font-bold text-gray-500 uppercase mb-1">
                    Select Weight:
                  </label>
                  <select
                    value={activeVariant?.id ?? ''}
                    onChange={(e) =>
                      setSelectedVariantByProduct((prev) => ({
                        ...prev,
                        [product.id]: e.target.value,
                      }))
                    }
                    className="w-full bg-amber-50/60 border border-amber-300 text-xs font-semibold py-2 px-3 rounded-xl focus:outline-none"
                  >
                    {product.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.weight} - ₹{v.price}
                        {!v.in_stock || v.stock <= 0 ? ' (Out of stock)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p className="text-xs text-red-700 font-semibold mt-3">
                  No variants configured in Supabase
                </p>
              )}

              <p className="text-2xl font-extrabold text-red-900 mt-3">
                {activeVariant ? `₹${activeVariant.price}` : '—'}
              </p>
            </div>

            <div className="mt-4 flex space-x-2">
              <button
                type="button"
                disabled={!isAvailable}
                onClick={() => void handleAddToCart(product)}
                className={
                  !isAvailable
                    ? 'flex-1 bg-gray-400 text-white font-bold py-2.5 rounded-xl text-xs cursor-not-allowed'
                    : 'flex-1 bg-amber-800 hover:bg-amber-900 text-white font-bold py-2.5 rounded-xl text-xs shadow-md transition'
                }
              >
                {isAvailable ? (
                  <>
                    <i className="fa-solid fa-cart-plus mr-1"></i> Add to Cart
                  </>
                ) : (
                  'Stock Out'
                )}
              </button>
              <button
                type="button"
                onClick={() => toggleWishlist(product.id)}
                className={`p-2.5 rounded-xl transition ${
                  wishlistIds.includes(product.id)
                    ? 'bg-red-600 text-white'
                    : 'bg-amber-100 text-red-600 hover:bg-amber-200'
                }`}
                title="Toggle Wishlist"
              >
                <i className="fa-solid fa-heart"></i>
              </button>
            </div>
          </div>
        </div>
      );
    });
  };

  return (
    <div className="bg-amber-50/20 text-gray-800 flex flex-col min-h-screen relative">
      {/* TOP NOTIFICATION BANNER */}
      <div className="bg-gradient-to-r from-royal-950 via-royal-900 to-royal-950 text-amber-200 text-xs py-2 px-4 border-b border-amber-600/30">
        <div className="container mx-auto flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <span>
              <i className="fa-solid fa-phone text-amber-400 mr-1"></i> Helpline: +91 8527386834
            </span>
            <span className="hidden md:inline-block">
              <i className="fa-solid fa-envelope text-amber-400 mr-1"></i>{' '}
              support@kbrglobalventures.com
            </span>
          </div>
          <div className="flex items-center space-x-4">
            <span className="hidden sm:inline-block font-medium text-amber-300">
              🚚 Express Pan-India Delivery Available
            </span>
            <button
              type="button"
              onClick={() => void openAdminPortal()}
              className="text-amber-400 hover:text-white font-bold transition flex items-center gap-1"
            >
              <i className="fa-solid fa-user-shield"></i> Admin Portal
            </button>
          </div>
        </div>
      </div>

      {/* MAIN NAVBAR */}
      <header className="bg-royal-950 text-white sticky top-0 z-40 border-b border-amber-600/30 w-full">
        <div className="w-full px-3 py-2 flex items-center justify-between gap-2">
          {/* 1. Logo */}
          <div
            className="flex items-center space-x-2 shrink-0 cursor-pointer"
            onClick={() => showPage('home')}
          >
            <div className="w-8 h-8 rounded-full bg-amber-50 border border-emerald-600 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-emerald-800"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.4 19 2c1 2 2 4.1 2 9 0 4.4-3.6 8-8 8z"
                  fill="#059669"
                  fillOpacity="0.2"
                ></path>
                <path d="M11 20c-3.3 0-6-2.7-6-6 0-3 2.5-5.5 5.5-5.5" stroke="#047857"></path>
              </svg>
            </div>
            <div>
              <h1 className="text-xs sm:text-sm font-extrabold tracking-wider text-amber-400 leading-tight">
                KBR MASALE
              </h1>
            </div>
          </div>

          {/* 2. Mobile & Desktop Icons Right Side */}
          <div className="flex items-center space-x-3 shrink-0 order-2 lg:order-3">
            {currentUser ? (
              <div className="flex items-center gap-2">
                <span className="hidden md:flex text-[10px] font-bold text-amber-300 bg-royal-900 px-2.5 py-1 rounded-full border border-amber-500/30 max-w-[140px] truncate">
                  👤 {userDisplayLabel}
                </span>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="text-[11px] font-bold text-amber-300 hover:text-white border border-amber-500/40 px-2.5 py-1 rounded-lg transition"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAuthModalError(null);
                  setAuthModalOpen(true);
                }}
                className="text-[11px] font-bold bg-amber-500 text-royal-950 hover:bg-amber-400 px-3 py-1 rounded-lg transition"
              >
                Sign In
              </button>
            )}

            {/* Wishlist */}
            <button
              type="button"
              onClick={() => showPage('wishlist')}
              className="relative p-1 text-amber-400"
            >
              <i className="fa-solid fa-heart text-base text-red-500"></i>
              <span className="absolute -top-1 -right-1 bg-amber-500 text-royal-950 text-[9px] font-extrabold w-4 h-4 rounded-full flex items-center justify-center">
                {wishlistIds.length}
              </span>
            </button>

            {/* Cart */}
            <button
              type="button"
              onClick={() => showPage('cart')}
              className="relative p-1 text-amber-400"
            >
              <i className="fa-solid fa-cart-shopping text-base"></i>
              <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[9px] font-extrabold w-4 h-4 rounded-full flex items-center justify-center">
                {totalCartCount}
              </span>
            </button>

            {/* Hamburger Button (Mobile Only) */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="lg:hidden text-amber-400 p-1 focus:outline-none"
            >
              <i className="fa-solid fa-bars text-lg"></i>
            </button>
          </div>

          {/* Desktop Nav Links */}
          <nav className="hidden lg:flex items-center space-x-4 text-xs font-medium order-3 lg:order-2">
            <button
              type="button"
              onClick={() => showPage('home')}
              className={`hover:text-amber-400 ${activePage === 'home' ? 'text-amber-400 font-bold' : ''}`}
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => showPage('products')}
              className={`hover:text-amber-400 ${activePage === 'products' ? 'text-amber-400 font-bold' : ''}`}
            >
              Products
            </button>
            <button
              type="button"
              onClick={() => showPage('orders')}
              className={`hover:text-amber-400 ${activePage === 'orders' ? 'text-amber-400 font-bold' : ''}`}
            >
              Orders
            </button>
            <button
              type="button"
              onClick={() => showPage('about')}
              className={`hover:text-amber-400 ${activePage === 'about' ? 'text-amber-400 font-bold' : ''}`}
            >
              About Us
            </button>
            <button
              type="button"
              onClick={() => showPage('services')}
              className={`hover:text-amber-400 ${activePage === 'services' ? 'text-amber-400 font-bold' : ''}`}
            >
              Services
            </button>
            <button
              type="button"
              onClick={() => showPage('reviews')}
              className={`hover:text-amber-400 ${activePage === 'reviews' ? 'text-amber-400 font-bold' : ''}`}
            >
              Reviews
            </button>
          </nav>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="lg:hidden bg-royal-950 border-t border-amber-600/30 px-4 py-3 space-y-2 text-sm font-medium text-white">
            <button
              type="button"
              onClick={() => showPage('home')}
              className="block w-full text-left hover:text-amber-400 py-1"
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => showPage('products')}
              className="block w-full text-left hover:text-amber-400 py-1"
            >
              Products
            </button>
            <button
              type="button"
              onClick={() => showPage('orders')}
              className="block w-full text-left hover:text-amber-400 py-1"
            >
              Orders
            </button>
            <button
              type="button"
              onClick={() => showPage('about')}
              className="block w-full text-left hover:text-amber-400 py-1"
            >
              About Us
            </button>
            <button
              type="button"
              onClick={() => showPage('services')}
              className="block w-full text-left hover:text-amber-400 py-1"
            >
              Services & Help
            </button>
            <button
              type="button"
              onClick={() => showPage('reviews')}
              className="block w-full text-left hover:text-amber-400 py-1"
            >
              Reviews
            </button>
          </div>
        )}
      </header>

      {/* REAL SUPABASE ERROR BANNER (Phase 1 requirement: never silently fallback to demo data) */}
      {backendError && (
        <div className="bg-red-900 text-white px-4 py-3 border-b border-red-700">
          <div className="container mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <i className="fa-solid fa-triangle-exclamation text-amber-300 text-sm"></i>
              <span>
                <strong>Supabase Error:</strong> {backendError}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void syncAuthAndData()}
              className="bg-white/15 hover:bg-white/25 text-white font-bold px-3 py-1 rounded-lg transition shrink-0"
            >
              Retry Connection
            </button>
          </div>
        </div>
      )}

      {/* TOAST NOTIFICATION */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-royal-950 text-amber-200 border border-amber-500/50 px-4 py-3 rounded-xl shadow-2xl text-xs font-bold flex items-center gap-2">
          <i className="fa-solid fa-circle-info text-amber-400"></i>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* CUSTOMER SUPABASE AUTH MODAL (Phase 2: Supabase Auth Only) */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 border-2 border-amber-500/50 relative overflow-hidden">
            <button
              type="button"
              onClick={() => setAuthModalOpen(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-black text-xl"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>

            <div className="text-center mb-6 relative z-10">
              <div className="inline-flex p-4 rounded-full bg-amber-100/80 text-amber-800 mb-3 shadow-inner">
                <i className="fa-solid fa-mortar-pestle text-4xl"></i>
              </div>
              <h2 className="text-2xl font-extrabold text-royal-950">Welcome to KBR Masale</h2>
              <p className="text-xs text-gray-500 mt-1 font-medium">
                {authMode === 'signin'
                  ? 'Sign in with your Supabase account'
                  : 'Create a customer account'}
              </p>
            </div>

            {authModalError && (
              <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-300 text-xs text-red-700 font-medium">
                {authModalError}
              </div>
            )}

            <form onSubmit={(e) => void handleCustomerAuthSubmit(e)} className="space-y-4">
              {authMode === 'signup' && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={authFullName}
                      onChange={(e) => setAuthFullName(e.target.value)}
                      placeholder="Enter Full Name"
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                      Mobile Number *
                    </label>
                    <input
                      type="tel"
                      required
                      value={authPhone}
                      onChange={(e) => setAuthPhone(e.target.value)}
                      placeholder="10 Digit Mobile Number"
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="yourname@example.com"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                  Password *
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="Enter password"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full bg-gradient-to-r from-amber-800 to-royal-900 hover:from-amber-900 hover:to-royal-950 text-white font-bold py-3.5 rounded-xl shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <span>
                  {authSubmitting
                    ? 'Authenticating...'
                    : authMode === 'signin'
                      ? 'Sign In'
                      : 'Create Account'}
                </span>
                <i className="fa-solid fa-circle-arrow-right"></i>
              </button>
            </form>

            <div className="mt-4 text-center text-xs text-gray-600">
              {authMode === 'signin' ? (
                <>
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthModalError(null);
                      setAuthMode('signup');
                    }}
                    className="text-amber-800 font-bold hover:underline"
                  >
                    Sign Up
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthModalError(null);
                      setAuthMode('signin');
                    }}
                    className="text-amber-800 font-bold hover:underline"
                  >
                    Sign In
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ADMIN LOGIN MODAL (Phase 2: Supabase Auth + user_roles/profiles RLS verification) */}
      {adminModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-6 border-2 border-red-800 relative">
            <button
              type="button"
              onClick={() => setAdminModalOpen(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-black text-xl"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
            <h3 className="text-xl font-extrabold text-royal-950 mb-4 border-b pb-2 flex items-center gap-2">
              <i className="fa-solid fa-lock text-red-700"></i> Admin Access (Supabase Auth)
            </h3>

            {adminModalError && (
              <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-300 text-xs text-red-700 font-medium">
                {adminModalError}
              </div>
            )}

            <form onSubmit={(e) => void handleAdminLoginSubmit(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                  Admin Email
                </label>
                <input
                  type="email"
                  required
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="Enter Admin Email"
                  className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-red-800"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Enter Password"
                  className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-red-800"
                />
              </div>
              <button
                type="submit"
                disabled={adminSubmitting}
                className="w-full bg-royal-900 hover:bg-royal-950 text-white font-bold py-3 rounded-xl transition shadow-lg disabled:opacity-60"
              >
                {adminSubmitting ? 'Verifying Role in Supabase...' : 'Login to Admin Dashboard'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MAIN ROUTED CONTENT */}
      <main className="flex-grow">
        {/* HOME PAGE */}
        {activePage === 'home' && (
          <section id="page-home" className="page-section">
            <div className="relative w-full max-w-7xl mx-auto my-6 px-4">
              <div className="relative h-56 sm:h-80 md:h-[400px] w-full rounded-2xl overflow-hidden shadow-2xl border-2 border-amber-500/20 bg-gradient-to-br from-royal-950 via-royal-900 to-amber-900">
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent flex flex-col justify-end p-6 md:p-12 text-white">
                  <span className="bg-amber-500 text-royal-950 font-extrabold text-xs px-3 py-1 rounded-full uppercase w-max mb-2">
                    100% Pure & Authentic
                  </span>
                  <h2 className="text-2xl md:text-4xl font-extrabold">
                    Authentic Indian Flavors
                  </h2>
                </div>
              </div>
            </div>

            <div className="container mx-auto px-4 py-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b pb-3 mb-6 gap-3">
                <h3 className="text-2xl md:text-3xl font-extrabold text-royal-950">
                  Featured Masalas
                </h3>
                {categories.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedCategoryId('all')}
                      className={`text-xs font-bold px-3 py-1.5 rounded-xl transition ${
                        selectedCategoryId === 'all'
                          ? 'bg-royal-950 text-amber-300'
                          : 'bg-amber-100 text-royal-950 hover:bg-amber-200'
                      }`}
                    >
                      All Categories
                    </button>
                    {categories.map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setSelectedCategoryId(cat.id)}
                        className={`text-xs font-bold px-3 py-1.5 rounded-xl transition ${
                          selectedCategoryId === cat.id
                            ? 'bg-royal-950 text-amber-300'
                            : 'bg-amber-100 text-royal-950 hover:bg-amber-200'
                        }`}
                      >
                        {cat.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {renderProductGrid(
                  selectedCategoryId === 'all' ? featuredProducts : filteredProducts
                )}
              </div>
            </div>
          </section>
        )}

        {/* PRODUCTS PAGE */}
        {activePage === 'products' && (
          <section id="page-products" className="page-section container mx-auto px-4 py-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-3">
              <h2 className="text-3xl font-extrabold text-royal-950">
                Our Full Spice Collection
              </h2>
              {categories.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryId('all')}
                    className={`text-xs font-bold px-3 py-1.5 rounded-xl transition ${
                      selectedCategoryId === 'all'
                        ? 'bg-royal-950 text-amber-300'
                        : 'bg-amber-100 text-royal-950 hover:bg-amber-200'
                    }`}
                  >
                    All
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategoryId(cat.id)}
                      className={`text-xs font-bold px-3 py-1.5 rounded-xl transition ${
                        selectedCategoryId === cat.id
                          ? 'bg-royal-950 text-amber-300'
                          : 'bg-amber-100 text-royal-950 hover:bg-amber-200'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {renderProductGrid(filteredProducts)}
            </div>
          </section>
        )}

        {/* CART PAGE (Phase 4) */}
        {activePage === 'cart' && (
          <section id="page-cart" className="page-section container mx-auto px-4 py-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-3xl font-extrabold text-royal-950">Your Shopping Cart</h2>
              {cartItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleClearCart()}
                  className="text-xs font-bold text-red-700 hover:underline"
                >
                  Clear Cart
                </button>
              )}
            </div>

            {cartError && (
              <div className="mb-6 p-4 rounded-2xl bg-red-50 border border-red-300 text-xs text-red-700 font-medium">
                {cartError}
              </div>
            )}

            {cartLoading ? (
              <div className="text-center py-16 text-gray-500 font-medium">
                Loading cart...
              </div>
            ) : cartItems.length === 0 ? (
              <div className="text-center py-16 text-gray-500 font-medium bg-white rounded-2xl border border-amber-200">
                Your shopping cart is empty!
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-4">
                  {cartItems.map((item) => (
                    <div
                      key={item.cartItemId}
                      className="bg-white p-4 rounded-2xl border border-amber-200 flex justify-between items-center shadow-sm"
                    >
                      <div className="flex items-center space-x-4">
                        {item.imagePath ? (
                          <img
                            src={item.imagePath}
                            alt={item.name}
                            className="w-16 h-16 object-cover rounded-xl border"
                          />
                        ) : (
                          <div className="w-16 h-16 rounded-xl border bg-amber-50 flex items-center justify-center text-amber-800/50">
                            <i className="fa-solid fa-mortar-pestle text-xl"></i>
                          </div>
                        )}
                        <div>
                          <h4 className="font-bold text-royal-950">{item.name}</h4>
                          <p className="text-xs text-amber-800 font-bold bg-amber-100 px-2 py-0.5 rounded-md inline-block my-1">
                            Net Wt: {item.weight}
                          </p>
                          <p className="text-xs text-gray-500">
                            ₹{item.price} x {item.qty}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <button
                          type="button"
                          onClick={() => void handleUpdateCartQty(item, -1)}
                          className="w-8 h-8 bg-amber-100 rounded-lg font-bold text-amber-900"
                        >
                          -
                        </button>
                        <span className="text-sm font-bold">{item.qty}</span>
                        <button
                          type="button"
                          onClick={() => void handleUpdateCartQty(item, 1)}
                          className="w-8 h-8 bg-amber-100 rounded-lg font-bold text-amber-900"
                        >
                          +
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveFromCart(item)}
                          className="text-red-600 ml-3"
                        >
                          <i className="fa-solid fa-trash"></i>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-white p-6 rounded-2xl border border-amber-200 h-fit space-y-3 shadow-md">
                  <h3 className="font-bold text-lg text-royal-950 border-b pb-2">Summary</h3>
                  <div className="flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span>₹{cartSubtotal}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Shipping</span>
                    <span>₹{cartShipping}</span>
                  </div>
                  <hr />
                  <div className="flex justify-between font-extrabold text-base text-royal-950">
                    <span>Total</span>
                    <span>₹{cartSubtotal + cartShipping}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => showPage('checkout')}
                    className="w-full bg-amber-800 text-white font-bold py-3.5 rounded-xl text-sm mt-4 shadow-lg"
                  >
                    Proceed to Checkout
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* CHECKOUT PAGE (Phase 5 & 9 not yet implemented — no fake order persistence) */}
        {activePage === 'checkout' && (
          <section
            id="page-checkout"
            className="page-section container mx-auto px-4 py-8 max-w-3xl"
          >
            <div className="bg-white p-6 md:p-10 rounded-3xl shadow-xl border border-amber-200">
              <h2 className="text-2xl font-extrabold text-royal-950 mb-6 border-b pb-3">
                Checkout & Shipping
              </h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  showNotice(
                    'Order submission (Phase 5) is not enabled in Phases 1–4 cleanup.'
                  );
                }}
                className="space-y-4"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      defaultValue={userProfile?.full_name ?? ''}
                      placeholder="Enter Full Name"
                      className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                      Phone Number *
                    </label>
                    <input
                      type="tel"
                      required
                      defaultValue={userProfile?.phone ?? ''}
                      placeholder="Phone Number"
                      className="w-full px-4 py-3 border rounded-xl text-sm text-gray-700"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    required
                    readOnly={Boolean(currentUser?.email)}
                    defaultValue={currentUser?.email ?? ''}
                    className="w-full px-4 py-3 bg-gray-100 border rounded-xl text-sm text-gray-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                    House No. & Street / Landmark *
                  </label>
                  <textarea
                    required
                    rows={2}
                    placeholder="House/Flat No., Building, Street Name"
                    className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-amber-500"
                  ></textarea>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                      City *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="Enter City"
                      className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                      State *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="Enter State"
                      className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                      Pincode *
                    </label>
                    <input
                      type="text"
                      required
                      pattern="[0-9]{6}"
                      maxLength={6}
                      placeholder="6-digit Pincode"
                      className="w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t">
                  <label className="block text-sm font-extrabold text-royal-950 mb-3">
                    Payment Method
                  </label>
                  <div className="grid grid-cols-2 gap-4">
                    <label className="border-2 p-4 rounded-2xl flex items-center space-x-3 cursor-pointer bg-amber-50/50">
                      <input
                        type="radio"
                        name="paymentMethod"
                        value="COD"
                        checked={paymentMethod === 'COD'}
                        onChange={() => setPaymentMethod('COD')}
                      />
                      <span className="text-xs font-bold">Cash On Delivery</span>
                    </label>
                    <label className="border-2 p-4 rounded-2xl flex items-center space-x-3 cursor-pointer bg-amber-50/50">
                      <input
                        type="radio"
                        name="paymentMethod"
                        value="ONLINE"
                        checked={paymentMethod === 'ONLINE'}
                        onChange={() => setPaymentMethod('ONLINE')}
                      />
                      <span className="text-xs font-bold">UPI / QR Code</span>
                    </label>
                  </div>
                </div>
                <button
                  type="submit"
                  className="w-full bg-emerald-700 text-white font-extrabold py-4 rounded-xl text-base shadow-xl mt-4"
                >
                  Place Order
                </button>
              </form>
            </div>
          </section>
        )}

        {/* ORDERS PAGE */}
        {activePage === 'orders' && (
          <section
            id="page-orders"
            className="page-section container mx-auto px-4 py-8 max-w-4xl"
          >
            <h2 className="text-3xl font-extrabold text-royal-950 mb-6">
              My Orders & Tracking
            </h2>
            <div className="bg-white p-8 rounded-2xl border border-amber-200 text-center text-gray-500 font-medium">
              No orders placed yet.
            </div>
          </section>
        )}

        {/* WISHLIST PAGE */}
        {activePage === 'wishlist' && (
          <section id="page-wishlist" className="page-section container mx-auto px-4 py-8">
            <h2 className="text-3xl font-extrabold text-royal-950 mb-6">Saved Items</h2>
            {wishlistProducts.length === 0 ? (
              <div className="text-center py-16 text-gray-500 font-medium bg-white rounded-2xl border border-amber-200">
                Your wishlist is empty.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {wishlistProducts.map((p) => (
                  <div
                    key={p.id}
                    className="bg-white rounded-2xl p-4 border border-amber-200 shadow-sm"
                  >
                    {p.image_path ? (
                      <img
                        src={p.image_path}
                        alt={p.name}
                        className="h-40 w-full object-cover rounded-xl"
                      />
                    ) : (
                      <div className="h-40 w-full rounded-xl bg-amber-50 flex items-center justify-center text-amber-800/50">
                        <i className="fa-solid fa-mortar-pestle text-3xl"></i>
                      </div>
                    )}
                    <h4 className="font-bold text-royal-950 mt-3">{p.name}</h4>
                    <button
                      type="button"
                      onClick={() => showPage('products')}
                      className="w-full bg-amber-800 text-white py-2 rounded-xl mt-3 text-xs font-bold"
                    >
                      View in Catalog
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* SERVICES PAGE (Phase 8 not yet implemented — no localStorage query seeding) */}
        {activePage === 'services' && (
          <section
            id="page-services"
            className="page-section container mx-auto px-4 py-8 max-w-4xl"
          >
            <h2 className="text-3xl font-extrabold text-royal-950 mb-6">Customer Care</h2>
            <div className="bg-white p-6 rounded-2xl shadow-lg border">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  showNotice(
                    'Customer support ticket backend (Phase 8) will be connected in its dedicated phase.'
                  );
                }}
                className="space-y-4"
              >
                <input
                  type="tel"
                  required
                  placeholder="Your Phone / Mobile Number"
                  className="w-full p-3 border border-gray-300 rounded-xl text-sm"
                />
                <textarea
                  required
                  rows={4}
                  placeholder="Describe your query..."
                  className="w-full p-3 border border-gray-300 rounded-xl text-sm"
                ></textarea>
                <button
                  type="submit"
                  className="bg-amber-800 text-white font-bold py-3 px-8 rounded-xl text-sm hover:bg-amber-900 transition"
                >
                  Submit Ticket
                </button>
              </form>
            </div>
          </section>
        )}

        {/* REVIEWS PAGE (Demo INITIAL_REVIEWS removed, no localStorage review seeding) */}
        {activePage === 'reviews' && (
          <section
            id="page-reviews"
            className="page-section container mx-auto px-4 py-8 max-w-4xl"
          >
            <h2 className="text-3xl font-extrabold text-royal-950 mb-6">
              Customer Reviews & Feedback
            </h2>
            <div className="bg-white p-8 rounded-2xl border border-amber-200 text-center text-gray-500 text-sm">
              No customer reviews to display.
            </div>
          </section>
        )}

        {/* ABOUT, PRIVACY & RETURN PAGES */}
        {activePage === 'about' && (
          <section id="page-about" className="page-section container mx-auto px-4 py-8">
            <div className="bg-white p-8 rounded-2xl shadow">
              KBR Global Ventures - Premium Quality Spices.
            </div>
          </section>
        )}
        {activePage === 'privacy' && (
          <section id="page-privacy" className="page-section container mx-auto px-4 py-8">
            <div className="bg-white p-8 rounded-2xl shadow">
              100% Data Protection & Security Policy.
            </div>
          </section>
        )}
        {activePage === 'return' && (
          <section id="page-return" className="page-section container mx-auto px-4 py-8">
            <div className="bg-white p-8 rounded-2xl shadow">
              7-Day Return and Replacement Policy.
            </div>
          </section>
        )}

        {/* ADMIN DASHBOARD PAGE (Accessible only to Supabase-verified admins) */}
        {activePage === 'admin' && isAdmin && (
          <section id="page-admin" className="page-section container mx-auto px-4 py-8">
            <div className="bg-white rounded-3xl shadow-2xl border-2 border-red-900 p-6 md:p-8">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-6 mb-6">
                <div>
                  <span className="bg-red-800 text-white text-[10px] font-extrabold px-3 py-1 rounded-full uppercase">
                    Verified Supabase Admin
                  </span>
                  <h2 className="text-3xl font-extrabold text-royal-950 mt-1">
                    Management Portal
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => showPage('home')}
                  className="mt-4 md:mt-0 bg-gray-200 hover:bg-gray-300 font-bold px-4 py-2 rounded-xl text-xs"
                >
                  Exit Admin Panel
                </button>
              </div>

              <div className="flex space-x-2 border-b mb-6 overflow-x-auto pb-2">
                <button
                  type="button"
                  onClick={() => setActiveAdminTab('products')}
                  className={`px-4 py-2 font-bold text-sm ${
                    activeAdminTab === 'products'
                      ? 'border-b-2 border-red-800 text-red-800'
                      : 'text-gray-500 hover:text-red-800'
                  }`}
                >
                  Catalog Overview ({products.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAdminTab('orders')}
                  className={`px-4 py-2 font-bold text-sm ${
                    activeAdminTab === 'orders'
                      ? 'border-b-2 border-red-800 text-red-800'
                      : 'text-gray-500 hover:text-red-800'
                  }`}
                >
                  Orders
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAdminTab('users')}
                  className={`px-4 py-2 font-bold text-sm ${
                    activeAdminTab === 'users'
                      ? 'border-b-2 border-red-800 text-red-800'
                      : 'text-gray-500 hover:text-red-800'
                  }`}
                >
                  Admin Session
                </button>
              </div>

              {activeAdminTab === 'products' && (
                <div>
                  <h3 className="font-bold text-lg text-royal-950 mb-4">
                    Supabase Catalog Products ({products.length})
                  </h3>
                  {products.length === 0 ? (
                    <p className="text-sm text-gray-500 italic">
                      No products found in Supabase.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {products.map((p) => (
                        <div
                          key={p.id}
                          className="bg-gray-50 p-4 rounded-2xl border flex justify-between items-center"
                        >
                          <div className="flex items-center space-x-3">
                            {p.image_path ? (
                              <img
                                src={p.image_path}
                                alt={p.name}
                                className="w-12 h-12 object-cover rounded-xl"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center text-amber-800">
                                <i className="fa-solid fa-mortar-pestle"></i>
                              </div>
                            )}
                            <div>
                              <h4 className="font-bold text-xs text-royal-950">{p.name}</h4>
                              <span
                                className={`text-[10px] font-bold ${
                                  p.in_stock ? 'text-emerald-700' : 'text-red-600'
                                }`}
                              >
                                {p.in_stock ? 'In Stock' : 'Out of Stock'} • {p.variants.length}{' '}
                                variants
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleToggleProductStock(p)}
                            className={`${
                              p.in_stock ? 'bg-red-700' : 'bg-emerald-700'
                            } text-white font-bold text-xs px-3 py-2 rounded-xl`}
                          >
                            Mark as {p.in_stock ? 'Out of Stock' : 'In Stock'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeAdminTab === 'orders' && (
                <p className="text-sm text-gray-500 italic">
                  Orders management (Phase 5/6) is not enabled in Phases 1–4.
                </p>
              )}

              {activeAdminTab === 'users' && (
                <div className="bg-gray-50 p-4 rounded-2xl border text-xs space-y-1">
                  <p>
                    <strong>Authenticated User ID:</strong> {currentUser?.id}
                  </p>
                  <p>
                    <strong>Email:</strong> {currentUser?.email}
                  </p>
                  <p>
                    <strong>Profile Name:</strong> {userProfile?.full_name ?? '—'}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {/* FOOTER */}
      <footer className="bg-[#3b0909] text-white pt-10 pb-4 border-t-4 border-amber-500 mt-16">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-4 gap-8 mb-8 text-left">
          {/* Column 1: Brand Info */}
          <div>
            <h3 className="text-amber-400 font-extrabold text-lg mb-3 tracking-wide">
              KBR GLOBAL VENTURES
            </h3>
            <p className="text-gray-300 text-xs leading-relaxed mb-4">
              Premium quality pure Indian masale packaged with complete hygiene and perfection.
            </p>
            <p className="text-xs text-amber-400 font-bold mb-1 flex items-center gap-2">
              <i className="fa-solid fa-phone"></i> Support: 8527386834
            </p>
            <p className="text-xs text-amber-400 font-bold flex items-center gap-2">
              <i className="fa-solid fa-clock"></i> Opening Time: 24 Hours Open
            </p>
          </div>

          {/* Column 2: Quick Navigation */}
          <div>
            <h4 className="text-amber-400 font-bold text-sm mb-3 uppercase tracking-wider">
              QUICK NAVIGATION
            </h4>
            <ul className="space-y-2 text-xs text-gray-300">
              <li>
                <button
                  type="button"
                  onClick={() => showPage('home')}
                  className="hover:text-amber-400 transition"
                >
                  Home
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => showPage('products')}
                  className="hover:text-amber-400 transition"
                >
                  Products Range
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => showPage('about')}
                  className="hover:text-amber-400 transition"
                >
                  About Us
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => showPage('services')}
                  className="hover:text-amber-400 transition"
                >
                  Services & Help
                </button>
              </li>
            </ul>
          </div>

          {/* Column 3: Policies */}
          <div>
            <h4 className="text-amber-400 font-bold text-sm mb-3 uppercase tracking-wider">
              POLICIES
            </h4>
            <ul className="space-y-2 text-xs text-gray-300">
              <li>
                <button
                  type="button"
                  onClick={() => showPage('privacy')}
                  className="hover:text-amber-400 transition"
                >
                  Privacy Policy
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => showPage('return')}
                  className="hover:text-amber-400 transition"
                >
                  Return & Refund Policy
                </button>
              </li>
            </ul>
          </div>

          {/* Column 4: Social Connect */}
          <div>
            <h4 className="text-amber-400 font-bold text-sm mb-3 uppercase tracking-wider">
              SOCIAL CONNECT
            </h4>
            <ul className="space-y-2 text-xs text-gray-300">
              <li className="flex items-center gap-2">
                <i className="fa-brands fa-instagram text-pink-500"></i> Instagram:{' '}
                <span className="font-bold text-white">COMING SOON</span>
              </li>
              <li className="flex items-center gap-2">
                <i className="fa-brands fa-youtube text-red-500"></i> YouTube:{' '}
                <span className="font-bold text-white">COMING SOON</span>
              </li>
              <li className="flex items-center gap-2">
                <i className="fa-brands fa-facebook text-blue-500"></i> Facebook:{' '}
                <span className="font-bold text-white">COMING SOON</span>
              </li>
              <li className="flex items-center gap-2">
                <i className="fa-solid fa-map-location-dot text-green-500"></i> Google Map:{' '}
                <span className="font-bold text-white">COMING SOON</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Copyright Strip */}
        <div className="bg-[#5c1313] py-3 text-center text-xs text-amber-200 border-t border-amber-900/40">
          © 2026 KBR Global Ventures. All Rights Reserved. Contact: 8527386834
        </div>
      </footer>

      {authLoading && (
        <div className="sr-only" aria-live="polite">
          Verifying Supabase session...
        </div>
      )}
    </div>
  );
}

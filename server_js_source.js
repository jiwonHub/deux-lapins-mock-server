// DEUX LAPINS local shared Mock API.
// Node.js 20+ / No npm packages required.
// Development server only. Data is stored in memory.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { lookupDelivery } = require('./shipping_tracking_api');
const { loadMockData, saveMockData } = require('./mock_db');
const { MockInquiryService } = require('./mock_inquiry_service');
const { MockClaimService } = require('./mock_claim_service');
const { MockAccountService } = require('./mock_account_service');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// 카카오 로그인 설정 - 로컬 테스트 서버 전용
const KAKAO_REST_API_KEY =
  process.env.KAKAO_REST_API_KEY || '';

const KAKAO_CLIENT_SECRET =
  process.env.KAKAO_CLIENT_SECRET || '';

const KAKAO_REDIRECT_URI =
  process.env.KAKAO_REDIRECT_URI ||
  'http://127.0.0.1:8080/auth/kakao/callback';

const KAKAO_WEB_ORIGIN = new URL(KAKAO_REDIRECT_URI).origin;
const SESSION_COOKIE = 'deux_mock_session';

const sessions = new Map();

const clone = x => structuredClone(x);

const error = (code, message, status = 400) => {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  throw e;
};

const required = (
  ok,
  message,
  code = 'VALIDATION_ERROR',
  status = 400
) => {
  if (!ok) error(code, message, status);
};

const suffix = str => String(str || '').trim().toUpperCase();
const date = () => new Date().toISOString();

function seedProduct(
  id,
  sku,
  name,
  line,
  price,
  colors,
  sizes,
  quantities,
  image,
  status = 'selling'
) {
  let n = 0;

  return {
    id,
    product_code: sku,
    name,
    line,
    season: 'AW26',
    price,
    description: name,
    material: '',
    colors,
    sizes,
    fit: '',
    detail: '',
    care: '',
    sale_status: status,
    publish_status: status === 'hidden' ? 'draft' : 'published',
    updated_at: date(),
    main_image_base64: null,
    detail_image_base64: [],
    image_url: image,
    variants: colors.flatMap(color =>
      sizes.map(size => ({
        id: `${id}:${suffix(color)}:${suffix(size)}`,
        product_id: id,
        color_name: color,
        size_name: size,
        stock_quantity: quantities[n++] ?? 0,
        low_stock_threshold: 3,
        is_active: true
      }))
    )
  };
}

const products = [
  seedProduct(
    'P001',
    'DL-AW26-001',
    'Heritage Wool Blouson',
    'classic',
    489000,
    ['BLACK', 'CHARCOAL'],
    ['M', 'L'],
    [6, 4, 2, 1],
    'https://images.unsplash.com/photo-1544923246-77307dd654cb?w=800'
  ),
  seedProduct(
    'P002',
    'DL-AW26-002',
    'Utility Cotton Shirt',
    'work',
    159000,
    ['IVORY', 'NAVY'],
    ['M', 'L', 'XL'],
    [5, 2, 0, 4, 3, 1],
    'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=800'
  ),
  seedProduct(
    'P003',
    'DL-AW26-003',
    'Classic Pleated Trousers',
    'classic',
    219000,
    ['BLACK'],
    ['S', 'M', 'L'],
    [1, 2, 0],
    'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800'
  ),
  seedProduct(
    'P004',
    'DL-AW26-004',
    'Work Leather Bag',
    'work',
    379000,
    ['BLACK'],
    ['FREE'],
    [8],
    '',
    'hidden'
  )
];

const carts = new Map();
const wishlists = new Map();
const orders = [];
const completed = new Map();

const inquiries = [];
const claims = [];
const journals = [];

let home = {
  hero: {
    main_text: 'A Quiet Form\nFor What Moves\nYou Forward.',
    sub_text: 'AUTUMN / WINTER 2026',
    button_text: '컬렉션 보기',
    button_route: '/new',
    is_visible: true,
    sort_order: 1,
    media_name: '',
    media_base64: null,
    is_video: false
  },
  classic_visible: true,
  work_visible: true,
  classic_image_base64: null,
  work_image_base64: null,
  new_arrival_product_ids: ['P001', 'P002'],
  publish_status: 'published',
  updated_at: date()
};

let settings = {
  shipping_fee: 3000,
  free_shipping_threshold: 100000,
  carrier: 'CJ대한통운',
  origin_address: '서울특별시 성동구 성수이로 00',
  return_address: '서울특별시 성동구 성수이로 00',
  cs_phone: '02-0000-0000',
  cs_email: 'cs@duexlapins.com',
  cs_hours: 'MON-FRI 10:00-17:00',
  default_guide: '배송·교환·반품 안내'
};

const savedState = loadMockData();
const accountService = new MockAccountService(savedState?.account);
if (savedState) {
  products.splice(0, products.length, ...savedState.products);
  orders.push(...savedState.orders.map(order => {
    order.items.forEach((item, index) => {
      item.order_item_id ||= `${order.id}:${index + 1}`;
    });
    return order;
  }));
  for (const [id, entries] of savedState.carts) {
    carts.set(id, new Map(entries));
  }
  for (const [id, entries] of savedState.wishlists) {
    wishlists.set(id, new Set(entries));
  }
  for (const [key, order] of savedState.completed) {
    completed.set(key, order);
  }
  inquiries.push(...savedState.inquiries);
  claims.push(...(savedState.claims || []));
  journals.push(...savedState.journals);
  home = savedState.home;
  settings = savedState.settings;
}

const claimService = new MockClaimService({ orders, claims, products });

const inquiryService = new MockInquiryService({ inquiries, products });

function persistState() {
  saveMockData({
    products,
    orders,
    carts: [...carts].map(([id, cart]) => [id, [...cart]]),
    wishlists: [...wishlists].map(([id, list]) => [id, [...list]]),
    completed: [...completed],
    inquiries,
    claims,
    journals,
    home,
    settings,
    account: accountService.snapshot()
  });
}

const cartOf = user => {
  if (!carts.has(user)) carts.set(user, new Map());
  return carts.get(user);
};

const wishlistOf = user => {
  if (!wishlists.has(user)) wishlists.set(user, new Set());
  return wishlists.get(user);
};

const owner = url => {
  const value = url.searchParams.get('user_id');
  return value && value.trim() || 'guest';
};

const productOf = id =>
  products.find(p => p.id === id && !p.deleted);

const variantOf = id => {
  for (const p of products) {
    if (p.deleted) continue;

    const v = p.variants.find(v => v.id === id);

    if (v) return { p, v };
  }

  return null;
};

const publicProduct = p =>
  !p.deleted &&
  p.publish_status === 'published' &&
  p.sale_status !== 'hidden';

function shopProduct(p) {
  const main = p.main_image_base64
    ? `data:image/jpeg;base64,${p.main_image_base64}`
    : p.image_url || '';

  const category = /bag/i.test(p.name)
    ? 'ACC'
    : /shirt/i.test(p.name)
      ? 'SHIRTS'
      : /trouser/i.test(p.name)
        ? 'PANTS'
        : 'OUTER';

  return {
    id: p.id,
    product_code: p.product_code,
    brand: 'DUEX LAPINS',
    name: p.name,
    category,
    price: p.price,
    line: p.line,
    description: p.description,
    colors: p.colors,
    sizes: p.sizes,
    sale_status: p.sale_status,
    publish_status: p.publish_status,
    is_new: true,
    is_best: p.is_best === true,
    is_premium: p.is_premium === true,
    variants: p.variants,
    images: [
      {
        image_type: 'main',
        image_url: main,
        sort_order: 0
      },
      {
        image_type: 'hover',
        image_url: main,
        sort_order: 0
      },
      ...p.detail_image_base64.map((v, i) => ({
        image_type: 'detail',
        image_url: `data:image/jpeg;base64,${v}`,
        sort_order: i
      }))
    ]
  };
}

const stockOk = (v, q) =>
  v.is_active &&
  Number.isInteger(q) &&
  q > 0 &&
  v.stock_quantity >= q;

function checkProduct(p, exclude) {
  required(
    p &&
    p.id &&
    p.name &&
    p.product_code &&
    Number.isInteger(p.price) &&
    p.price >= 0,
    '상품 정보가 올바르지 않습니다.'
  );

  required(
    Array.isArray(p.variants) && p.variants.length > 0,
    '옵션을 등록해주세요.'
  );

  required(
    !products.some(
      x =>
        x.id !== exclude &&
        !x.deleted &&
        suffix(x.product_code) === suffix(p.product_code)
    ),
    '중복 상품코드입니다.',
    'CONFLICT',
    409
  );

  const keys = new Set();

  for (const v of p.variants) {
    const key = `${suffix(v.color_name)}:${suffix(v.size_name)}`;

    required(
      !keys.has(key) &&
      Number.isInteger(v.stock_quantity) &&
      v.stock_quantity >= 0 &&
      v.low_stock_threshold >= 0,
      '옵션 또는 재고가 올바르지 않습니다.'
    );

    keys.add(key);
  }
}

function adminOrder(o) {
  return {
    id: o.id,
    customer_id: o.user_id,
    customer_name: o.recipient_name,
    phone: o.recipient_phone,
    address: [
      o.postcode,
      o.address,
      o.detail_address
    ].filter(Boolean).join(' '),
    shipping_fee: o.shipping_fee,
    payment_status: o.payment_status,
    order_status: o.admin_status || 'paid',
    ordered_at: o.ordered_at,
    carrier: o.carrier || '',
    tracking_number: o.tracking_number || '',
    admin_memo: o.admin_memo || '',
    items: o.items.map(i => ({
      order_item_id: i.order_item_id,
      product_id: i.product_id,
      product_name: i.product_name,
      product_variant_id: i.product_variant_id,
      carrier: i.carrier || '',
      tracking_number: i.tracking_number || '',
      delivery_status: i.delivery_status || 'preparing',
      color_name: i.color_name,
      size_name: i.size_name,
      quantity: i.quantity,
      unit_price: i.unit_price
    }))
  };
}

function createOrder(b) {
  const u = String(b.user_id || '').trim();
  const key = String(b.request_id || '').trim();

  required(
    u && key,
    '로그인 또는 요청 ID가 없습니다.',
    'UNAUTHORIZED',
    401
  );

  const idKey = `${u}:${key}`;

  if (completed.has(idKey)) {
    return clone(completed.get(idKey));
  }

  required(
    b.recipient_name &&
    b.address &&
    b.postcode &&
    /\d{9,}/.test(
      String(b.recipient_phone || '').replace(/\D/g, '')
    ),
    '배송정보를 확인해주세요.'
  );

  required(
    ['card', 'kakao_pay', 'naver_pay', 'bank_transfer']
      .includes(b.payment_method),
    '결제수단을 확인해주세요.'
  );

  const cart = cartOf(u);
  const isDirect = b.items != null;

  let purchaseItems = cart;

  if (isDirect) {
    required(
      Array.isArray(b.items) && b.items.length > 0,
      '바로 구매 상품 옵션이 올바르지 않습니다.'
    );

    purchaseItems = new Map();
    for (const row of b.items) {
      const variantId = String(row?.product_variant_id ?? '').trim();
      required(
        variantId && Number.isSafeInteger(row?.quantity) && row.quantity > 0,
        '바로 구매 상품 옵션과 수량을 확인해주세요.'
      );
      required(
        !purchaseItems.has(variantId),
        '바로 구매 상품 옵션이 중복되었습니다.'
      );
      purchaseItems.set(variantId, row.quantity);
    }
  }

  required(
    purchaseItems.size > 0,
    '장바구니가 비어 있습니다.',
    'EMPTY_CART'
  );

  const items = [];
  let amount = 0;

  for (const [variantId, q] of purchaseItems) {
    const found = variantOf(variantId);

    required(
      found &&
      publicProduct(found.p) &&
      found.p.sale_status === 'selling' &&
      stockOk(found.v, q),
      `재고 부족: ${variantId}`,
      'INSUFFICIENT_STOCK',
      409
    );

    amount += found.p.price * q;

    items.push({
      product_variant_id: variantId,
      product_id: found.p.id,
      product_name: found.p.name,
      product_code: found.p.product_code,
      color_name: found.v.color_name,
      size_name: found.v.size_name,
      image_url: shopProduct(found.p).images[0].image_url,
      quantity: q,
      unit_price: found.p.price,
      carrier: null,
      tracking_number: null,
      delivery_status: 'preparing'
    });
  }

  if (b.simulate_payment_failure) {
    error(
      'PAYMENT_FAILED',
      '테스트 결제가 거절되었습니다.',
      409
    );
  }

  const fee = amount >= settings.free_shipping_threshold
    ? 0
    : settings.shipping_fee;

  const id = `DL-${Date.now()}-${String(orders.length + 1).padStart(4, '0')}`;

  items.forEach((item, index) => {
    item.order_item_id = `${id}:${index + 1}`;
  });

  const order = {
    id,
    order_number: id,
    user_id: u,
    ordered_at: date(),
    order_status: 'payment_completed',
    admin_status: 'paid',
    payment_status: 'paid',
    delivery_status: 'preparing',
    payment_method: b.payment_method,
    recipient_name: b.recipient_name,
    recipient_phone: b.recipient_phone,
    postcode: b.postcode,
    address: b.address,
    detail_address: b.detail_address || '',
    product_amount: amount,
    shipping_fee: fee,
    total_amount: amount + fee,
    items,
    carrier: '',
    tracking_number: '',
    admin_memo: ''
  };

  for (const [variantId, q] of purchaseItems) {
    variantOf(variantId).v.stock_quantity -= q;
  }

  orders.unshift(order);
  completed.set(idKey, order);
  if (!isDirect) cart.clear();

  return clone(order);
}

function dispatchRoute(method, url, b) {
  const path = url.pathname;
  const parts = path.split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

  const user = owner(url);

  if (path === '/mock/session' || path.startsWith('/users/')) {
    return accountService.dispatch(method, url, b);
  }

  if (method === 'GET' && path === '/health') {
    return { status: 'ok' };
  }

  if (method === 'GET' && path === '/products') {
    return products.filter(p => !p.deleted);
  }

  if (method === 'POST' && path === '/products') {
    checkProduct(b);

    required(
      !productOf(b.id),
      '상품 ID가 중복되었습니다.',
      'CONFLICT',
      409
    );

    const p = {
      ...b,
      updated_at: date()
    };

    products.unshift(p);

    return p;
  }

  if (parts[0] === 'products' && parts.length >= 2) {
    const p = productOf(parts[1]);

    required(p, '상품이 없습니다.', 'NOT_FOUND', 404);

    if (method === 'GET' && parts.length === 2) {
      return p;
    }

    if (method === 'PUT' && parts.length === 2) {
      required(b.id === p.id, '상품 ID가 다릅니다.');
      checkProduct(b, p.id);

      Object.assign(p, b, {
        updated_at: date()
      });

      return p;
    }

    if (method === 'DELETE' && parts.length === 2) {
      p.deleted = true;
      return { id: p.id, deleted: true };
    }

    if (method === 'PATCH' && parts[2] === 'inventory') {
      const v = p.variants.find(
        x =>
          suffix(x.color_name) === suffix(b.color) &&
          suffix(x.size_name) === suffix(b.size)
      );

      required(v, '옵션이 없습니다.', 'NOT_FOUND', 404);

      required(
        Number.isInteger(b.quantity) && b.quantity >= 0,
        '재고가 올바르지 않습니다.'
      );

      v.stock_quantity = b.quantity;
      p.updated_at = date();

      return p;
    }
  }

  if (method === 'GET' && path === '/shop/products') {
    return products.filter(publicProduct).map(shopProduct);
  }

  if (
    method === 'GET' &&
    parts[0] === 'shop' &&
    parts[1] === 'products' &&
    parts.length === 3
  ) {
    const p = productOf(parts[2]);

    required(
      p && publicProduct(p),
      '상품이 없습니다.',
      'NOT_FOUND',
      404
    );

    return shopProduct(p);
  }

  if (path === '/cart' && method === 'GET') {
    return [...cartOf(user)].map(
      ([product_variant_id, quantity]) => ({
        product_variant_id,
        quantity
      })
    );
  }

  if (path === '/cart' && method === 'DELETE') {
    cartOf(user).clear();
    return { cleared: true };
  }

  if (path === '/cart/items' && method === 'POST') {
    const id = b.product_variant_id;
    const q = b.quantity;
    const found = variantOf(id);

    required(
      found &&
      publicProduct(found.p) &&
      found.p.sale_status === 'selling',
      '옵션을 찾을 수 없습니다.',
      'NOT_FOUND',
      404
    );

    const cart = cartOf(user);
    const next = (cart.get(id) || 0) + q;

    required(
      stockOk(found.v, next),
      '재고가 부족합니다.',
      'INSUFFICIENT_STOCK',
      409
    );

    cart.set(id, next);

    return {
      product_variant_id: id,
      quantity: next
    };
  }

  if (
    parts[0] === 'cart' &&
    parts[1] === 'items' &&
    parts.length === 3
  ) {
    const id = parts[2];
    const cart = cartOf(user);

    required(
      cart.has(id),
      '장바구니 항목이 없습니다.',
      'NOT_FOUND',
      404
    );

    if (method === 'DELETE') {
      cart.delete(id);
      return { deleted: true };
    }

    if (method === 'PATCH') {
      const found = variantOf(id);

      required(
        found && stockOk(found.v, b.quantity),
        '재고가 부족합니다.',
        'INSUFFICIENT_STOCK',
        409
      );

      cart.set(id, b.quantity);

      return {
        product_variant_id: id,
        quantity: b.quantity
      };
    }
  }

  if (path === '/wishlist' && method === 'GET') {
    return [...wishlistOf(user)];
  }

  if (parts[0] === 'wishlist' && parts.length === 2) {
    const id = parts[1];
    const list = wishlistOf(user);

    if (method === 'PUT') {
      required(
        productOf(id) && publicProduct(productOf(id)),
        '상품이 없습니다.',
        'NOT_FOUND',
        404
      );

      list.add(id);
    } else if (method === 'DELETE') {
      list.delete(id);
    } else {
      error(
        'METHOD_NOT_ALLOWED',
        '지원하지 않는 요청입니다.'
      );
    }

    return [...list];
  }

  if (path === '/orders' && method === 'POST') {
    return createOrder(b);
  }

  if (path === '/orders' && method === 'GET') {
    required(
      url.searchParams.get('user_id'),
      '회원 ID가 없습니다.'
    );

    return orders.filter(o => o.user_id === user);
  }

  if (
    parts[0] === 'orders' &&
    parts.length === 2 &&
    method === 'GET'
  ) {
    const o = orders.find(
      o => o.id === parts[1] && o.user_id === user
    );

    required(o, '주문이 없습니다.', 'NOT_FOUND', 404);

    return o;
  }

  if (path === '/claims' && method === 'GET') {
    return claimService.listForUser(String(url.searchParams.get('user_id') || '').trim());
  }

  if (path === '/claims' && method === 'POST') {
    return claimService.create(b);
  }

  if (path === '/admin/orders' && method === 'GET') {
    return orders.map(adminOrder);
  }

  if (
    path === '/admin/orders/bulk-shipping' &&
    method === 'POST'
  ) {
    required(
      Array.isArray(b.order_ids) &&
      b.order_ids.length > 0 &&
      b.carrier,
      '주문·택배사를 확인해주세요.'
    );

    const update = b.order_ids.map(id => {
      const o = orders.find(x => x.id === id);

      required(
        o &&
        o.payment_status === 'paid' &&
        !['cancelled', 'exchangeReturn'].includes(o.admin_status),
        '발송 불가능한 주문입니다.'
      );

      const no = String(
        b.tracking_numbers?.[id] || ''
      ).trim();

      required(no, '송장번호가 없습니다.');

      return [o, no];
    });

    for (const [o, no] of update) {
      o.admin_status = 'shipped';
      o.carrier = b.carrier;
      o.tracking_number = no;
      o.delivery_status = 'shipped';

      for (const item of o.items) {
        item.carrier = b.carrier;
        item.tracking_number = no;
        item.delivery_status = 'registered';
      }
    }

    return update.map(([o]) => adminOrder(o));
  }

  if (
    parts[0] === 'admin' &&
    parts[1] === 'orders' &&
    parts.length === 3
  ) {
    const o = orders.find(o => o.id === parts[2]);

    required(
      o,
      '주문이 없습니다.',
      'NOT_FOUND',
      404
    );

    if (method === 'GET') {
      return adminOrder(o);
    }

    if (method === 'PATCH') {
      const s = b.order_status;
      const carrier = String(b.carrier || '');
      const tracking = String(b.tracking_number || '');

      required(
        [
          'newOrder',
          'paid',
          'preparing',
          'shipped',
          'delivered',
          'cancelled',
          'exchangeReturn'
        ].includes(s),
        '주문 상태가 올바르지 않습니다.'
      );

      const updates = b.items;

      if (updates != null) {
        required(
          Array.isArray(updates),
          '주문 상품 배송정보가 올바르지 않습니다.'
        );

        const seen = new Set();

        for (const row of updates) {
          const id = String(row?.product_variant_id || '');

          required(
            id && !seen.has(id),
            '상품 옵션 ID가 중복되거나 없습니다.'
          );

          seen.add(id);

          const item = o.items.find(
            i => i.product_variant_id === id
          );

          required(
            item,
            `주문에 없는 상품 옵션: ${id}`,
            'NOT_FOUND',
            404
          );
        }
      }

      const nextItems = o.items.map(item => {
        const row = updates?.find(
          x => x.product_variant_id === item.product_variant_id
        );

        return row
          ? {
              ...item,
              carrier: String(row.carrier ?? '').trim(),
              tracking_number: String(row.tracking_number ?? '').trim(),
              delivery_status: String(row.tracking_number || '').trim()
                ? (item.delivery_status === 'delivered'
                    ? 'delivered'
                    : 'registered')
                : 'preparing'
            }
          : item;
      });

      required(
        !['shipped', 'delivered'].includes(s) ||
        nextItems.every(
          i =>
            (i.carrier && i.tracking_number) ||
            (carrier && tracking)
        ),
        '상품마다 택배사와 운송장번호를 입력해주세요.'
      );

      required(
        !['cancelled', 'exchangeReturn'].includes(o.admin_status) ||
        o.admin_status === s,
        '완료된 주문 상태는 변경할 수 없습니다.'
      );

      Object.assign(o, {
        admin_status: s,
        carrier,
        tracking_number: tracking,
        items: nextItems,
        admin_memo: String(b.admin_memo || '')
      });

      if (['shipped', 'delivered'].includes(s)) {
        for (const item of o.items) {
          if (!item.carrier) item.carrier = carrier;
          if (!item.tracking_number) item.tracking_number = tracking;

          item.delivery_status =
            s === 'delivered' ? 'delivered' : 'registered';
        }
      }

      o.delivery_status = s === 'shipped'
        ? 'shipped'
        : s === 'delivered'
          ? 'delivered'
          : o.delivery_status;

      return adminOrder(o);
    }
  }

  if (path === '/admin/store-settings' && method === 'GET') {
    return settings;
  }

  if (path === '/admin/store-settings' && method === 'PUT') {
    required(
      Number.isInteger(b.shipping_fee) &&
      b.shipping_fee >= 0 &&
      Number.isInteger(b.free_shipping_threshold) &&
      b.free_shipping_threshold >= 0,
      '배송비가 올바르지 않습니다.'
    );

    settings = clone(b);

    return settings;
  }

  if (path === '/public/store-settings' && method === 'GET') {
    return settings;
  }

  if (path === '/admin/home-content') {
    if (method === 'GET') {
      return home;
    }

    if (method === 'PUT') {
      home = {
        ...clone(b),
        updated_at: date()
      };

      return home;
    }
  }

  if (path === '/public/home-content' && method === 'GET') {
    if (home.publish_status !== 'published') return null;
    const visibleProductIds = new Set(products.filter(p =>
      !p.deleted && p.publish_status === 'published' && p.sale_status !== 'hidden'
    ).map(p => p.id));
    return {
      ...clone(home),
      new_arrival_product_ids: (home.new_arrival_product_ids || [])
        .filter(id => visibleProductIds.has(id))
    };
  }

  if (path === '/admin/journals') {
    if (method === 'GET') {
      return journals;
    }

    if (method === 'POST') {
      required(
        !journals.some(j => j.id === b.id),
        '저널 ID 중복입니다.',
        'CONFLICT',
        409
      );

      journals.unshift(clone(b));

      return b;
    }
  }

  if (
    parts[0] === 'admin' &&
    parts[1] === 'journals' &&
    parts.length === 3
  ) {
    const i = journals.findIndex(
      j => j.id === parts[2]
    );

    required(
      i >= 0,
      '저널이 없습니다.',
      'NOT_FOUND',
      404
    );

    if (method === 'GET') {
      return journals[i];
    }

    if (method === 'PUT') {
      required(
        b.id === parts[2],
        '저널 ID가 다릅니다.'
      );

      journals[i] = {
        ...clone(b),
        created_at: journals[i].created_at
      };

      return journals[i];
    }
  }

  if (path === '/public/journals' && method === 'GET') {
    const visibleProductIds = new Set(products.filter(p =>
      !p.deleted && p.publish_status === 'published' && p.sale_status !== 'hidden'
    ).map(p => p.id));
    return journals.filter(j =>
      j.publish_status === 'published' && Date.parse(j.publish_at) <= Date.now()
    ).sort((a, b) => Date.parse(b.publish_at) - Date.parse(a.publish_at))
      .map(j => ({
        ...clone(j),
        related_product_ids: (j.related_product_ids || [])
          .filter(id => visibleProductIds.has(id))
      }));
  }

  if (parts[0] === 'public' && parts[1] === 'journals' &&
      parts.length === 3 && method === 'GET') {
    const j = journals.find(j => j.id === parts[2] &&
      j.publish_status === 'published' && Date.parse(j.publish_at) <= Date.now());
    required(j, '공개된 저널이 없습니다.', 'NOT_FOUND', 404);
    const visibleProductIds = new Set(products.filter(p =>
      !p.deleted && p.publish_status === 'published' && p.sale_status !== 'hidden'
    ).map(p => p.id));
    return {
      ...clone(j),
      related_product_ids: (j.related_product_ids || [])
        .filter(id => visibleProductIds.has(id))
    };
  }

  if (path === '/inquiries' && method === 'GET') {
    return inquiryService.listForUser(
      String(url.searchParams.get('user_id') || '').trim()
    );
  }

  if (path === '/inquiries' && method === 'POST') {
    return inquiryService.create(b);
  }

  if (path === '/admin/inquiries' && method === 'GET') {
    return clone(inquiries);
  }

  if (
    parts[0] === 'admin' &&
    parts[1] === 'inquiries' &&
    parts.length === 4 &&
    parts[3] === 'answer' &&
    method === 'PUT'
  ) {
    return inquiryService.answer(parts[2], b?.answer);
  }

  if (path === '/admin/claims' && method === 'GET') {
    return clone(claims);
  }

  if (parts[0] === 'admin' && parts[1] === 'claims' &&
      parts.length === 3 && method === 'PATCH') {
    return claimService.update(parts[2], b);
  }
  error(
    'NOT_FOUND',
    `경로를 찾을 수 없습니다: ${method} ${path}`,
    404
  );
}

function route(method, url, body) {
  // 문의 작성 및 답변은 SQLite 저장 실패 시 메모리 상태도 복구한다.
  if (
    (method === 'POST' && url.pathname === '/inquiries') ||
    (
      method === 'PUT' &&
      /^\/admin\/inquiries\/[^/]+\/answer$/.test(url.pathname)
    )
  ) {
    const before = clone(inquiries);

    try {
      const result = dispatchRoute(method, url, body);
      persistState();
      return result;
    } catch (e) {
      inquiries.splice(0, inquiries.length, ...before);
      throw e;
    }
  }
  // 클레임 변경은 SQLite 저장 성공 여부까지 확인한다.
  if ((method === 'POST' && url.pathname === '/claims') ||
      (method === 'PATCH' && url.pathname.startsWith('/admin/claims/'))) {
    const beforeClaims = clone(claims);
    try {
      const result = dispatchRoute(method, url, body);
      persistState();
      return result;
    } catch (error) {
      claims.splice(0, claims.length, ...beforeClaims);
      throw error;
    }
  }
  if (method !== 'POST' || url.pathname !== '/orders') {
    const isAccountMutation = method !== 'GET' && method !== 'OPTIONS' &&
      (url.pathname === '/mock/session' || url.pathname.startsWith('/users/'));
    const before = isAccountMutation ? accountService.snapshot() : null;
    try {
      const result = dispatchRoute(method, url, body);
      if (method !== 'GET' && method !== 'OPTIONS') persistState();
      return result;
    } catch (e) {
      if (before) accountService.restore(before);
      throw e;
    }
  }

  const userId = String(body?.user_id || '').trim();
  const requestKey = `${userId}:${String(body?.request_id || '').trim()}`;
  const cart = cartOf(userId);
  const cartBefore = new Map(cart);
  const stockBefore = products.flatMap(p =>
    p.variants.map(v => [v, v.stock_quantity])
  );
  const orderCount = orders.length;
  const previousRequest = completed.get(requestKey);

  try {
    const result = dispatchRoute(method, url, body);
    persistState();
    return result;
  } catch (error) {
    for (const [variant, stock] of stockBefore) {
      variant.stock_quantity = stock;
    }
    orders.splice(0, orders.length - orderCount);
    cart.clear();
    for (const [id, quantity] of cartBefore) cart.set(id, quantity);
    if (previousRequest) {
      completed.set(requestKey, previousRequest);
    } else {
      completed.delete(requestKey);
    }
    throw error;
  }
}

// Kakao Web Authentication

function cookieValue(request, name) {
  const cookies = String(
    request.headers.cookie || ''
  ).split(';');

  const value = cookies.find(
    item => item.trim().startsWith(`${name}=`)
  );

  return value
    ? value.trim().slice(name.length + 1)
    : null;
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

async function authRoute(method, path, body, req, res) {
  if (path === '/api/auth/session' && method === 'GET') {
    const token = cookieValue(req, SESSION_COOKIE);
    const session = token ? sessions.get(token) : null;

    if (!session || session.expiresAt < Date.now()) {
      if (token) sessions.delete(token);
      console.log('[KAKAO SESSION]', {
        authenticated: false,
        hasCookie: Boolean(token)
      });
      return null;
    }

    console.log('[KAKAO SESSION]', {
      authenticated: true,
      id: session.user.id,
      nickname: session.user.nickname,
      email: session.user.email,
      phone: session.user.phone ?? null
    });

    return session.user;
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = cookieValue(req, SESSION_COOKIE);

    if (token) sessions.delete(token);

    setSessionCookie(res, '', 0);

    return {
      signed_out: true
    };
  }

  if (
    path !== '/api/auth/kakao/exchange' ||
    method !== 'POST'
  ) {
    error(
      'NOT_FOUND',
      '인증 API 경로가 없습니다.',
      404
    );
  }

  required(
    KAKAO_REST_API_KEY,
    '서버 환경변수 KAKAO_REST_API_KEY를 설정해주세요.',
    'KAKAO_KEY_MISSING',
    503
  );

  const code = String(body?.code || '').trim();

  required(
    code,
    '카카오 인가 코드가 없습니다.'
  );

  required(
    body?.redirectUri === KAKAO_REDIRECT_URI,
    '카카오 Redirect URI가 서버 설정과 다릅니다.'
  );

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: KAKAO_REST_API_KEY,
    redirect_uri: KAKAO_REDIRECT_URI,
    code
  });

  if (KAKAO_CLIENT_SECRET) {
    params.set(
      'client_secret',
      KAKAO_CLIENT_SECRET
    );
  }

  let tokenResponse;

  try {
    tokenResponse = await fetch(
      'https://kauth.kakao.com/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
        },
        body: params,
        signal: AbortSignal.timeout(10000)
      }
    );
  } catch (_) {
    error(
      'KAKAO_NETWORK_ERROR',
      '카카오 토큰 서버에 연결할 수 없습니다.',
      502
    );
  }

  if (!tokenResponse.ok) {
    error(
      'KAKAO_TOKEN_ERROR',
      '카카오 토큰 발급 실패: REST API 키, 리다이렉트 URI, 인가 코드 유효성을 확인해주세요.',
      401
    );
  }

  const tokenJson = await tokenResponse.json();

  required(
    tokenJson.access_token,
    '카카오 액세스 토큰이 없습니다.',
    'KAKAO_TOKEN_ERROR',
    502
  );

  let userResponse;

  try {
    userResponse = await fetch(
      'https://kapi.kakao.com/v2/user/me',
      {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`
        },
        signal: AbortSignal.timeout(10000)
      }
    );
  } catch (_) {
    error(
      'KAKAO_NETWORK_ERROR',
      '카카오 사용자 정보 서버에 연결할 수 없습니다.',
      502
    );
  }

  if (!userResponse.ok) {
    error(
      'KAKAO_USER_ERROR',
      '카카오 사용자 정보를 조회하지 못했습니다.',
      502
    );
  }

  const kakaoUser = await userResponse.json();

  console.log('[KAKAO RAW USER]', {
    kakaoId: kakaoUser.id ?? null,
    profileNickname: kakaoUser.kakao_account?.profile?.nickname ?? null,
    propertiesNickname: kakaoUser.properties?.nickname ?? null,
    accountName: kakaoUser.kakao_account?.name ?? null,
    email: kakaoUser.kakao_account?.email ?? null,
    phoneNumber: kakaoUser.kakao_account?.phone_number ?? null,
    hasEmail: kakaoUser.kakao_account?.has_email ?? null,
    hasPhoneNumber: kakaoUser.kakao_account?.has_phone_number ?? null,
    nicknameNeedsAgreement:
      kakaoUser.kakao_account?.profile_nickname_needs_agreement ?? null
  });

  required(
    kakaoUser.id != null,
    '카카오 사용자 ID가 없습니다.',
    'KAKAO_USER_ERROR',
    502
  );

  const profile = kakaoUser.kakao_account?.profile || {};
  const realNickname = [
    profile.nickname,
    kakaoUser.properties?.nickname,
    kakaoUser.kakao_account?.name
  ].find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || '';

  const user = {
    id: String(kakaoUser.id),
    nickname: realNickname,
    email: kakaoUser.kakao_account?.email || null,
    phone: kakaoUser.kakao_account?.phone_number || null,
    profileImageUrl: profile.thumbnail_image_url || null
  };

  console.log('[KAKAO MAPPED USER]', {
    id: user.id,
    nickname: user.nickname,
    nicknameMissing: user.nickname.length === 0,
    email: user.email,
    phone: user.phone
  });

  const sessionId = crypto.randomBytes(32).toString('hex');

  sessions.set(sessionId, {
    user,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  });

  setSessionCookie(
    res,
    sessionId,
    86400
  );

  return user;
}

// HTTP Server

const server = http.createServer(async (req, res) => {
  const isAuth = req.url?.startsWith('/api/auth/') === true;
  const origin = req.headers.origin;

  if (isAuth) {
    if (origin && origin !== KAKAO_WEB_ORIGIN) {
      res.writeHead(403);
      res.end(JSON.stringify({
        success: false,
        error: {
          code: 'ORIGIN_DENIED',
          message: '허용되지 않은 요청 출처입니다.'
        }
      }));
      return;
    }

    if (origin) {
      res.setHeader(
        'Access-Control-Allow-Origin',
        KAKAO_WEB_ORIGIN
      );

      res.setHeader(
        'Access-Control-Allow-Credentials',
        'true'
      );

      res.setHeader('Vary', 'Origin');
    }
  } else {
    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const chunks = [];
    let totalSize = 0;

    for await (const chunk of req) {
      totalSize += chunk.length;

      // 관리자의 30MB 동영상은 Base64 전송 시 약 40MB가 된다.
      const maxBytes = req.method === 'PUT' &&
        req.url?.split('?')[0] === '/admin/home-content'
        ? 42 * 1024 * 1024 : 10 * 1024 * 1024;
      if (totalSize > maxBytes) {
        error(
          'PAYLOAD_TOO_LARGE',
          '요청 크기가 너무 큽니다.',
          413
        );
      }

      chunks.push(chunk);
    }

    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : null;

    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    const trackingParts = url.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);

    const isTracking =
      req.method === 'GET' &&
      trackingParts.length === 5 &&
      trackingParts[0] === 'orders' &&
      trackingParts[2] === 'items' &&
      trackingParts[4] === 'tracking';

    let data;

    if (isAuth) {
      data = await authRoute(
        req.method,
        url.pathname,
        body,
        req,
        res
      );
    } else if (isTracking) {
      const order = orders.find(
        o =>
          o.id === trackingParts[1] &&
          o.user_id === url.searchParams.get('user_id')
      );

      required(
        order,
        '주문을 찾을 수 없습니다.',
        'NOT_FOUND',
        404
      );

      const item = order.items.find(
        i => i.order_item_id === trackingParts[3]
      );

      required(
        item,
        '주문 상품을 찾을 수 없습니다.',
        'NOT_FOUND',
        404
      );

      data = await lookupDelivery(item);
    } else {
      data = route(req.method, url, body);
    }

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      data
    }));
  } catch (e) {
    res.writeHead(e.status || 500);
    res.end(JSON.stringify({
      success: false,
      error: {
        code: e.code || 'INTERNAL_ERROR',
        message: e.message
      }
    }));
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`DEUX Mock API http://${HOST}:${PORT}`);
    console.log('[KAKAO CONFIG]', {
      restApiKeyConfigured: KAKAO_REST_API_KEY.length > 0,
      clientSecretConfigured: KAKAO_CLIENT_SECRET.length > 0,
      redirectUri: KAKAO_REDIRECT_URI,
      pid: process.pid,
    });
  });
}

module.exports = {
  server,
  route,
  products,
  carts,
  orders
};
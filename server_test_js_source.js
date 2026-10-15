'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deux-api-test-'));
process.env.MOCK_DB_PATH = path.join(testDir, 'mock.sqlite');
process.on('exit', () => fs.rmSync(testDir, { recursive: true, force: true }));

const { route, server } = require('./server_js_source');
const call = (method,path,body) => route(method,new URL(path,'http://localhost'),body);
test('common products, cart, payment failure, order, admin, inventory and idempotency', () => {
  const first = call('GET','/shop/products')[0];
  assert.equal(first.id,'P001');
  const id = first.variants[0].id;
  const stockBefore = first.variants[0].stock_quantity;
  call('POST','/cart/items?user_id=qa-test',{product_variant_id:id,quantity:1});
  const body={user_id:'qa-test',request_id:'qa-request-1',recipient_name:'Tester',recipient_phone:'01012345678',postcode:'12345',address:'Seoul',payment_method:'card'};
  assert.throws(()=>call('POST','/orders',{...body,simulate_payment_failure:true}), {code:'PAYMENT_FAILED'});
  assert.equal(call('GET','/cart?user_id=qa-test').length,1);
  assert.equal(call('GET','/shop/products')[0].variants[0].stock_quantity,stockBefore);
  const placed = call('POST','/orders',body);
  assert.equal(call('POST','/orders',body).id,placed.id);
  assert.equal(call('GET','/shop/products')[0].variants[0].stock_quantity,stockBefore-1);
  assert.equal(call('GET','/cart?user_id=qa-test').length,0);
  assert.equal(call('GET','/admin/orders')[0].id,placed.id);
  assert.equal(call('GET',`/orders/${placed.id}?user_id=qa-test`).id,placed.id);
  assert.throws(()=>call('GET',`/orders/${placed.id}?user_id=other`),{code:'NOT_FOUND'});
  const updated=call('PATCH',`/admin/orders/${placed.id}`,{order_status:'shipped',carrier:'CJ',tracking_number:'123',admin_memo:'ok'});
  assert.equal(updated.order_status,'shipped');
  assert.equal(call('GET',`/orders/${placed.id}?user_id=qa-test`).delivery_status,'shipped');
});
test('admin inventory edit visible on shop',()=>{
 const current=call('GET','/shop/products')[0];
 call('PATCH',`/products/${current.id}/inventory`,{color:'BLACK',size:'M',quantity:17});
 assert.equal(call('GET','/shop/products')[0].variants[0].stock_quantity,17);
});
test('bulk shipping rejects partial batch and accepts complete batch', () => {
  const variantId=call('GET','/shop/products')[1].variants[0].id;
  call('POST','/cart/items?user_id=bulk-test',{product_variant_id:variantId,quantity:1});
  const o=call('POST','/orders',{user_id:'bulk-test',request_id:'bulk-1',recipient_name:'Bulk',recipient_phone:'01012345678',postcode:'12345',address:'Seoul',payment_method:'card'});
  assert.throws(()=>call('POST','/admin/orders/bulk-shipping',{order_ids:[o.id,'invalid'],carrier:'CJ',tracking_numbers:{[o.id]:'789',invalid:'000'}}),{code:'VALIDATION_ERROR'});
  assert.equal(call('GET',`/admin/orders/${o.id}`).order_status,'paid');
  call('POST','/admin/orders/bulk-shipping',{order_ids:[o.id],carrier:'CJ',tracking_numbers:{[o.id]:'789'}});
  assert.equal(call('GET',`/admin/orders/${o.id}`).order_status,'shipped');
});

test('encoded variant ID supports quantity update and option delete', () => {
  const product = call('GET', '/shop/products')[0];
  const id = product.variants[1].id;
  const urlId = encodeURIComponent(id);
  call('POST', '/cart/items?user_id=encoded-variant', {product_variant_id:id, quantity:1});
  const changed = call('PATCH', `/cart/items/${urlId}?user_id=encoded-variant`, {quantity:2});
  assert.equal(changed.quantity, 2);
  call('DELETE', `/cart/items/${urlId}?user_id=encoded-variant`);
  assert.equal(call('GET', '/cart?user_id=encoded-variant').length, 0);
});

test('direct purchase deducts only selected item and preserves existing cart', () => {
  const products = call('GET', '/shop/products');
  const cartVariant = products[0].variants[2].id;
  const directVariant = products[1].variants[1].id;
  const stock = id => call('GET', '/shop/products')
    .flatMap(product => product.variants)
    .find(variant => variant.id === id).stock_quantity;
  const cartStock = stock(cartVariant);
  const directStock = stock(directVariant);
  call('POST', '/cart/items?user_id=direct-test', {
    product_variant_id: cartVariant, quantity: 1
  });
  const body = {
    user_id: 'direct-test', request_id: 'direct-1',
    recipient_name: 'Direct', recipient_phone: '01012345678',
    postcode: '12345', address: 'Seoul', payment_method: 'card',
    items: [{ product_variant_id: directVariant, quantity: 1 }]
  };
  const order = call('POST', '/orders', body);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].product_variant_id, directVariant);
  assert.equal(stock(cartVariant), cartStock);
  assert.equal(stock(directVariant), directStock - 1);
  assert.deepEqual(call('GET', '/cart?user_id=direct-test'), [
    { product_variant_id: cartVariant, quantity: 1 }
  ]);
  assert.equal(call('POST', '/orders', body).id, order.id);
  assert.equal(stock(directVariant), directStock - 1);
});

test('multi-item cart checkout deducts correct variants once and clears cart', () => {
  const products = call('GET', '/shop/products');
  const ids = [products[0].variants[3].id, products[1].variants[3].id];
  const stock = id => call('GET', '/shop/products')
    .flatMap(product => product.variants)
    .find(variant => variant.id === id).stock_quantity;
  const before = ids.map(stock);
  ids.forEach(id => call('POST', '/cart/items?user_id=cart-checkout', {
    product_variant_id: id, quantity: 1
  }));
  const body = {
    user_id: 'cart-checkout', request_id: 'cart-one',
    recipient_name: 'Customer', recipient_phone: '01012345678',
    postcode: '12345', address: 'Seoul', payment_method: 'card'
  };
  const order = call('POST', '/orders', body);
  assert.deepEqual(order.items.map(item => item.product_variant_id), ids);
  ids.forEach((id, i) => assert.equal(stock(id), before[i] - 1));
  assert.deepEqual(call('GET', '/cart?user_id=cart-checkout'), []);
  assert.equal(call('POST', '/orders', body).id, order.id);
  ids.forEach((id, i) => assert.equal(stock(id), before[i] - 1));
});

test('invalid purchase and simulated failure keep cart, stock and orders unchanged', () => {
  const products = call('GET', '/shop/products');
  const id = products[1].variants[4].id;
  const before = products[1].variants[4].stock_quantity;
  const orderCount = call('GET', '/admin/orders').length;
  call('POST', '/cart/items?user_id=fail-test', { product_variant_id: id, quantity: 1 });
  const body = {
    user_id: 'fail-test', request_id: 'failed-1',
    recipient_name: 'Fail', recipient_phone: '01012345678',
    postcode: '12345', address: 'Seoul', payment_method: 'card'
  };
  assert.throws(() => call('POST', '/orders', { ...body, simulate_payment_failure: true }), {
    code: 'PAYMENT_FAILED'
  });
  assert.throws(() => call('POST', '/orders', { ...body, items: [{ product_variant_id: 'missing', quantity: 1 }] }), {
    code: 'INSUFFICIENT_STOCK'
  });
  assert.equal(call('GET', '/admin/orders').length, orderCount);
  assert.deepEqual(call('GET', '/cart?user_id=fail-test'), [
    { product_variant_id: id, quantity: 1 }
  ]);
  assert.equal(call('GET', '/shop/products')[1].variants[4].stock_quantity, before);
});

test('orders, stock and retained cart survive loading in a new process', () => {
  const snapshot = {
    orderCount: call('GET', '/admin/orders').length,
    stock: call('GET', '/shop/products')[0].variants[0].stock_quantity,
    cart: call('GET', '/cart?user_id=direct-test')
  };
  const script = `
    const { route } = require('./server_js_source');
    const call = (m, p) => route(m, new URL(p, 'http://localhost'));
    process.stdout.write(JSON.stringify({
      orderCount: call('GET', '/admin/orders').length,
      stock: call('GET', '/shop/products')[0].variants[0].stock_quantity,
      cart: call('GET', '/cart?user_id=direct-test')
    }));
  `;
  const restored = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname, encoding: 'utf8', env: process.env
  }));
  assert.deepEqual(restored, snapshot);
});

test('real HTTP POST and GET use shared persisted mock API', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = await fetch(`${url}/cart/items?user_id=http-test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_variant_id: call('GET', '/shop/products')[2].variants[1].id,
        quantity: 1
      })
    });
    assert.equal(post.status, 200);
    assert.equal((await post.json()).success, true);
    const get = await fetch(`${url}/cart?user_id=http-test`);
    assert.equal(get.status, 200);
    const data = await get.json();
    assert.equal(data.success, true);
    assert.equal(data.data.length, 1);
  } finally {
    await new Promise((resolve, reject) =>
      server.close(err => err ? reject(err) : resolve())
    );
  }
});

test('customer claims: per-item limits, user isolation, manager updates, restart persistence', () => {
  const user = 'claims-user';
  const available = call('GET','/shop/products')[0].variants.filter(v => v.stock_quantity >= 2);
  assert.ok(available.length >= 2);
  const order = call('POST','/orders',{
    user_id:user,request_id:'claims-order-1',recipient_name:'Claims',recipient_phone:'01012345678',
    postcode:'12345',address:'Seoul',payment_method:'card',
    items: available.slice(0,2).map(v=>({product_variant_id:v.id,quantity:2}))
  });
  assert.equal(order.items.length,2);
  const item0 = order.items[0];
  const item1 = order.items[1];
  const create = (request_id, opts={}) => call('POST','/claims',{
    user_id:user,order_id:order.id,order_item_id:item0.order_item_id,
    claim_type:'cancel',quantity:1,reason:'사이즈 변경 요청',request_id,...opts
  });
  assert.throws(()=>create('foreign',{user_id:'other'}),{code:'NOT_FOUND'});
  assert.throws(()=>create('badQty',{quantity:3}),{code:'QUANTITY_EXCEEDED'});
  const c1 = create('cancel-1');
  assert.equal(create('cancel-1').id,c1.id);
  assert.throws(()=>create('cancel-1',{quantity:2}),{code:'CONFLICT'});
  assert.equal(call('GET',`/claims?user_id=${user}`).length,1);
  assert.equal(call('GET','/claims?user_id=someone-else').length,0);
  assert.throws(()=>create('cancel-2',{quantity:2}),{code:'QUANTITY_EXCEEDED'});
  assert.throws(()=>call('PATCH',`/admin/claims/${c1.id}`,{user_id:'someone-else'}),{code:'VALIDATION_ERROR'});
  assert.throws(()=>call('PATCH',`/admin/claims/${c1.id}`,{process_status:'completed'}),{code:'INVALID_STATUS'});
  const approved = call('PATCH',`/admin/claims/${c1.id}`,{process_status:'approved'});
  assert.equal(approved.process_status,'approved');
  const completedClaim = call('PATCH',`/admin/claims/${c1.id}`,{process_status:'completed',refund_status:'completed'});
  assert.equal(completedClaim.process_status,'completed');
  const c2 = create('cancel-2');
  assert.equal(c2.quantity,1);

  const shipped = call('PATCH',`/admin/orders/${order.id}`,{
    order_status:'shipped',carrier:'CJ',tracking_number:'CL123',
    items:[{product_variant_id:item0.product_variant_id,carrier:'CJ',tracking_number:'CL000'},
      {product_variant_id:item1.product_variant_id,carrier:'CJ',tracking_number:'CL001'}]
  });
  assert.equal(shipped.order_status,'shipped');
  assert.throws(()=>create('late-cancel',{order_item_id:item1.order_item_id}),{code:'INVALID_STATUS'});
  const exchanged=call('POST','/claims',{
    user_id:user,order_id:order.id,order_item_id:item1.order_item_id,claim_type:'exchange',
    exchange_variant_id:item0.product_variant_id,quantity:1,reason:'다른 색상 요청',request_id:'exchange-1'
  });
  assert.equal(exchanged.claim_type,'exchange');
  assert.throws(()=>call('POST','/claims',{
    user_id:user,order_id:order.id,order_item_id:item1.order_item_id,claim_type:'returnItem',
    quantity:2,reason:'반품 요청',request_id:'return-bad'
  }),{code:'QUANTITY_EXCEEDED'});
  const returnClaim=call('POST','/claims',{
    user_id:user,order_id:order.id,order_item_id:item1.order_item_id,claim_type:'returnItem',
    quantity:1,reason:'반품 요청',request_id:'return-1'
  });
  assert.equal(returnClaim.quantity,1);
  assert.equal(call('GET','/admin/claims').filter(c=>c.user_id===user).length,4);
  const script=`const {route}=require('./server_js_source'); const get=(p)=>route('GET',new URL(p,'http://localhost'));process.stdout.write(JSON.stringify(get('/claims?user_id=claims-user').map(c=>c.id)));`;
  const ids=JSON.parse(execFileSync(process.execPath,['-e',script],{
    cwd:__dirname,encoding:'utf8',env:process.env
  }));
  assert.equal(ids.length,4);
  assert.ok(ids.includes(c1.id));
});

test('notification settings are validated, member-scoped, and persisted', () => {
  const a = call('POST', '/mock/session', {provider_user_id:'pref-a',nickname:'A'}).id;
  const b = call('POST', '/mock/session', {provider_user_id:'pref-b',nickname:'B'}).id;
  const endpoint = id => `/users/${encodeURIComponent(id)}/notification-preferences`;

  assert.deepEqual(call('GET',endpoint(a)), {
    order_updates:true,new_arrivals:true,promotions:false
  });

  const update = {
    order_updates:false,new_arrivals:false,promotions:true
  };

  assert.deepEqual(call('PUT',endpoint(a),update),update);
  assert.deepEqual(call('GET',endpoint(b)), {
    order_updates:true,new_arrivals:true,promotions:false
  });

  assert.throws(
    ()=>call('PUT',endpoint(a),{...update,promotions:'yes'}),
    {code:'VALIDATION_ERROR'}
  );

  assert.deepEqual(call('GET',endpoint(a)),update);

  const script=`
    const {route}=require('./server_js_source');
    process.stdout.write(JSON.stringify(
      route('GET',new URL(
        '/users/${encodeURIComponent(a)}/notification-preferences',
        'http://localhost'
      ))
    ));
  `;

  const loaded=JSON.parse(execFileSync(process.execPath,['-e',script],{
    cwd:__dirname,
    encoding:'utf8',
    env:process.env
  }));

  assert.deepEqual(loaded,update);
});

test('published video hero keeps its source metadata through public API', () => {
  const home = call('GET','/admin/home-content');
  const update = structuredClone(home);

  update.hero.media_name = 'demo.webm';
  update.hero.media_base64 =
    Buffer.from('mock video byte sample').toString('base64');
  update.hero.is_video = true;
  update.publish_status = 'published';

  call('PUT','/admin/home-content',update);

  const result=call('GET','/public/home-content');

  assert.equal(result.hero.media_name,'demo.webm');
  assert.equal(result.hero.is_video,true);
  assert.equal(
    result.hero.media_base64,
    update.hero.media_base64
  );
});

test('tracking uses order-item id and displays independent mock states', async () => {
  const id = 'tracking-user';

  const variants = call('GET','/shop/products')[0].variants
    .filter(v=>v.stock_quantity>0);

  assert.ok(variants.length >= 2);

  const order=call('POST','/orders',{
    user_id:id,
    request_id:'tracking-order',
    recipient_name:'Customer',
    recipient_phone:'01012345678',
    postcode:'12345',
    address:'Seoul',
    payment_method:'card',
    items: variants.slice(0,2).map(v=>({
      product_variant_id:v.id,
      quantity:1
    }))
  });

  const item0=order.items[0];
  const item1=order.items[1];

  assert.ok(item0.order_item_id && item1.order_item_id);

  await new Promise(resolve=>
    server.listen(0,'127.0.0.1',resolve)
  );

  try {
    const base=`http://127.0.0.1:${server.address().port}`;

    const get = async (user,item) => {
      const response=await fetch(
        `${base}/orders/${encodeURIComponent(order.id)}/items/${encodeURIComponent(item)}/tracking?user_id=${user}`
      );

      return [
        response.status,
        (await response.json())
      ];
    };

    assert.equal(
      (await get(id,item0.order_item_id))[1].data.status,
      'preparing'
    );

    assert.equal(
      (await get('wrong-user',item0.order_item_id))[0],
      404
    );

    call('PATCH',`/admin/orders/${order.id}`,{
      order_status:'paid',
      items:[
        {
          product_variant_id:item0.product_variant_id,
          carrier:'CJ',
          tracking_number:'MOCK-IN-TRANSIT'
        },
        {
          product_variant_id:item1.product_variant_id,
          carrier:'CJ',
          tracking_number:'MOCK-DELIVERED'
        }
      ]
    });

    assert.equal(
      (await get(id,item0.order_item_id))[1].data.status,
      'in_transit'
    );

    assert.equal(
      (await get(id,item1.order_item_id))[1].data.status,
      'delivered'
    );

    call('PATCH',`/admin/orders/${order.id}`,{
      order_status:'paid',
      items:[
        {
          product_variant_id:item1.product_variant_id,
          carrier:'CJ',
          tracking_number:'MOCK-API-ERROR'
        }
      ]
    });

    assert.equal(
      (await get(id,item1.order_item_id))[1].data.source,
      'error'
    );

    assert.equal(
      (await get(id,item0.product_variant_id))[0],
      404
    );

  } finally {
    await new Promise((resolve,reject)=>
      server.close(err=>err?reject(err):resolve())
    );
  }
});

test('video home upload accepts Base64 payload larger than default 10MB limit', async () => {
  await new Promise(resolve=>
    server.listen(0,'127.0.0.1',resolve)
  );

  try {
    const data=structuredClone(
      call('GET','/admin/home-content')
    );

    data.hero.is_video=true;
    data.hero.media_name='demo.mp4';
    data.hero.media_base64=
      Buffer.alloc(8*1024*1024).toString('base64');

    const response=await fetch(
      `http://127.0.0.1:${server.address().port}/admin/home-content`,
      {
        method:'PUT',
        headers:{
          'Content-Type':'application/json'
        },
        body:JSON.stringify(data)
      }
    );

    assert.equal(response.status,200);

    const result=await response.json();

    assert.equal(
      result.data.hero.media_base64.length,
      data.hero.media_base64.length
    );

  } finally {
    await new Promise((resolve,reject)=>
      server.close(err=>err?reject(err):resolve())
    );
  }
});
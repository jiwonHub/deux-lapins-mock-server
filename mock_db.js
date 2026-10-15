'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(
  process.env.MOCK_DB_PATH || path.join(__dirname, 'deux_lapins_mock.sqlite')
);

db.exec(`
  CREATE TABLE IF NOT EXISTS mock_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ordered_at TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    total_amount INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mock_orders_user_id
    ON mock_orders(user_id);
  CREATE TABLE IF NOT EXISTS mock_order_items (
    order_id TEXT NOT NULL,
    line_index INTEGER NOT NULL,
    product_variant_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    carrier TEXT DEFAULT NULL,
    tracking_number TEXT DEFAULT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'preparing',
    PRIMARY KEY(order_id, line_index)
  );
`);

// 기존 DB를 유지하면서 상품별 배송정보 컬럼 추가
const shipmentColumns = [
    ['carrier', "TEXT NOT NULL DEFAULT ''"],
    ['tracking_number', "TEXT NOT NULL DEFAULT ''"],
    ['delivery_status', "TEXT NOT NULL DEFAULT 'preparing'"]
  ];
  
  const existingColumns = new Set(
    db.prepare('PRAGMA table_info(mock_order_items)')
      .all()
      .map(column => column.name)
  );
  
  for (const [name, definition] of shipmentColumns) {
    if (!existingColumns.has(name)) {
      db.exec(
        `ALTER TABLE mock_order_items ADD COLUMN ${name} ${definition}`
      );
    }
  }
  
  const trackingOrNull = value => String(value ?? '').trim();

  const saveState = db.prepare(`
  INSERT INTO mock_state (id, payload) VALUES (1, ?)
  ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
`);

const saveOrder = db.prepare(`
  INSERT INTO mock_orders
    (id, user_id, ordered_at, payment_status, total_amount, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const saveOrderItem = db.prepare(`
    INSERT INTO mock_order_items (
      order_id,
      line_index,
      product_variant_id,
      quantity,
      unit_price,
      carrier,
      tracking_number,
      delivery_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

function loadMockData() {
  const state = db.prepare('SELECT payload FROM mock_state WHERE id = 1').get();
  if (!state) return null;

  const saved = JSON.parse(state.payload);
  saved.orders = db.prepare(
    'SELECT payload FROM mock_orders ORDER BY ordered_at DESC, rowid DESC'
  ).all().map(row => JSON.parse(row.payload));
  return saved;
}

function saveMockData(state) {
  const { orders, ...others } = state;
  db.exec('BEGIN IMMEDIATE');
  try {
    saveState.run(JSON.stringify(others));
    db.exec('DELETE FROM mock_order_items; DELETE FROM mock_orders;');
    for (const order of orders) {
      saveOrder.run(
        order.id, order.user_id, order.ordered_at,
        order.payment_status, order.total_amount, JSON.stringify(order)
      );
      order.items.forEach((item, index) => {
        saveOrderItem.run(
            order.id, index, item.product_variant_id,
            item.quantity, item.unit_price,
            trackingOrNull(item.carrier),
            trackingOrNull(item.tracking_number),
            item.delivery_status || 'preparing'
          );
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { loadMockData, saveMockData };
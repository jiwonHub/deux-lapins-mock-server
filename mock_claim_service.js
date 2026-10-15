'use strict';

const crypto = require('node:crypto');

// 고객/관리자가 함께 사용하는 클레임 API 계약.
// 실제 PG 환불이나 택배 회수는 수행하지 않는다.
class MockClaimService {
  constructor({ orders, claims, products }) {
    this.orders = orders;
    this.claims = claims;
    this.products = products;
  }

  fail(message, code = 'VALIDATION_ERROR', status = 400) {
    const err = new Error(message);
    err.code = code;
    err.status = status;
    throw err;
  }

  assert(ok, message, code, status) {
    if (!ok) this.fail(message, code, status);
  }

  orderItemId(order, index) {
    return order.items[index].order_item_id || `${order.id}:${index + 1}`;
  }

  listForUser(userId) {
    this.assert(userId, '로그인이 필요합니다.', 'UNAUTHORIZED', 401);
    return structuredClone(this.claims.filter(c => c.user_id === userId));
  }

  create(data = {}) {
    const userId = String(data.user_id || '').trim();
    const orderId = String(data.order_id || '').trim();
    const itemId = String(data.order_item_id || '').trim();
    const type = String(data.claim_type || '');
    const reason = String(data.reason || '').trim();
    const requestId = String(data.request_id || '').trim();
    const quantity = data.quantity;
    const exchangeVariantId = data.exchange_variant_id == null ? null :
      String(data.exchange_variant_id).trim();

    this.assert(userId && requestId && requestId.length <= 100,
      '회원 또는 요청 ID가 없습니다.', 'UNAUTHORIZED', 401);
    this.assert(['cancel', 'exchange', 'returnItem'].includes(type), '신청 유형이 올바르지 않습니다.');
    this.assert(reason.length >= 2 && reason.length <= 500, '사유를 2~500자로 입력해주세요.');
    this.assert(Number.isSafeInteger(quantity) && quantity > 0, '신청 수량이 올바르지 않습니다.');
    const order = this.orders.find(o => o.id === orderId && o.user_id === userId);
    this.assert(order && order.payment_status === 'paid', '처리 가능한 주문이 아닙니다.', 'NOT_FOUND', 404);
    const index = order.items.findIndex((_, i) => this.orderItemId(order, i) === itemId);
    this.assert(index >= 0, '주문에 없는 상품입니다.', 'NOT_FOUND', 404);
    const item = order.items[index];

    const previous = this.claims.find(c => c.user_id === userId && c.request_id === requestId);
    if (previous) {
      this.assert(previous.order_id === orderId && previous.order_item_id === itemId &&
        previous.claim_type === type && previous.quantity === quantity &&
        previous.reason === reason && (previous.exchange_variant_id || null) === exchangeVariantId,
      '요청 ID가 이미 다른 신청에 사용되었습니다.', 'CONFLICT', 409);
      return structuredClone(previous);
    }

    const tracked = Boolean(String(item.tracking_number || '').trim());
    if (type === 'cancel') {
      this.assert(!tracked && !['shipped', 'delivered', 'cancelled'].includes(order.admin_status),
        '이미 발송된 상품은 취소할 수 없습니다. 반품을 신청해주세요.', 'INVALID_STATUS', 409);
      this.assert(!exchangeVariantId, '취소에는 교환 옵션을 지정할 수 없습니다.');
    } else {
      this.assert(tracked || ['shipped', 'delivered'].includes(order.admin_status),
        '발송 전 상품은 주문 취소를 신청해주세요.', 'INVALID_STATUS', 409);
      if (type === 'exchange') {
        const variant = this.products.flatMap(p => p.variants.map(v => ({ p, v })))
          .find(row => !row.p.deleted && row.p.id === item.product_id &&
            row.v.id === exchangeVariantId && row.v.is_active !== false);
        this.assert(variant, '교환할 같은 상품의 옵션을 선택해주세요.', 'VALIDATION_ERROR');
      } else {
        this.assert(!exchangeVariantId, '반품에는 교환 옵션을 지정할 수 없습니다.');
      }
    }

    const reserved = this.claims.filter(c =>
      c.order_item_id === itemId && c.order_id === orderId && c.process_status !== 'rejected'
    ).reduce((sum, c) => sum + c.quantity, 0);
    this.assert(quantity + reserved <= item.quantity,
      '구매 수량보다 많이 신청할 수 없습니다.', 'QUANTITY_EXCEEDED', 409);

    const claim = {
      id: `CL-${crypto.randomUUID()}`,
      request_id: requestId,
      user_id: userId,
      order_id: orderId,
      order_item_id: itemId,
      product_name: item.product_name,
      color_name: item.color_name,
      size_name: item.size_name,
      quantity,
      exchange_variant_id: exchangeVariantId,
      customer_name: order.recipient_name,
      claim_type: type,
      reason,
      requested_at: new Date().toISOString(),
      pickup_status: type === 'cancel' ? 'notRequired' : 'waiting',
      process_status: 'requested',
      refund_status: type === 'exchange' ? 'none' : 'waiting',
      admin_memo: ''
    };
    this.claims.unshift(claim);
    return structuredClone(claim);
  }

  update(claimId, data = {}) {
    const claim = this.claims.find(c => c.id === claimId);
    this.assert(claim, '클레임이 없습니다.', 'NOT_FOUND', 404);
    const allowed = new Set(['pickup_status', 'process_status', 'refund_status', 'admin_memo']);
    this.assert(Object.keys(data).every(k => allowed.has(k)), '수정할 수 없는 필드입니다.');
    const pickup = data.pickup_status ?? claim.pickup_status;
    const process = data.process_status ?? claim.process_status;
    const refund = data.refund_status ?? claim.refund_status;
    const memo = data.admin_memo ?? claim.admin_memo;
    this.assert(['notRequired', 'waiting', 'requested', 'collected'].includes(pickup) &&
      ['requested', 'processing', 'approved', 'rejected', 'completed'].includes(process) &&
      ['none', 'waiting', 'completed'].includes(refund) &&
      typeof memo === 'string' && memo.length <= 1000, '클레임 상태나 메모가 올바르지 않습니다.');
    this.assert(claim.process_status !== 'completed' && claim.process_status !== 'rejected' ||
      process === claim.process_status, '종결된 신청의 처리 상태는 변경할 수 없습니다.', 'INVALID_STATUS', 409);
    this.assert(process !== 'completed' || claim.process_status === 'approved' || claim.process_status === 'completed',
      '승인 후 완료 처리할 수 있습니다.', 'INVALID_STATUS', 409);
    this.assert(claim.claim_type !== 'exchange' || refund === 'none',
      '교환 건은 환불 상태를 설정할 수 없습니다.');
    this.assert(process !== 'rejected' || refund !== 'completed', '거절된 신청은 환불 완료로 처리할 수 없습니다.');
    Object.assign(claim, { pickup_status: pickup, process_status: process,
      refund_status: refund, admin_memo: memo });
    return structuredClone(claim);
  }
}

module.exports = { MockClaimService };
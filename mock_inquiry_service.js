'use strict';

const crypto = require('node:crypto');

// 고객과 관리자가 같은 문의 데이터를 사용한다.
// DB 영속 저장은 기존 서버의 persistState()가 담당한다.
class MockInquiryService {
  constructor({ inquiries, products }) {
    this.inquiries = inquiries;
    this.products = products;
  }

  fail(message, code = 'VALIDATION_ERROR', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    throw error;
  }

  require(condition, message, code, status) {
    if (!condition) this.fail(message, code, status);
  }

  listForUser(userId) {
    this.require(userId, '로그인이 필요합니다.', 'UNAUTHORIZED', 401);
    return structuredClone(
      this.inquiries.filter(row => row.customer_id === userId)
    );
  }

  create(body = {}) {
    const userId = String(body.user_id ?? '').trim();
    const requestId = String(body.request_id ?? '').trim();
    const type = String(body.inquiry_type ?? '').trim();
    const title = String(body.title ?? '').trim();
    const question = String(body.question ?? '').trim();
    const customerName = String(body.customer_name ?? '').trim();
    const productId = String(body.product_id ?? '').trim();

    this.require(
      userId && userId.length <= 100,
      '로그인이 필요합니다.',
      'UNAUTHORIZED',
      401
    );
    this.require(
      requestId && requestId.length <= 100,
      '요청 ID를 확인해주세요.'
    );
    this.require(
      ['oneToOne', 'product'].includes(type),
      '문의 유형이 올바르지 않습니다.'
    );
    this.require(
      title.length >= 2 && title.length <= 200,
      '제목은 2~200자로 입력해주세요.'
    );
    this.require(
      question.length >= 2 && question.length <= 5000,
      '문의 내용은 2~5000자로 입력해주세요.'
    );
    this.require(
      customerName.length > 0 && customerName.length <= 50,
      '작성자 정보를 확인해주세요.'
    );

    let product = null;

    if (type === 'product') {
      product = this.products.find(p =>
        p.id === productId &&
        !p.deleted &&
        p.publish_status === 'published' &&
        p.sale_status !== 'hidden'
      );

      this.require(
        product,
        '문의할 상품을 선택해주세요.',
        'NOT_FOUND',
        404
      );
    } else {
      this.require(
        !productId,
        '1:1 문의에는 상품을 지정할 수 없습니다.'
      );
    }

    const previous = this.inquiries.find(row =>
      row.customer_id === userId &&
      row.request_id === requestId
    );

    if (previous) {
      this.require(
        previous.inquiry_type === type &&
        previous.title === title &&
        previous.question === question &&
        previous.customer_name === customerName &&
        (previous.product_id || '') === productId,
        '이미 다른 문의에 사용된 요청 ID입니다.',
        'CONFLICT',
        409
      );

      return structuredClone(previous);
    }

    const row = {
      id: `INQ-${crypto.randomUUID()}`,
      request_id: requestId,
      customer_id: userId,
      customer_name: customerName,
      inquiry_type: type,
      title,
      question,
      product_id: product ? product.id : null,
      product_name: product ? product.name : null,
      status: 'unanswered',
      created_at: new Date().toISOString(),
      answer: '',
      answered_at: null
    };

    this.inquiries.unshift(row);

    return structuredClone(row);
  }

  answer(id, value) {
    const row = this.inquiries.find(item => item.id === id);

    this.require(
      row,
      '문의를 찾을 수 없습니다.',
      'NOT_FOUND',
      404
    );

    const answer = String(value ?? '').trim();

    this.require(
      answer.length > 0 && answer.length <= 5000,
      '답변은 1~5000자로 입력해주세요.'
    );

    Object.assign(row, {
      answer,
      status: 'answered',
      answered_at: new Date().toISOString()
    });

    return structuredClone(row);
  }
}

module.exports = { MockInquiryService };
'use strict';

const COURIERS = {
  'CJ대한통운': 'cj',
  'CJ': 'cj',
  'cj': 'cj',
  '한진택배': 'hanjin',
  '한진': 'hanjin',
  'hanjin': 'hanjin',
  '롯데택배': 'lotte',
  '롯데': 'lotte',
  'lotte': 'lotte',
  '우체국택배': 'post',
  '우체국': 'post',
  'post': 'post',
  '로젠택배': 'logen',
  '로젠': 'logen',
  'logen': 'logen'
};

async function lookupDelivery(item) {
  const trackingNumber = String(
    item.tracking_number || ''
  ).trim();

  if (!trackingNumber) {
    return {
      source: 'none',
      status: 'preparing',
      label: '운송장 미등록',
      tracking_number: ''
    };
  }

  const key = process.env.TAEKBAE_API_KEY || '';

  if (!String(item.carrier || '').trim()) {
    return {
      source: 'error', status: 'unknown',
      label: '배송조회 실패 · 택배사 미등록',
      tracking_number: trackingNumber
    };
  }

  if (!key) {
    const scenarios = {
      'MOCK-REGISTERED': ['registered', '운송장 등록'],
      'MOCK-COLLECTED': ['collected', '집화 완료'],
      'MOCK-IN-TRANSIT': ['in_transit', '배송 중'],
      'MOCK-DELIVERED': ['delivered', '배송 완료'],
      'MOCK-NOT-FOUND': ['unknown', '조회 실패 · 존재하지 않는 운송장'],
      'MOCK-API-ERROR': ['unknown', '조회 실패 · 배송조회 API 장애']
    };

    const labels = {
      preparing: '상품 준비 중',
      registered: '운송장 등록',
      collected: '집화 완료',
      shipped: '배송 중',
      in_transit: '배송 중',
      delivered: '배송 완료'
    };

    const savedStatus = String(item.delivery_status || '').trim();

    const [status, label] = scenarios[trackingNumber] || [
      Object.hasOwn(labels, savedStatus) ? savedStatus : 'unknown',
      labels[savedStatus] || '배송 상태 미확인'
    ];

    return {
      source: status === 'unknown' ? 'error' : 'mock',
      status,
      label,
      tracking_number: trackingNumber,
      checked_at: new Date().toISOString()
    };
  }

  const url = new URL(
    `https://taekbae.net/v1/tracking/${encodeURIComponent(trackingNumber)}`
  );

  const carrier = COURIERS[item.carrier];

  if (carrier) {
    url.searchParams.set('carrier', carrier);
  }

  url.searchParams.set('events', 'latest');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`
    },
    signal: AbortSignal.timeout(12000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      source: 'error',
      status: 'unknown',
      label: '택배사 조회 실패',
      tracking_number: trackingNumber,
      error: data.code || `HTTP_${response.status}`
    };
  }

  return {
    source: 'carrier',
    status: data.status?.code || 'unknown',
    label: data.status?.label || '배송 상태 확인 불가',
    tracking_number: data.tracking_number || trackingNumber,
    checked_at: data.as_of || null,
    last_event_at: data.last_event_at || null
  };
}

module.exports = {
  lookupDelivery
};
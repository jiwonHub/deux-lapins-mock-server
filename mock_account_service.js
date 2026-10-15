'use strict';

const crypto = require('node:crypto');

// 로컬 Mock API의 회원/배송지 비즈니스 로직.
// 저장은 서버의 기존 mock_state 트랜잭션과 함께 처리한다.
class MockAccountService {
  constructor(snapshot = {}) {
    this.restore(snapshot);
  }

  restore(snapshot = {}) {
    this.providers = new Map(snapshot.providers || []);
    this.profiles = new Map(snapshot.profiles || []);
    this.notificationPreferences = new Map(snapshot.notificationPreferences || []);
    this.addresses = new Map(
      (snapshot.addresses || []).map(([id, rows]) => [id, rows])
    );
  }

  snapshot() {
    return structuredClone({
      providers: [...this.providers],
      profiles: [...this.profiles],
      notificationPreferences: [...this.notificationPreferences],
      addresses: [...this.addresses]
    });
  }

  fail(code, message, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    throw error;
  }

  check(condition, message, code = 'VALIDATION_ERROR', status = 400) {
    if (!condition) this.fail(code, message, status);
  }

  profileData(data) {
    const name = String(data?.name ?? '').trim();
    const email = String(data?.email ?? '').trim();
    const phone = String(data?.phone ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    this.check(
      name.length > 0 && name.length <= 100 &&
      (email.length === 0 || (email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) &&
      (phone.length === 0 || (digits.length >= 9 && digits.length <= 15)),
      '이름·이메일·휴대폰 번호를 확인해주세요.'
    );
    return { name, email, phone };
  }

  addressData(data) {
    const recipient_name = String(data?.recipient_name ?? '').trim();
    const phone = String(data?.phone ?? '').trim();
    const postcode = String(data?.postcode ?? '').trim();
    const address = String(data?.address ?? '').trim();
    const detail_address = String(data?.detail_address ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    this.check(
      recipient_name.length > 0 && recipient_name.length <= 50 &&
      digits.length >= 9 && digits.length <= 15 &&
      postcode.length > 0 && postcode.length <= 10 &&
      address.length > 0 && address.length <= 200 &&
      detail_address.length <= 200,
      '수령인·연락처·우편번호·주소를 확인해주세요.'
    );
    return { recipient_name, phone, postcode, address, detail_address };
  }

  dispatch(method, url, data) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'POST' && url.pathname === '/mock/session') {
      const providerId = String(data?.provider_user_id ?? '').trim();
      this.check(providerId.length > 0 && providerId.length <= 100,
        '로그인 정보가 없습니다.', 'UNAUTHORIZED', 401);
      let id = this.providers.get(providerId);
      if (!id) {
        id = `mock-user-${crypto.randomUUID()}`;
        this.providers.set(providerId, id);
        this.profiles.set(id, {
          id,
          name: String(data?.nickname ?? '').trim().slice(0, 100),
          email: String(data?.email ?? '').trim().slice(0, 255),
          phone: ''
        });
        this.addresses.set(id, []);
      }
      // 다시 로그인해도 사용자가 변경한 프로필을 덮어쓰지 않는다.
      return structuredClone(this.profiles.get(id));
    }

    if (parts[0] !== 'users' || !parts[1]) {
      this.fail('NOT_FOUND', '회원 API 경로가 없습니다.', 404);
    }
    const userId = parts[1];
    const profile = this.profiles.get(userId);
    const addresses = this.addresses.get(userId);
    this.check(profile && addresses, '회원을 찾을 수 없습니다.', 'NOT_FOUND', 404);

    if (parts.length === 3 && parts[2] === 'notification-preferences') {
        const defaults = { order_updates: true, new_arrivals: true, promotions: false };
        if (method === 'GET') {
          return structuredClone(this.notificationPreferences.get(userId) || defaults);
        }
        if (method === 'PUT') {
          this.check(data && typeof data === 'object' && !Array.isArray(data) &&
            Object.keys(defaults).every(key => typeof data[key] === 'boolean') &&
            Object.keys(data).every(key => Object.hasOwn(defaults, key)),
            '알림 설정 값이 올바르지 않습니다.');
          const updated = { ...defaults, ...data };
          this.notificationPreferences.set(userId, updated);
          return structuredClone(updated);
        }
      }
  
      if (parts.length === 3 && parts[2] === 'profile') {
      if (method === 'GET') return structuredClone(profile);
      if (method === 'PUT') {
        Object.assign(profile, this.profileData(data));
        return structuredClone(profile);
      }
    }

    if (parts[2] === 'addresses') {
      if (parts.length === 3 && method === 'GET') {
        return structuredClone(addresses);
      }
      if (parts.length === 3 && method === 'POST') {
        const row = {
          ...this.addressData(data),
          id: `mock-address-${crypto.randomUUID()}`,
          user_id: userId,
          is_default: addresses.length === 0 || data?.is_default === true
        };
        if (row.is_default) addresses.forEach(a => { a.is_default = false; });
        addresses.push(row);
        return structuredClone(row);
      }

      if (parts.length >= 4) {
        const row = addresses.find(a => a.id === parts[3]);
        this.check(row, '배송지를 찾을 수 없습니다.', 'NOT_FOUND', 404);

        if (parts.length === 4 && method === 'PUT') {
          const validated = this.addressData(data);
          // 기존 기본 배송지를 수정할 때 다른 기본 배송지가 없으면 유지한다.
          const makeDefault = data?.is_default === true || row.is_default;
          if (makeDefault) addresses.forEach(a => { a.is_default = false; });
          Object.assign(row, validated, { is_default: makeDefault });
          return structuredClone(row);
        }
        if (parts.length === 4 && method === 'DELETE') {
          const wasDefault = row.is_default;
          addresses.splice(addresses.indexOf(row), 1);
          if (wasDefault && addresses.length > 0) addresses[0].is_default = true;
          return { deleted: true };
        }
        if (parts.length === 5 && parts[4] === 'default' && method === 'PUT') {
          addresses.forEach(a => { a.is_default = a.id === row.id; });
          return structuredClone(row);
        }
      }
    }
    this.fail('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405);
  }
}

module.exports = { MockAccountService };
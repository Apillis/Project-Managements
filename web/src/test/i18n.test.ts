import { describe, expect, it } from 'vitest';
import { DICT, DICT_KEYS } from '../lib/dict';
import { enumLabel, translate } from '../lib/i18n';
import { collectKeys } from './i18nKeys';

describe('i18n dictionary', () => {
  it('has no duplicate keys', () => {
    const dup = DICT_KEYS.filter((k, i) => DICT_KEYS.indexOf(k) !== i);
    expect(dup).toEqual([]);
  });

  it('defines every key used in the code, in both languages', () => {
    const used = [...collectKeys('src')];
    const missing = used.filter((k) => !DICT.vi[k] || !DICT.en[k]);
    expect(missing).toEqual([]);
  });

  it('has no empty translations', () => {
    const empty = DICT_KEYS.filter((k) => !DICT.vi[k]?.trim() || !DICT.en[k]?.trim());
    expect(empty).toEqual([]);
  });

  it('interpolates variables and falls back to the key', () => {
    expect(translate('en', 'db.hello', { name: 'Truong' })).toBe('Hello Truong');
    expect(translate('vi', 'db.hello', { name: 'Trường' })).toBe('Xin chào Trường');
    expect(translate('vi', 'no.such.key')).toBe('no.such.key');
  });

  it('labels enums and statuses', () => {
    expect(enumLabel('vi', 'status', 'pending_approval')).toBe('Chờ duyệt');
    expect(enumLabel('en', 'docType', 'purchase_order')).toBe('Purchase order');
    expect(enumLabel('en', 'market', 'EU')).toBe('Europe (EU)');
    expect(enumLabel('en', 'market', 'XX')).toBe('XX');
    expect(enumLabel('en', undefined, null)).toBe('');
  });
});

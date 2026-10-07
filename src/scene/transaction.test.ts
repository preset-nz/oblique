import { afterEach, describe, expect, it } from 'vitest';
import {
  beginTransaction,
  cancelTransaction,
  endTransaction,
  hasTransactionBackend,
  setTransactionBackend,
} from './transaction';

afterEach(() => setTransactionBackend(null));

describe('transactions', () => {
  it('are nothing without a backend: the web build and the store tests run as they are', () => {
    expect(hasTransactionBackend()).toBe(false);
    expect(() => {
      beginTransaction();
      cancelTransaction();
      endTransaction();
    }).not.toThrow();
  });

  it('go to the backend in the order they are made, until it is taken away', () => {
    const calls: string[] = [];
    setTransactionBackend({
      begin: () => void calls.push('begin'),
      end: () => void calls.push('end'),
      cancel: () => void calls.push('cancel'),
    });
    expect(hasTransactionBackend()).toBe(true);
    beginTransaction();
    endTransaction();
    beginTransaction();
    cancelTransaction();
    expect(calls).toEqual(['begin', 'end', 'begin', 'cancel']);

    setTransactionBackend(null);
    expect(hasTransactionBackend()).toBe(false);
    beginTransaction();
    expect(calls).toHaveLength(4);
  });
});

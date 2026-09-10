import { describe, expect, it, vi } from 'vitest';
import { createDrawThingsDriver } from './drawthings';

describe('Draw Things driver — health mapping', () => {
  it('no endpoint configured: ok:false, honest detail, no network call', async () => {
    const fetchMock = vi.fn();
    const driver = createDrawThingsDriver(() => '', { fetch: fetchMock });

    const result = await driver.health();

    expect(result).toEqual({ ok: false, detail: 'No endpoint configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2xx response: ok:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const driver = createDrawThingsDriver(() => 'http://127.0.0.1:7860', { fetch: fetchMock });

    const result = await driver.health();

    expect(result).toEqual({ ok: true, detail: 'Connected' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('non-2xx response (404): ok:false with the status in the detail', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const driver = createDrawThingsDriver(() => 'http://127.0.0.1:7860', { fetch: fetchMock });

    const result = await driver.health();

    expect(result).toEqual({ ok: false, detail: 'HTTP 404' });
  });

  it('network error (e.g. closed port): ok:false with the OS error text', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    const driver = createDrawThingsDriver(() => 'http://127.0.0.1:1', { fetch: fetchMock });

    const result = await driver.health();

    expect(result).toEqual({ ok: false, detail: 'connection refused' });
  });

  it('declares no capabilities in this story — inpaint lands in story 3', async () => {
    const driver = createDrawThingsDriver(() => '', { fetch: vi.fn() });
    expect(driver.capabilities.size).toBe(0);
    expect(driver.inpaint).toBeUndefined();
  });
});

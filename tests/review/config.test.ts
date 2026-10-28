import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { Repo } from '../../src/db/repo.js';
import { createReviewer, loadReviewConfig, ReviewConfigError } from '../../src/review/index.js';

describe('loadReviewConfig', () => {
  it('defaults to the mock reviewer with the shop as the only page origin', () => {
    const cfg = loadReviewConfig({}, { shopUrl: 'http://localhost:3001' });
    expect(cfg).toEqual({ provider: 'mock', model: 'claude-opus-5-5', apiKey: undefined, timeoutMs: 8000, pageOrigins: ['http://localhost:3001'] });
  });

  it('refuses anthropic without a key and unknown providers', () => {
    expect(() => loadReviewConfig({ LLM_PROVIDER: 'anthropic' })).toThrow(ReviewConfigError);
    expect(() => loadReviewConfig({ LLM_PROVIDER: 'anthropic' })).toThrow('LLM_API_KEY');
    expect(() => loadReviewConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'x' })).toThrow('must be "mock" or "anthropic"');
    expect(() => loadReviewConfig({ LLM_PROVIDER: 'mock', REVIEW_TIMEOUT_MS: 'soon' })).toThrow('REVIEW_TIMEOUT_MS');
  });

  it('reads the anthropic settings without ever echoing the key', () => {
    const cfg = loadReviewConfig({ LLM_PROVIDER: 'Anthropic', LLM_API_KEY: ' test-key-value-1234 ', LLM_MODEL: 'claude-sonnet-5-5', REVIEW_TIMEOUT_MS: '12000', REVIEW_PAGE_ORIGINS: 'https://shop.example/a, ftp://nope, http://10.0.0.5:8080/x' }, { shopUrl: 'http://localhost:3001' });
    expect(cfg).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', timeoutMs: 12000, pageOrigins: ['http://localhost:3001', 'https://shop.example', 'http://10.0.0.5:8080'] });
    expect(cfg.apiKey).toBe('test-key-value-1234');
    try {
      loadReviewConfig({ LLM_PROVIDER: 'nope', LLM_API_KEY: 'test-key-value-1234' });
    } catch (err) {
      expect(String(err)).not.toContain('test-key-value-1234');
    }
  });

  it('builds the reviewer that matches the config and labels it', () => {
    const repo = new Repo(openDatabase());
    const mock = createReviewer(loadReviewConfig({}), { repo });
    expect(mock).toMatchObject({ mock: true, label: 'mock (deterministic rules, no model)' });
    const real = createReviewer(loadReviewConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'test-key-value-1234' }), { repo });
    expect(real.mock).toBe(false);
    expect(real.label).toContain('claude-opus-5-5');
    expect(real.label).not.toContain('test-key-value-1234');
  });
});

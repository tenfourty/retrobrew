import { expect, test } from '@playwright/test';
import { sampleBody } from '../src/test/feedback-fixtures';
import { feedbackStub } from './helpers';

// The e2e preview mounts the feedback stub (vite.config.ts, scripts/feedback-stub.mjs). Slice 3's sheet tests use it;
// this proves the plumbing on its own: the real build server answers /feedback and the test routes work.
// Not tagged @public: a deployment under test has no stub.
// The stub is one state shared by every worker of the run, so this file's tests run one after another.
test.describe.configure({ mode: 'serial' });

const JSON_HEADERS = { 'content-type': 'application/json' };

test('the e2e preview takes a valid report and shows it to the test unchanged', async ({ request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const body = JSON.stringify(sampleBody());
  const response = await request.post('/feedback', { headers: JSON_HEADERS, data: body });
  expect(response.status()).toBe(202);
  expect(await stub.received()).toEqual([body]);
  await stub.reset();
});

test('the stub refuses a bad report and forces fail and ratelimit on request', async ({ request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const post = (data: string) => request.post('/feedback', { headers: JSON_HEADERS, data });
  expect((await post('{}')).status()).toBe(400);
  await stub.setMode('fail');
  expect((await post(JSON.stringify(sampleBody()))).status()).toBe(500);
  await stub.setMode('ratelimit');
  expect((await post(JSON.stringify(sampleBody()))).status()).toBe(429);
  expect(await stub.received()).toEqual([]);
  await stub.reset();
  expect((await post(JSON.stringify(sampleBody()))).status()).toBe(202);
  await stub.reset();
});

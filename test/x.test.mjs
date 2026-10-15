import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreatePostResponse } from '../server/x.mjs';

test('parses successful CreateTweet responses', () => {
  const body = JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '123456' } } } } });
  assert.deepEqual(parseCreatePostResponse(body), { id: '123456' });
});
test('parses TweetWithVisibilityResults', () => {
  const body = JSON.stringify({ data: { create_tweet: { tweet_results: {
    result: { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: '987654' } },
  } } } });
  assert.deepEqual(parseCreatePostResponse(body), { id: '987654' });
});
test('parses errors and preserves codes', () => {
  assert.deepEqual(parseCreatePostResponse(JSON.stringify({ errors: [
    { message: '重复内容', code: 187 }, { message: '稍后再试', code: 226 },
  ] })), { message: '重复内容；稍后再试', codes: [187, 226] });
});
test('unrecognized bodies are uncertain', () => {
  for (const body of ['not JSON', '{}', 'null', JSON.stringify({ data: { rest_id: '123' } }),
    JSON.stringify({ data: { tweet_results: { rest_id: 'not-an-id' } } })]) {
    assert.equal(parseCreatePostResponse(body), null);
  }
});

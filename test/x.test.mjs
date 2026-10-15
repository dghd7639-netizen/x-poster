import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreatePostResponse, parseCreateScheduledResponse, parseScheduledList, parseScheduledListInOrder, findScheduledTarget, verifyScheduledDeletion, classifyScheduleSelects } from '../server/x.mjs';

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


const range = (start, end) => ['', ...Array.from({ length: end - start + 1 }, (_, i) => String(start + i))];
test('schedule selects are classified by ranges in 24-hour and 12-hour layouts', () => {
  assert.deepEqual(classifyScheduleSelects([range(1, 12), range(1, 31), ['', '2028', '2027', '2026'], range(0, 23), range(0, 59)]),
    ['month', 'day', 'year', 'hour', 'minute']);
  assert.deepEqual(classifyScheduleSelects([range(0, 59), range(1, 12), ['', '2026', '2027'], range(1, 28), range(1, 12), ['', 'AM', 'PM']]),
    ['minute', 'month', 'year', 'day', 'hour12', 'ampm']);
  assert.throws(() => classifyScheduleSelects([['', 'surprise']]), error => error.code === 'UI_CHANGED' && /select/.test(error.details.selector));
});

test('scheduled creation prefers scheduled ids and handles errors or unknown bodies', () => {
  assert.deepEqual(parseCreateScheduledResponse(JSON.stringify({ data: { user: { id: '1' }, create: { rest_id: '22', scheduled_tweet_id: '333' } } })), { id: '333' });
  assert.deepEqual(parseCreateScheduledResponse('{"data":{"create":{"id":"456"}}}'), { id: '456' });
  assert.deepEqual(parseCreateScheduledResponse('{"data":{"create":{"rest_id":789}}}'), { id: '789' });
  assert.deepEqual(parseCreateScheduledResponse('{"errors":[{"message":"拒绝","code":226}]}'), { message: '拒绝', codes: [226] });
  for (const body of [undefined, '', 'not JSON', 'null', '{}', '{"data":{"id":"bad"}}']) {
    assert.equal(parseCreateScheduledResponse(body), null);
  }
});

test('scheduled list walks nested records, seconds/ms, text and media defensively', () => {
  const later = Date.parse('2026-10-17T01:00:00Z');
  const earlier = Date.parse('2026-10-16T01:00:00Z');
  const item = { rest_id: '22', execute_at: earlier / 1000, tweet_create_request: { status: { text: '早上好', media: { media_ids: ['a', 'b'] } } } };
  const body = JSON.stringify({ data: { scheduled: [
    { id: '33', execute_at: String(later), text: '', media_ids: ['c'] }, item, item,
    { id: '44', execute_at: 'bad', text: 'bad' }, { id: '55', execute_at: earlier },
  ] } });
  assert.deepEqual(parseScheduledList(body), [
    { id: '22', scheduled_at: new Date(earlier).toISOString(), text: '早上好', media_count: 2, state: null },
    { id: '33', scheduled_at: new Date(later).toISOString(), text: '', media_count: 1, state: null },
  ]);
  for (const body of [undefined, '', 'not JSON', 'null', '{}', '{"errors":[{"message":"denied"}]}']) {
    assert.deepEqual(parseScheduledList(body), []);
  }
});


test('real FetchScheduledTweets response parses scheduling_info and status', () => {
  const body = '{"data":{"viewer":{"scheduled_tweet_list":[{"rest_id":"1234567890123456789","scheduling_info":{"execute_at":1792458000000,"state":"Scheduled"},"tweet_create_request":{"auto_populate_reply_metadata":false,"exclude_reply_user_ids":[],"media_ids":[],"status":"x-poster 定时功能测试（测试完会删除）","thread_tweets":[],"type":"PostTweetRequest"}}]}}}';
  assert.deepEqual(parseScheduledList(body), [{
    id: '1234567890123456789', scheduled_at: new Date(1792458000000).toISOString(),
    state: 'Scheduled', text: 'x-poster 定时功能测试（测试完会删除）', media_count: 0,
  }]);
});


test('fallback nested execute_at retains response order while public list sorts by time', () => {
  const body = JSON.stringify({ data: { other: [
    { id: '2', metadata: { execute_at: 1792458000000, state: 'Scheduled' }, text: 'later' },
    { rest_id: '1', nested: { execute_at: 1792371600 }, tweet_create_request: { status: 'earlier', media_ids: ['a'] } },
  ] } });
  assert.deepEqual(parseScheduledListInOrder(body).map(entry => entry.id), ['2', '1']);
  assert.deepEqual(parseScheduledList(body).map(entry => entry.id), ['1', '2']);
  assert.equal(parseScheduledListInOrder(body)[0].state, 'Scheduled');
  assert.equal(parseScheduledListInOrder(body)[1].media_count, 1);
});

const cancellationEntries = [
  { id: '2', text: ' later  text ', scheduled_at: '2026-10-20T01:00:00.000Z' },
  { id: '1', text: 'earlier', scheduled_at: '2026-10-19T01:00:00.000Z' },
];
test('cancel target mapping checks id, index, normalized text and duplicate ambiguity', () => {
  assert.equal(findScheduledTarget(cancellationEntries, '1', ['later text', ' earlier ']), 1);
  assert.equal(findScheduledTarget(cancellationEntries, '2', ['later\ntext', 'earlier']), 0);
  assert.throws(() => findScheduledTarget(cancellationEntries, '3'), error => error.code === 'INVALID_INPUT');
  for (const texts of [['earlier', 'later text'], ['later text']]) {
    assert.throws(() => findScheduledTarget(cancellationEntries, '1', texts), error => error.code === 'UI_CHANGED');
  }
  assert.throws(() => findScheduledTarget([...cancellationEntries, { ...cancellationEntries[0], id: '3' }], '2'),
    error => error.code === 'INVALID_INPUT' && /X 网页/.test(error.hint));
  assert.doesNotThrow(() => findScheduledTarget([...cancellationEntries, { ...cancellationEntries[0], id: '3', scheduled_at: '2026-10-21T01:00:00.000Z' }], '2'));
});

test('deletion verification requires target gone and every other original id intact', () => {
  assert.deepEqual(verifyScheduledDeletion(cancellationEntries, [cancellationEntries[1]], '2'), { id: '2', deleted: true, remaining: 1 });
  assert.throws(() => verifyScheduledDeletion(cancellationEntries, cancellationEntries, '2'),
    error => error.code === 'UNCERTAIN' && /删除可能未生效/.test(error.message));
  for (const after of [[], [cancellationEntries[0]]]) {
    assert.throws(() => verifyScheduledDeletion(cancellationEntries, after, '2'), error =>
      error.code === 'UNCERTAIN' && /立即/.test(error.hint) && error.details.missing_ids.includes('1'));
  }
});

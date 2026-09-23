import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, digestHtml, matchedTerms, parseTerms } from './match.ts';

void test('parseTerms splits terms, communities and mutes', () => {
  const c = parseTerms('Yoonet\n# off\n"Clinic Admin"\nr/podiatry\n-r/Bataan\n-u/SpamBot\n\n');
  assert.deepEqual(c.terms, ['Yoonet', 'Clinic Admin']);
  assert.deepEqual(c.communities, ['podiatry']);
  assert.deepEqual([...c.mutedSubs], ['bataan']);
  assert.deepEqual([...c.mutedUsers], ['spambot']);
});

void test('matchedTerms needs the exact phrase, not Reddit stemming', () => {
  const terms = ['Clinic Sites', 'Cliniko'];
  const nursing = { title: 'Slow clinical site advice', body: 'my clinical sites are far', subreddit: 'StudentNurse' };
  assert.deepEqual(matchedTerms(nursing, terms), []);
  const real = { title: 'Anyone use clinic sites?', body: '', subreddit: 'physio' };
  assert.deepEqual(matchedTerms(real, terms), ['Clinic Sites']);
  const partWord = { title: 'Clinikopolis', body: '', subreddit: 'games' };
  assert.deepEqual(matchedTerms(partWord, terms), []);
});

void test('matchedTerms counts a community named after the term', () => {
  const post = { title: 'Why switch?', body: 'thinking about it', subreddit: 'Cliniko' };
  assert.deepEqual(matchedTerms(post, ['Cliniko']), ['Cliniko (community)']);
});

void test('digest caps the list and reports the counts', () => {
  const hit = (i: number) => ({
    id: `t3_${i}`,
    title: `Post [${i}]`,
    subreddit: 'physio',
    author: 'someone',
    url: `https://www.reddit.com/r/physio/comments/${i}/`,
    createdAt: new Date(Date.UTC(2026, 8, 21)),
    comments: 1,
    matched: ['Cliniko'],
    excerpt: 'text',
  });
  const hits = Array.from({ length: 27 }, (_, i) => hit(i));
  const { subject, body } = digest({ hits, searched: 300, droppedLoose: 40, alreadySeen: 2, failed: [] });
  assert.equal(subject, 'Reddit watch: 27 new posts');
  assert.ok(body.includes('**[Post 0](https://www.reddit.com/r/physio/comments/0/)**'));
  assert.ok(body.includes('21/09 · 1 comment ·'));
  assert.ok(body.includes('…and 2 more, which will come in the next digest.'));
  assert.ok(body.includes('Searched 300 posts, dropped 40 loose matches, skipped 2 already sent.'));
  assert.ok(!body.includes('Post 26'));
});

void test('digestHtml escapes Reddit text', () => {
  const html = digestHtml({
    hits: [{
      id: 't3_x',
      title: '<script>alert(1)</script> & "quotes"',
      subreddit: 'physio',
      author: 'a<b',
      url: 'https://www.reddit.com/r/physio/comments/x/?a=1&b=2',
      createdAt: new Date(Date.UTC(2026, 8, 21)),
      comments: 0,
      matched: ['Cliniko'],
      excerpt: '<img src=x onerror=alert(1)>',
    }],
    searched: 1,
    droppedLoose: 0,
    alreadySeen: 0,
    failed: [],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
  assert.ok(html.includes('href="https://www.reddit.com/r/physio/comments/x/?a=1&amp;b=2"'));
  assert.ok(html.includes('u/a&lt;b'));
});

void test('digest says which terms Reddit refused to search', () => {
  const base = { hits: [], searched: 10, droppedLoose: 0, alreadySeen: 0 };
  const one = digest({ ...base, failed: ['Cliniko'] }).body;
  assert.ok(one.includes('Reddit would not search Cliniko this time, so it is tried again tomorrow.'));
  const two = digestHtml({ ...base, failed: ['Yoonet', 'r/podiatry'] });
  assert.ok(two.includes('Reddit would not search Yoonet, r/podiatry this time, so they are tried again tomorrow.'));
  assert.ok(!digest({ ...base, failed: [] }).body.includes('would not search'));
});

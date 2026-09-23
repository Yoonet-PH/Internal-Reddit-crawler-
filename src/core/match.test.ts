import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, matchedTerms, parseTerms, slackText } from './match.ts';

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

void test('slackText links titles and escapes Reddit text', () => {
  const text = slackText({
    hits: [{
      id: 't3_x',
      title: 'Cliniko <or> Nookal & which?',
      subreddit: 'physio',
      author: 'someone',
      url: 'https://www.reddit.com/r/physio/comments/x/',
      createdAt: new Date(Date.UTC(2026, 8, 24)),
      comments: 3,
      matched: ['Cliniko'],
      excerpt: 'a > b',
    }],
    searched: 42,
    droppedLoose: 35,
    alreadySeen: 0,
    failed: ['Yoonet'],
  });
  assert.ok(text.startsWith('*1 new Reddit post for your watch terms*'));
  assert.ok(text.includes('<https://www.reddit.com/r/physio/comments/x/|Cliniko &lt;or&gt; Nookal &amp; which?>'));
  assert.ok(text.includes('r/physio · u/someone · 24/09 · 3 comments · matched Cliniko'));
  assert.ok(text.includes('> a &gt; b'));
  assert.ok(text.includes('Reddit would not search Yoonet this time, so it is tried again tomorrow.'));
  assert.ok(text.endsWith('_Searched 42 posts, dropped 35 loose matches, skipped 0 already sent._'));
});

void test('digest says which terms Reddit refused to search', () => {
  const base = { hits: [], searched: 10, droppedLoose: 0, alreadySeen: 0 };
  const one = digest({ ...base, failed: ['Cliniko'] }).body;
  assert.ok(one.includes('Reddit would not search Cliniko this time, so it is tried again tomorrow.'));
  const two = slackText({ ...base, failed: ['Yoonet', 'r/podiatry'] });
  assert.ok(two.includes('Reddit would not search Yoonet, r/podiatry this time, so they are tried again tomorrow.'));
  assert.ok(!digest({ ...base, failed: [] }).body.includes('would not search'));
});

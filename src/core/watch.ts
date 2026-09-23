import type { Post } from '@devvit/web/server';
import { reddit, redis, settings } from '@devvit/web/server';
import type { Hit, WatchConfig, WatchResult } from './match';
import { matchedTerms, parseTerms } from './match';

const DEFAULT_TERMS = 'Yoonet\nClinic Admin\nClinic Sites\nCliniko';
const SEARCH_LIMIT = 250; // per term, Reddit pages 100 at a time
const WINDOW_DAYS = 7;
const SEEN_DAYS = 30; // Devvit rules ask for stored data to expire within 30 days
const EXCERPT = 240;

function toHit(post: Post, matched: string[]): Hit {
  const body = (post.body ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: post.id,
    title: post.title,
    subreddit: post.subredditName,
    author: post.authorName,
    url: `https://www.reddit.com${post.permalink}`,
    createdAt: post.createdAt,
    comments: post.numberOfComments,
    matched,
    excerpt: body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body,
  };
}

const RETRY_DELAYS_MS = [2_000, 8_000];

/** Reddit's search sometimes refuses a request outright ("14 UNAVAILABLE: Stream
 * refused by server", seen 23/09). Retry twice, then give up on this term only;
 * the week long window means tomorrow's run picks up what today's missed. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error(`${label} failed after ${attempt + 1} tries: ${String(err)}`);
        return undefined;
      }
      console.warn(`${label} failed, retrying in ${delay / 1000}s: ${String(err)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function loadConfig(): Promise<WatchConfig> {
  const raw = (await settings.get<string>('terms')) ?? DEFAULT_TERMS;
  return parseTerms(raw);
}

/** Search Reddit for every term and community, keep exact matches from the last
 * week that have not been sent before. Nothing is written; see rememberSent. */
export async function runWatch(config: WatchConfig): Promise<WatchResult> {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const candidates = new Map<string, { post: Post; community?: string }>();
  const failed: string[] = [];
  let searched = 0;

  for (const term of config.terms) {
    const posts = await withRetry(`search "${term}"`, () =>
      reddit
        .searchPosts({
          query: `"${term}"`,
          sort: 'new',
          timeframe: 'week',
          limit: SEARCH_LIMIT,
          pageSize: 100,
        })
        .all()
    );
    if (!posts) {
      failed.push(term);
      continue;
    }
    searched += posts.length;
    console.log(`search "${term}": ${posts.length} posts`);
    for (const post of posts) candidates.set(post.id, { post });
  }

  for (const name of config.communities) {
    const posts = await withRetry(`community r/${name}`, () =>
      reddit.getNewPosts({ subredditName: name, limit: 100, pageSize: 100 }).all()
    );
    if (!posts) {
      failed.push(`r/${name}`);
      continue;
    }
    searched += posts.length;
    console.log(`community r/${name}: ${posts.length} posts`);
    for (const post of posts) {
      const existing = candidates.get(post.id);
      candidates.set(post.id, { post, community: `r/${name}`, ...existing });
    }
  }

  const hits: Hit[] = [];
  let droppedLoose = 0;
  let alreadySeen = 0;
  for (const { post, community } of candidates.values()) {
    if (post.createdAt.getTime() < since) continue;
    if (config.mutedSubs.has(post.subredditName.toLowerCase())) continue;
    if (config.mutedUsers.has(post.authorName.toLowerCase())) continue;
    const matched = matchedTerms(
      { title: post.title, body: post.body ?? '', subreddit: post.subredditName },
      config.terms
    );
    if (community) matched.push(community);
    if (!matched.length) {
      droppedLoose++;
      continue;
    }
    if (await redis.exists(`seen:${post.id}`)) {
      alreadySeen++;
      continue;
    }
    hits.push(toHit(post, matched));
  }

  hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { hits, searched, droppedLoose, alreadySeen, failed };
}

/** Called only after a send succeeds, so a failed send is retried next run. */
export async function rememberSent(hits: Hit[]): Promise<void> {
  const expiration = new Date(Date.now() + SEEN_DAYS * 86_400_000);
  for (const hit of hits) {
    await redis.set(`seen:${hit.id}`, '1', { expiration });
  }
}

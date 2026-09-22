import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnAppUpgradeRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { dryRun } from '../core/send';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('installed to r/' + input.subreddit?.name);
  await dryRun();
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-app-upgrade', async (c) => {
  const input = await c.req.json<OnAppUpgradeRequest>();
  console.log('upgraded in r/' + input.subreddit?.name);
  await dryRun();
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

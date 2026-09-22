import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { scanAndSend } from '../core/send';

export const scheduler = new Hono();

// 18:00 UTC, which is 7am New Zealand time once daylight saving starts on 27/09.
scheduler.post('/daily-scan', async (c) => {
  await c.req.json<TaskRequest>();
  await scanAndSend();
  return c.json<TaskResponse>({}, 200);
});

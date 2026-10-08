import { createHandler } from '../factory-sync/server.mjs';

Deno.serve(createHandler({ operation: 'leaderboard' }));

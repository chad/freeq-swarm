// SPEND command emitter. PLAN §5.8.
import type { FreeqClient } from '@freeq/sdk';

export function emitSpend(args: {
  client: FreeqClient;
  channel: string;
  amount: number;
  unit?: 'usd';
  taskId: string;
}): void {
  const unit = args.unit ?? 'usd';
  args.client.raw(
    `SPEND ${args.channel} :amount=${args.amount.toFixed(6)};unit=${unit};task=${args.taskId}`,
  );
}

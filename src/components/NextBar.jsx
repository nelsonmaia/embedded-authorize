/**
 * `next[]` as what it is: the only calls the server will now accept.
 *
 * Sits between a response and the following request, because that is where it acts — the client
 * does not choose what comes next, the server names the options and refuses the rest.
 */
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const short = (a) => a.replace(/^action:/, '').replace(/:v1$/, '');

export function NextBar({ next, onPick, onOutOfOrder, allowOutOfOrder }) {
  if (!next?.length) return null;

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowRight className="h-3.5 w-3.5" />
        The server will now accept only these
      </div>
      <div className="flex flex-wrap gap-2">
        {next.map((entry, i) => {
          const meta = Object.entries(entry).filter(([k]) => k !== 'action');
          return (
            <Button
              key={i}
              variant="outline"
              size="sm"
              className="h-auto flex-col items-start gap-0.5 py-2 font-mono"
              onClick={() => onPick(entry)}
            >
              <span className="text-xs font-semibold">{short(entry.action)}</span>
              {meta.length > 0 && (
                <span className="text-[10px] font-normal text-muted-foreground">
                  {meta
                    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join('  ·  ')}
                </span>
              )}
            </Button>
          );
        })}
      </div>
      {allowOutOfOrder && (
        <button
          className={cn('mt-2.5 text-xs text-muted-foreground underline-offset-4 hover:underline')}
          onClick={onOutOfOrder}
        >
          Try one that isn’t offered
        </button>
      )}
    </div>
  );
}

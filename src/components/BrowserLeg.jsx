/**
 * The part of the flow that is not HTTP.
 *
 * Between the response that hands back an `href` and the call that resumes, the user leaves the
 * app entirely: a browser opens, something happens at the identity provider or on a hosted page,
 * and a deep link brings them back. None of it is a request the client makes, so none of it
 * appears in a transcript of requests — which leaves an href followed by a resume that succeeds
 * for no visible reason.
 *
 * This is the missing step, drawn as a step. It is deliberately not styled as an exchange card:
 * nothing here is a call you can make, edit, or replay.
 */
import { ArrowDown, Check, ExternalLink, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * `outcome` comes from the NEXT call, not this one — the response that opens a leg cannot know how
 * it went. Until that call is made the leg is still open, and nothing here claims a result.
 */
export function BrowserLeg({ handoff, outcome }) {
  if (!handoff) return null;
  const completed = outcome?.state === 'completed';

  return (
    <div className="relative ml-4 border-l-2 border-dashed border-muted-foreground/30 pl-6">
      <span className="absolute -left-[9px] top-4 grid h-4 w-4 place-items-center rounded-full border-2 border-dashed border-muted-foreground/30 bg-background" />

      <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          <ExternalLink className="h-3.5 w-3.5" />
          {handoff.title}
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          Your app opens <span className="font-medium text-foreground">{handoff.opens}</span>. None
          of what follows is a call your client makes.
        </p>

        <ol className="mt-2.5 space-y-1.5">
          {handoff.steps.map((step, i) => (
            <li key={i} className="flex gap-2.5 text-xs leading-relaxed text-muted-foreground">
              <span className="mt-px shrink-0 font-mono text-[10px] text-muted-foreground/60">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {outcome ? (
          <div
            className={cn(
              'mt-2.5 flex gap-2.5 rounded-md px-2.5 py-2 text-xs leading-relaxed',
              completed
                ? 'bg-[hsl(var(--ok))]/10 text-foreground'
                : 'bg-[hsl(var(--warn))]/10 text-foreground'
            )}
          >
            {completed ? (
              <Check className="mt-px h-3.5 w-3.5 shrink-0 text-[hsl(var(--ok))]" />
            ) : (
              <Undo2 className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span>
              <span className="font-medium">
                {completed ? 'Completed. ' : 'Did not complete. '}
              </span>
              {outcome.detail}
            </span>
          </div>
        ) : (
          <p className="mt-2.5 rounded-md bg-muted/40 px-2.5 py-2 text-xs italic leading-relaxed text-muted-foreground">
            Still open. How it went is only known once you resume — send the next call to find out.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-dashed pt-2.5 text-xs">
          <ArrowDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {outcome && !completed ? (
            <span className="text-muted-foreground">
              No deep link fired — the browser simply closed. The app resumes on{' '}
            </span>
          ) : (
            <>
              <span className="text-muted-foreground">Back to the app on</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {handoff.callback}
              </code>
              <span className="text-muted-foreground">
                — carrying no token and no code. Everything is already server-side; resume with{' '}
              </span>
            </>
          )}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {handoff.resume}
          </code>
          <span className="text-muted-foreground">
            {outcome && !completed ? 'and the server hands back a fresh reference.' : 'to collect the result.'}
          </span>
        </div>
      </div>
    </div>
  );
}

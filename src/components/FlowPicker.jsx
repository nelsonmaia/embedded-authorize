/**
 * Pick a flow. A row of filter chips narrows one dropdown, grouped into sign up and sign in; a
 * second dropdown appears only when the chosen flow has more than one variant. Everything is
 * named after what it does, not where it came from.
 *
 * The chips filter rather than navigate: picking one never leaves you looking at a flow that is
 * no longer in the list, so selecting a chip that excludes the current flow moves you to the
 * first one that matches.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { ALL_FLOWS, FLOW_FILTERS, FLOW_GROUPS, matchesFilter, facetsFor } from '@/data/flows.js';

/** One chip. `tone` picks the row: the category row leads, the facet row reads as a refinement. */
function Chip({ label, count, active, tone = 'primary', onClick }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        tone === 'primary' ? 'px-3 py-1' : 'px-2.5 py-0.5',
        active
          ? tone === 'primary'
            ? 'border-transparent bg-primary text-primary-foreground'
            : 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {label}
      {count != null && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

export function FlowPicker({ flowId, variantId, onFlowChange, onVariantChange, flow }) {
  const [filter, setFilter] = useState('all');
  const [facet, setFacet] = useState(null);
  const variants = flow?.variants?.filter((v) => v.label) ?? [];

  const inCategory = useMemo(() => ALL_FLOWS.filter((f) => matchesFilter(f, filter)), [filter]);
  const facets = useMemo(() => facetsFor(filter, inCategory), [filter, inCategory]);

  // A facet from the previous category means nothing in this one.
  useEffect(() => setFacet(null), [filter]);

  const visible = useMemo(
    () => (facet && facets ? inCategory.filter((f) => facets.of(f) === facet) : inCategory),
    [inCategory, facet, facets]
  );

  // Grouped by what a flow IS rather than by which array it came from, so a simulated signup sits
  // under Sign up alongside the recorded ones. Empty headings are dropped.
  const groups = useMemo(
    () =>
      FLOW_GROUPS.map((name) => ({ name, items: visible.filter((f) => f.group === name) })).filter(
        (g) => g.items.length
      ),
    [visible]
  );

  // A chip that excludes the current flow would otherwise leave the trigger showing a flow the
  // list no longer offers. Move to the first match instead.
  useEffect(() => {
    if (visible.length && !visible.some((f) => f.id === flowId)) onFlowChange(visible[0].id);
  }, [visible, flowId, onFlowChange]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FLOW_FILTERS.map((f) => [f.id, ALL_FLOWS.filter((x) => matchesFilter(x, f.id)).length])
      ),
    []
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {FLOW_FILTERS.map((f) => (
          <Chip
            key={f.id}
            label={f.label}
            count={counts[f.id]}
            active={filter === f.id}
            onClick={() => setFilter(f.id)}
          />
        ))}
      </div>

      {/* Only where the chip above raises a follow-up worth asking. facetsFor() returns null for
          Sign in and All, where any single axis would mean something different per flow. */}
      {facets && (
        <div className="flex flex-wrap items-center gap-1.5 pl-0.5">
          <span className="pr-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {facets.label}
          </span>
          <Chip label="Any" active={facet === null} tone="facet" onClick={() => setFacet(null)} />
          {facets.items.map((f) => (
            <Chip
              key={f.label}
              label={f.label}
              count={f.count}
              active={facet === f.label}
              tone="facet"
              onClick={() => setFacet(f.label)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1 space-y-1.5">
          <Label className="text-xs text-muted-foreground">Flow</Label>
          <Select value={flowId} onValueChange={onFlowChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectGroup key={g.name}>
                  <SelectLabel>{g.name}</SelectLabel>
                  {g.items.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        {variants.length > 0 && (
          <div className="min-w-[280px] flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Variant</Label>
            <Select value={variantId} onValueChange={onVariantChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {variants.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label} · {v.calls} calls
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pick a flow. One dropdown, grouped into sign up and sign in; a second only when the chosen flow
 * has more than one variant. Everything is named after what it does, not where it came from.
 */
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
import { SIGNUP_FLOWS, LOGIN_FLOWS } from '@/data/flows.js';

export function FlowPicker({ flowId, variantId, onFlowChange, onVariantChange, flow }) {
  const variants = flow?.variants?.filter((v) => v.label) ?? [];

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[280px] flex-1 space-y-1.5">
        <Label className="text-xs text-muted-foreground">Flow</Label>
        <Select value={flowId} onValueChange={onFlowChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Sign up</SelectLabel>
              {SIGNUP_FLOWS.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Sign in</SelectLabel>
              {LOGIN_FLOWS.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectGroup>
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
  );
}

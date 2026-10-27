"use client";

import { useState } from "react";
import type { MealProposal } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// A7 extends this entry point with portion/item editing and live nutrition previews.
export function ProposalDetailsDialog({
  proposal,
  onChange,
  onClose,
}: {
  proposal: MealProposal;
  onChange: (proposal: MealProposal) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const date = new Date(proposal.consumed_at);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="[&_[data-slot=dialog-close]]:min-h-11 [&_[data-slot=dialog-close]]:min-w-11">
        <DialogTitle>Edit meal details</DialogTitle>
        <DialogDescription>
          Update the name and time before saving. Date and time use this
          device’s time zone.
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const name = String(data.get("name")).trim();
            const consumed = new Date(String(data.get("consumed_at")));
            if (!name || !Number.isFinite(consumed.getTime())) {
              setError("Enter a meal name and valid date.");
              return;
            }
            onChange({
              ...proposal,
              name,
              consumed_at: consumed.toISOString(),
            });
            onClose();
          }}
        >
          <label className="block space-y-2">
            <span className="text-sm">Meal name</span>
            <Input
              name="name"
              required
              maxLength={200}
              defaultValue={proposal.name}
              className="min-h-11"
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm">Consumed at</span>
            <Input
              name="consumed_at"
              type="datetime-local"
              required
              defaultValue={localDate}
              className="min-h-11"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Nutrition stays the same when you change these details.
          </p>
          <Button type="submit" className="min-h-11 w-full">
            Apply changes
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
